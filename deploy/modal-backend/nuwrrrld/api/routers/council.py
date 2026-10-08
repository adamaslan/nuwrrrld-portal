"""AI Council: seats, sessions, live stream, paper portfolios (Sections 10, 11)."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import uuid
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from nuwrrrld import DISCLAIMER, PAPER_DISCLAIMER, db
from nuwrrrld.api import pagination, ratelimit, spawn
from nuwrrrld.api.deps import require_entitlement
from nuwrrrld.calendar import ET, today_et
from nuwrrrld.core.council.tally import CouncilConfig
from nuwrrrld.core.paper import stats
from nuwrrrld.jobs import council as council_jobs

router = APIRouter(prefix="/council", tags=["council"])
POLL_SECONDS = 1.5
QUEUE_TIMEOUT_SECONDS = 25
FINISHED = ("consensus", "no_consensus", "failed", "canceled")


class ConveneIn(BaseModel):
    ticker: str = Field(pattern=r"^[A-Za-z.\-]{1,8}$")


def _public(r) -> dict:
    return {k: (str(v) if isinstance(v, (uuid.UUID, dt.datetime, dt.date)) else (float(v) if hasattr(v, "as_tuple") else v)) for k, v in dict(r).items()}


@router.get("/members")
async def members(user: dict = Depends(require_entitlement)):
    rows = await db.pool().fetch("SELECT slug, display_name, role, strategy_key, vote_weight FROM council_members WHERE active ORDER BY slug")
    return {"members": [_public(r) for r in rows],
            "note": "Strategy labels are placeholders until real strategies are registered.", "disclaimer": DISCLAIMER}


@router.post("/sessions", status_code=202)
async def convene(body: ConveneIn, idempotency_key: str | None = Header(default=None), user: dict = Depends(require_entitlement)):
    spawn.require_llm()
    await ratelimit.hit("council_convene", str(user["id"]))
    ticker = body.ticker.upper().replace(".", "-")
    p = db.pool()
    if not await p.fetchval("SELECT 1 FROM instruments WHERE ticker=$1 AND active", ticker):
        raise HTTPException(422, detail={"code": "unknown_ticker"})
    as_of = await p.fetchval("SELECT max(as_of_date) FROM signal_runs WHERE status='published'")
    if as_of is None:
        raise HTTPException(409, detail={"code": "no_data", "detail": "No published digest yet"})
    reuse = await p.fetchrow("SELECT id, status FROM council_sessions WHERE subject_ticker=$1 AND as_of_date=$2 "
                             "AND status IN ('queued','running','consensus','no_consensus') ORDER BY created_at LIMIT 1", ticker, as_of)
    if reuse:                                                   # reuse saves LLM spend
        return {"session_id": str(reuse["id"]), "status": reuse["status"], "reused": True}
    cfg = council_jobs.load_yaml()
    cc = CouncilConfig.from_dict(cfg["council"])
    start_of_day = dt.datetime.combine(today_et(), dt.time(0), tzinfo=ET)
    used = await p.fetchval("SELECT count(*) FROM council_sessions WHERE requested_by=$1 AND cadence='on_demand' AND created_at >= $2",
                            user["id"], start_of_day)
    if used >= cc.on_demand_daily_limit_per_user:
        raise HTTPException(429, detail={"code": "daily_limit", "detail": f"limit {cc.on_demand_daily_limit_per_user} per day"})
    key = f"user:{user['id']}:{idempotency_key or uuid.uuid4().hex}"
    snapshot = {"council": cfg["council"], "seats": {s["slug"]: council_jobs.config_version(s) for s in cfg["seats"]}}
    try:
        row = await p.fetchrow(
            """INSERT INTO council_sessions (cadence, as_of_date, subject_ticker, requested_by, trades_portfolios, status, max_rounds,
                                             config_snapshot, idempotency_key, token_budget)
               VALUES ('on_demand',$1,$2,$3,false,'queued',$4,$5,$6,$7) RETURNING id""",
            as_of, ticker, user["id"], cc.max_rounds, snapshot, key, cc.token_budget_per_session)
        created = True
    except asyncpg.UniqueViolationError:                         # same Idempotency-Key: return the original
        row, created = await p.fetchrow("SELECT id FROM council_sessions WHERE idempotency_key=$1", key), False
    if created:
        call_id = await spawn.spawn("run_council_session", str(row["id"]))
        await p.execute("UPDATE council_sessions SET modal_call_id=$2 WHERE id=$1", row["id"], call_id)
    return {"session_id": str(row["id"]), "status": "queued"}


@router.get("/sessions")
async def sessions(date: dt.date | None = None, cadence: str | None = Query(None, pattern="^(daily|weekly|on_demand)$"),
                   mine: bool = False, cursor: str | None = None, limit: int = Query(25), user: dict = Depends(require_entitlement)):
    limit, cur = pagination.clamp(limit), pagination.decode(cursor)
    rows = await db.pool().fetch(
        """SELECT s.id, s.cadence, s.as_of_date, s.subject_ticker, s.status, s.rounds_run, s.created_at, c.outcome, c.direction
             FROM council_sessions s LEFT JOIN council_consensus c ON c.session_id=s.id
            WHERE ($1::date IS NULL OR s.as_of_date=$1) AND ($2::text IS NULL OR s.cadence=$2)
              AND (CASE WHEN $3 THEN s.requested_by=$4 ELSE (s.requested_by IS NULL OR s.requested_by=$4) END)
              AND ($5::timestamptz IS NULL OR (s.created_at, s.id::text) < ($5, $6))
            ORDER BY s.created_at DESC, s.id DESC LIMIT $7""",
        date, cadence, mine, user["id"], cur[0] if cur else None, cur[1] if cur else None, limit + 1)
    page = rows[:limit]
    return {"sessions": [_public(r) for r in page], "disclaimer": DISCLAIMER,
            "next_cursor": pagination.encode(page[-1]["created_at"], page[-1]["id"]) if len(rows) > limit else None}


async def _visible(session_id: UUID, user: dict):
    s = await db.pool().fetchrow("SELECT * FROM council_sessions WHERE id=$1", session_id)
    if s is None or (s["requested_by"] is not None and s["requested_by"] != user["id"]):   # scheduled = public; on-demand = owner
        raise HTTPException(404, detail={"code": "not_found"})
    return s


@router.get("/sessions/{session_id}")
async def session_detail(session_id: UUID, user: dict = Depends(require_entitlement)):
    s = await _visible(session_id, user)
    p = db.pool()
    msgs = await p.fetch("SELECT m.seq, m.round, m.kind, m.content_md, m.structured, cm.slug, cm.display_name FROM council_messages m "
                         "LEFT JOIN council_members cm ON cm.id=m.member_id WHERE m.session_id=$1 ORDER BY m.seq", session_id)
    votes = await p.fetch("SELECT v.round, cm.slug, cm.role, v.direction, v.conviction, v.invalidation_price, v.counted, v.coerced "
                          "FROM council_votes v JOIN council_members cm ON cm.id=v.member_id WHERE v.session_id=$1 ORDER BY v.round, cm.slug", session_id)
    cons = await p.fetchrow("SELECT * FROM council_consensus WHERE session_id=$1", session_id)
    return {"session": _public(s) | {"context_snapshot": None, "config_snapshot": None}, "messages": [_public(m) for m in msgs],
            "votes": [_public(v) for v in votes], "consensus": _public(cons) if cons else None, "disclaimer": DISCLAIMER}


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"


@router.get("/sessions/{session_id}/stream")
async def stream(session_id: UUID, user: dict = Depends(require_entitlement)):
    s = await _visible(session_id, user)
    own_on_demand = s["cadence"] == "on_demand" and s["requested_by"] == user["id"]

    async def gen():
        last = -1
        rows = await db.pool().fetch("SELECT seq, round, kind, content_md, member_id FROM council_messages WHERE session_id=$1 ORDER BY seq", session_id)
        for m in rows:                                          # replay persisted messages (reconnect-safe)
            last = m["seq"]
            yield _sse(_public(m))
        queue = None
        if own_on_demand:
            import modal
            queue = modal.Queue.from_name("nuwrrrld-council-events")
        while True:
            status = await db.pool().fetchval("SELECT status FROM council_sessions WHERE id=$1", session_id)
            if queue is not None:                               # live push for the requester's own session only
                evt = await queue.get.aio(partition=str(session_id), timeout=QUEUE_TIMEOUT_SECONDS)
                if evt is not None and evt.get("seq", 0) > last:
                    last = evt["seq"]
                    yield _sse(evt)
                    if evt.get("type") == "session_complete":
                        return
                    continue
                yield ": keepalive\n\n"
            else:                                               # many viewers: poll the durable copy
                new = await db.pool().fetch("SELECT seq, round, kind, content_md, member_id FROM council_messages "
                                            "WHERE session_id=$1 AND seq>$2 ORDER BY seq", session_id, last)
                for m in new:
                    last = m["seq"]
                    yield _sse(_public(m))
                if not new:
                    yield ": keepalive\n\n"
                await asyncio.sleep(POLL_SECONDS)
            if status in FINISHED:
                yield _sse({"type": "session_complete", "status": status})
                return

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@router.get("/portfolios")
async def portfolios(user: dict = Depends(require_entitlement)):
    rows = await db.pool().fetch(
        """SELECT p.id, p.name, p.owner_type, p.cadence, p.status, p.starting_cash, p.inception_date,
                  (SELECT equity FROM paper_equity_snapshots s WHERE s.portfolio_id=p.id ORDER BY session_date DESC LIMIT 1) AS equity,
                  (SELECT cum_return FROM paper_equity_snapshots s WHERE s.portfolio_id=p.id ORDER BY session_date DESC LIMIT 1) AS cum_return,
                  (SELECT drawdown FROM paper_equity_snapshots s WHERE s.portfolio_id=p.id ORDER BY session_date DESC LIMIT 1) AS drawdown
             FROM paper_portfolios p WHERE NOT p.is_backtest AND p.status <> 'archived' ORDER BY p.owner_type, p.cadence, p.name""")
    return {"portfolios": [_public(r) for r in rows], "disclaimer": PAPER_DISCLAIMER}


@router.get("/portfolios/{portfolio_id}")
async def portfolio_detail(portfolio_id: UUID, user: dict = Depends(require_entitlement)):
    p = db.pool()
    pf = await p.fetchrow("SELECT * FROM paper_portfolios WHERE id=$1", portfolio_id)
    if pf is None:
        raise HTTPException(404, detail={"code": "not_found"})
    curve = await p.fetch("SELECT session_date, equity, cum_return, drawdown, benchmark_close FROM paper_equity_snapshots "
                          "WHERE portfolio_id=$1 ORDER BY session_date", portfolio_id)
    fills = await p.fetch("SELECT * FROM paper_fills WHERE portfolio_id=$1 ORDER BY filled_at", portfolio_id)
    out = {"portfolio": _public(pf), "positions": [_public(r) for r in await p.fetch("SELECT * FROM paper_positions WHERE portfolio_id=$1", portfolio_id)],
           "orders": [_public(r) for r in await p.fetch("SELECT * FROM paper_orders WHERE portfolio_id=$1 ORDER BY created_at DESC LIMIT 100", portfolio_id)],
           "fills": [_public(r) for r in fills[-100:]], "equity_curve": [_public(r) for r in curve],
           "stats": {**stats.equity_stats([float(r["equity"]) for r in curve], [float(r["benchmark_close"]) for r in curve] if all(r["benchmark_close"] for r in curve) else None),
                     **stats.trade_stats([dict(f) for f in fills], float(pf["starting_cash"]))},
           "assumptions": ["Shorts are assumed borrowable with no borrow fee.", "Fills use the next session's open plus slippage."],
           "disclaimer": PAPER_DISCLAIMER}
    return out
