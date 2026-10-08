"""Nu AI chat: threads + SSE streaming messages (Section 9.2)."""
from __future__ import annotations

import json
import os
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from nuwrrrld import DISCLAIMER, db
from nuwrrrld.api import budget, ratelimit, spawn
from nuwrrrld.api.deps import require_entitlement
from nuwrrrld.llm import prompts, validate
from nuwrrrld.llm.chat_tools import stream_with_tools

router = APIRouter(prefix="/chat", tags=["chat"])
RECENT_TURNS = 8
SUMMARY_EVERY_N_TURNS = 20
PREAMBLE_TOP_HOLDINGS = 15
MAX_OUTPUT_TOKENS = 700
BREAKER_OUTPUT_TOKENS = 300
CHARS_PER_TOKEN = 4


class MessageIn(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    client_msg_id: str = Field(min_length=8, max_length=64)


class ThreadIn(BaseModel):
    title: str | None = Field(default=None, max_length=120)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


@router.get("/threads")
async def list_threads(user: dict = Depends(require_entitlement)):
    rows = await db.pool().fetch("SELECT id, title, updated_at FROM chat_threads WHERE user_id=$1 AND archived_at IS NULL "
                                 "ORDER BY updated_at DESC LIMIT 100", user["id"])
    return {"threads": [{**dict(r), "id": str(r["id"])} for r in rows]}


@router.post("/threads", status_code=201)
async def create_thread(body: ThreadIn, user: dict = Depends(require_entitlement)):
    row = await db.pool().fetchrow("INSERT INTO chat_threads (user_id, title) VALUES ($1,$2) RETURNING id", user["id"], body.title)
    return {"id": str(row["id"])}


async def _own_thread(thread_id: UUID, user: dict):
    row = await db.pool().fetchrow("SELECT * FROM chat_threads WHERE id=$1 AND user_id=$2", thread_id, user["id"])
    if row is None:
        raise HTTPException(404, detail={"code": "not_found"})
    return row


@router.get("/threads/{thread_id}")
async def get_thread(thread_id: UUID, user: dict = Depends(require_entitlement)):
    t = await _own_thread(thread_id, user)
    rows = await db.pool().fetch("SELECT id, role, content, context_refs, status, created_at FROM chat_messages "
                                 "WHERE thread_id=$1 AND role IN ('user','assistant') ORDER BY created_at", thread_id)
    return {"id": str(t["id"]), "title": t["title"], "messages": [{**dict(r), "id": str(r["id"])} for r in rows], "disclaimer": DISCLAIMER}


@router.delete("/threads/{thread_id}", status_code=204)
async def delete_thread(thread_id: UUID, user: dict = Depends(require_entitlement)):
    await db.pool().execute("DELETE FROM chat_threads WHERE id=$1 AND user_id=$2", thread_id, user["id"])


async def _preamble(user_id) -> str:
    """Compact portfolio preamble: top holdings by weight plus sector totals (<= ~1.5k tokens)."""
    rows = await db.pool().fetch(
        """SELECT h.ticker, h.quantity::float AS q, i.sector,
                  (SELECT adj_close::float FROM price_bars b WHERE b.ticker=h.ticker ORDER BY bar_date DESC LIMIT 1) AS px
             FROM holdings h JOIN instruments i ON i.ticker=h.ticker WHERE h.user_id=$1""", user_id)
    vals = sorted(((r["ticker"], abs(r["q"]) * (r["px"] or 0), r["sector"] or "unmapped") for r in rows), key=lambda x: -x[1])
    total = sum(v for _, v, _ in vals) or 1.0
    sectors: dict[str, float] = {}
    for _, v, s in vals:
        sectors[s] = sectors.get(s, 0) + v / total
    top = ", ".join(f"{t} {v / total:.1%}" for t, v, _ in vals[:PREAMBLE_TOP_HOLDINGS])
    head = await db.pool().fetchval("SELECT max(as_of_date) FROM signal_runs WHERE status='published'")
    return (f"[portfolio top holdings by weight: {top or 'none'}] [sector totals: "
            f"{', '.join(f'{k} {v:.1%}' for k, v in sorted(sectors.items(), key=lambda x: -x[1])) or 'none'}] [latest digest: {head}]")


@router.post("/threads/{thread_id}/messages")
async def post_message(thread_id: UUID, body: MessageIn, user: dict = Depends(require_entitlement)):
    thread = await _own_thread(thread_id, user)
    await ratelimit.hit("chat", str(user["id"]))
    breaker = spawn.llm_breaker_open()                       # breaker: fast model, shorter outputs
    pool = db.pool()
    inserted = await pool.fetchrow(
        """INSERT INTO chat_messages (thread_id, user_id, role, content, client_msg_id) VALUES ($1,$2,'user',$3,$4)
           ON CONFLICT (thread_id, client_msg_id) WHERE client_msg_id IS NOT NULL DO NOTHING RETURNING id""",
        thread_id, user["id"], body.content, body.client_msg_id)
    if inserted is None:                                      # a resend is a no-op: replay the stored reply
        reply = await pool.fetchrow(
            """SELECT content, status, context_refs FROM chat_messages WHERE thread_id=$1 AND role='assistant' AND created_at >
               (SELECT created_at FROM chat_messages WHERE thread_id=$1 AND client_msg_id=$2) ORDER BY created_at LIMIT 1""",
            thread_id, body.client_msg_id)

        async def replay():
            yield sse("done", {"content": reply["content"] if reply else "", "replayed": True, "status": reply["status"] if reply else "pending"})
        return StreamingResponse(replay(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})

    model_tier = "fast" if breaker else "smart"
    system, version = prompts.load("chat")
    recent = await pool.fetch("SELECT role, content FROM (SELECT role, content, created_at FROM chat_messages WHERE thread_id=$1 "
                              "AND role IN ('user','assistant') AND status='complete' ORDER BY created_at DESC LIMIT $2) t ORDER BY created_at",
                              thread_id, RECENT_TURNS * 2)
    preamble = await _preamble(user["id"])
    messages = [{"role": "system", "content": system + "\n" + preamble + (f"\n[earlier summary: {thread['summary']}]" if thread["summary"] else "")},
                *[{"role": r["role"], "content": r["content"]} for r in recent if r["content"] != body.content],
                {"role": "user", "content": f"<user_message>\n{body.content}\n</user_message>"}]
    max_out = BREAKER_OUTPUT_TOKENS if breaker else MAX_OUTPUT_TOKENS
    est = sum(len(m["content"] or "") for m in messages) // CHARS_PER_TOKEN + max_out
    await budget.reserve(user["id"], est)
    assistant = await pool.fetchrow("INSERT INTO chat_messages (thread_id, user_id, role, content, status) VALUES ($1,$2,'assistant','','streaming') RETURNING id",
                                    thread_id, user["id"])
    model = os.environ["LLM_MODEL_FAST" if breaker else "LLM_MODEL_SMART"]

    async def gen():
        final, usage = None, {}
        try:
            async for ev in stream_with_tools(messages, model=model, user_id=user["id"], max_tokens=max_out):
                if ev["type"] == "token":
                    yield sse("token", {"text": ev["text"]})
                elif ev["type"] == "tool":
                    yield sse("tool", {"name": ev["name"]})
                elif ev["type"] == "citation":
                    yield sse("citation", {"refs": ev["refs"]})
                elif ev["type"] == "usage":
                    usage = ev
                elif ev["type"] == "final":
                    final = ev
            text = validate.directive_filter(final["text"] if final else "")
            tin, tout = usage.get("prompt_tokens", est - max_out), usage.get("completion_tokens", len(text) // CHARS_PER_TOKEN)
            await pool.execute(
                """UPDATE chat_messages SET content=$2, tool_calls=$3, context_refs=$4, status='complete', model=$5,
                          input_tokens=$6, output_tokens=$7 WHERE id=$1""",
                assistant["id"], text, (final or {}).get("tool_calls", []), (final or {}).get("refs", []), model, tin, tout)
            await pool.execute("UPDATE chat_threads SET updated_at=now(), title=COALESCE(title,$2) WHERE id=$1", thread_id, body.content[:60])
            await pool.execute("INSERT INTO llm_usage (user_id, feature, ref_id, provider, model, input_tokens, output_tokens) "
                               "VALUES ($1,'chat',$2,$3,$4,$5,$6)", user["id"], str(assistant["id"]),
                               os.environ.get("LLM_PROVIDER", "openrouter"), model, tin, tout)
            await budget.reconcile(user["id"], est, tin + tout)
            turns = await pool.fetchval("SELECT count(*) FROM chat_messages WHERE thread_id=$1 AND role='user'", thread_id)
            if turns and turns % SUMMARY_EVERY_N_TURNS == 0:
                try:
                    await spawn.spawn("summarize_thread", str(thread_id))
                except HTTPException:
                    pass
            yield sse("done", {"content": text, "message_id": str(assistant["id"]), "disclaimer": DISCLAIMER})
        except Exception as exc:
            await pool.execute("UPDATE chat_messages SET status='error' WHERE id=$1", assistant["id"])
            await budget.reconcile(user["id"], est, 0)
            yield sse("error", {"code": "stream_failed", "detail": type(exc).__name__})

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
