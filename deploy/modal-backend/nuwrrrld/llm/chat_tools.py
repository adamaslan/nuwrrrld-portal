"""Nu AI: read-only, user-scoped tools + a streaming tool-calling loop (Sections 9.2, 13.4).

`user_id` is bound server-side and never comes from the model. No tool fetches URLs, writes data or sends messages.
"""
from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx

from nuwrrrld import db

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_TOOL_CALLS = 6
HTTP_TIMEOUT_SECONDS = 120.0

GLOSSARY = {
    "rsi": "RSI (14) measures the speed of recent price changes on a 0-100 scale; readings under 30 are often called oversold and over 70 overbought.",
    "macd": "MACD is the gap between a 12- and 26-session exponential average; its histogram is the gap to a 9-session signal line and shows momentum shifts.",
    "adx": "ADX (14) measures trend strength regardless of direction; above 25 is commonly read as a trending market. +DI and -DI show direction.",
    "atr": "ATR (14) is the average true range, a measure of typical daily movement. The app sizes invalidation distances in ATR units.",
    "bollinger": "Bollinger Bands (20, 2) plot two standard deviations around a 20-session average. %B shows where price sits within them.",
    "hold": "Hold/Fold: 'hold' means the model's bias supports the position side and price is on the right side of the invalidation level; otherwise 'fold'.",
    "invalidation": "The invalidation price is a structure-based level (clamped to 0.5-4 ATR from price) beyond which the model's reading no longer applies.",
    "relative strength": "Relative strength compares a fund's trailing return with the benchmark's over the same window (63 sessions here).",
    "rotation": "Sector rotation places each ETF in a quadrant by RS-ratio and RS-momentum: leading, weakening, lagging, improving.",
    "paper": "Paper trading is a hypothetical simulation: fills use the next session's open plus slippage; no real money is traded.",
    "council": "The AI Council is six seats (five analysts and a devil's advocate) that debate a ticker; consensus needs a weighted and a headcount threshold.",
    "followed": "Followed Tickers freezes the top 10 bullish and bearish signals on the first trading day of each month and scores them over seven horizons.",
}

TOOLS: list[dict] = [
    {"type": "function", "function": {"name": n, "description": d, "parameters": {"type": "object", "properties": p, "additionalProperties": False}}}
    for n, d, p in [
        ("get_holdings", "The user's holdings with latest close, market value, weight and unrealized P&L.", {}),
        ("get_watchlists", "The user's watchlists and tickers.", {}),
        ("get_signal", "Latest Signal Digest entry (direction, strength, fired indicators, explanation) for a ticker.",
         {"ticker": {"type": "string"}, "date": {"type": "string", "description": "YYYY-MM-DD, optional"}}),
        ("get_hold_fold", "Global Hold/Fold verdict (and a personal one if the user holds it).", {"ticker": {"type": "string"}}),
        ("get_portfolio_metrics", "Latest portfolio health-check metrics and findings.", {}),
        ("get_sector_rotation", "Latest sector-rotation quadrants.", {}),
        ("get_followed_calls", "Frozen Followed Tickers calls and scores for a month.", {"month": {"type": "string", "description": "YYYY-MM, optional"}}),
        ("get_council_consensus", "Latest scheduled AI Council consensus for a ticker.", {"ticker": {"type": "string"}}),
        ("search_glossary", "Methodology and concept definitions.", {"query": {"type": "string"}}),
    ]
]


def _clean(rows) -> list[dict]:
    return [{k: (float(v) if hasattr(v, "as_tuple") else (str(v) if hasattr(v, "isoformat") or v.__class__.__name__ == "UUID" else v))
             for k, v in dict(r).items()} for r in rows]


async def run_tool(name: str, args: dict, user_id: Any) -> tuple[dict, list[str]]:
    """Returns (result, context_refs). Parameterized SQL only; every query is user-scoped where personal."""
    p = db.pool()
    t = str(args.get("ticker", "")).upper().replace(".", "-")[:10]
    if name == "get_holdings":
        rows = await p.fetch(
            """SELECT h.id, h.ticker, h.quantity, h.cost_basis,
                      (SELECT adj_close FROM price_bars b WHERE b.ticker=h.ticker ORDER BY bar_date DESC LIMIT 1) AS close
                 FROM holdings h WHERE h.user_id=$1""", user_id)
        total = sum(abs(float(r["quantity"])) * float(r["close"] or 0) for r in rows) or 1.0
        out = []
        for r in rows:
            value = float(r["quantity"]) * float(r["close"] or 0)
            pnl = (float(r["close"]) - float(r["cost_basis"])) * float(r["quantity"]) if r["close"] and r["cost_basis"] else None
            out.append({"ticker": r["ticker"], "quantity": float(r["quantity"]), "close": float(r["close"]) if r["close"] else None,
                        "market_value": round(value, 2), "weight": round(abs(value) / total, 4),
                        "unrealized_pnl": round(pnl, 2) if pnl is not None else None})
        return {"holdings": out}, [f"holding:{r['id']}" for r in rows]
    if name == "get_watchlists":
        rows = await p.fetch("SELECT w.name, array_agg(i.ticker ORDER BY i.position) FILTER (WHERE i.ticker IS NOT NULL) AS tickers "
                             "FROM watchlists w LEFT JOIN watchlist_items i ON i.watchlist_id=w.id WHERE w.user_id=$1 GROUP BY w.id, w.name", user_id)
        return {"watchlists": [{"name": r["name"], "tickers": r["tickers"] or []} for r in rows]}, []
    if name == "get_signal":
        row = await p.fetchrow(
            """SELECT s.id, s.ticker, s.as_of_date, s.direction, s.strength, s.timeframe, s.horizon_days, s.fired_indicators, s.explanation_md
                 FROM signals s JOIN signal_runs r ON r.id=s.run_id WHERE s.ticker=$1 AND r.status='published'
                  AND ($2::date IS NULL OR s.as_of_date=$2::date) ORDER BY s.as_of_date DESC LIMIT 1""",
            t, __import__("datetime").date.fromisoformat(args["date"]) if args.get("date") else None)
        return ({"signal": _clean([row])[0]}, [f"signal:{row['id']}"]) if row else ({"error": "I don't have that data"}, [])
    if name == "get_hold_fold":
        g = await p.fetchrow("SELECT id, ticker, as_of_date, verdict, bias, risk_level, vol_regime, invalidation_price, readings "
                             "FROM hold_fold_verdicts WHERE ticker=$1 AND scope='global' ORDER BY as_of_date DESC LIMIT 1", t)
        u = await p.fetchrow("SELECT id, position_side, verdict, risk_level FROM hold_fold_verdicts WHERE ticker=$1 AND scope='user' "
                             "AND user_id=$2 ORDER BY as_of_date DESC LIMIT 1", t, user_id)
        if not g:
            return {"error": "I don't have that data"}, []
        return {"global": _clean([g])[0], "personal": _clean([u])[0] if u else None}, [f"hold_fold:{g['id']}"]
    if name == "get_portfolio_metrics":
        row = await p.fetchrow("SELECT id, as_of_date, metrics, findings FROM portfolio_health_checks WHERE user_id=$1 AND status='done' "
                               "ORDER BY created_at DESC LIMIT 1", user_id)
        return ({"as_of": str(row["as_of_date"]), "metrics": row["metrics"], "findings": row["findings"]}, [f"health:{row['id']}"]) if row \
            else ({"error": "No health check has run yet"}, [])
    if name == "get_sector_rotation":
        rows = await p.fetch("SELECT ticker, quadrant, rank, rs_ratio, rs_momentum FROM sector_rotation_snapshots WHERE as_of_date="
                             "(SELECT max(as_of_date) FROM sector_rotation_snapshots) ORDER BY rank LIMIT 54")
        return {"rotation": _clean(rows)}, []
    if name == "get_followed_calls":
        month = (args.get("month") or "")[:7]
        rows = await p.fetch(
            """SELECT c.id, c.side, c.rank, c.ticker, c.entry_price, c.invalidation_price,
                      (SELECT jsonb_object_agg(h.horizon, jsonb_build_object('hit', h.hit, 'directional_return', h.directional_return))
                         FROM followed_horizon_scores h WHERE h.call_id=c.id AND h.status='scored') AS scores
                 FROM followed_calls c JOIN followed_batches b ON b.id=c.batch_id
                WHERE ($1 = '' OR to_char(b.batch_month,'YYYY-MM')=$1) AND b.batch_month=(SELECT max(batch_month) FROM followed_batches WHERE $1 = '' OR to_char(batch_month,'YYYY-MM')=$1)
                ORDER BY c.side, c.rank""", month)
        return {"calls": _clean(rows)}, [f"followed:{r['id']}" for r in rows]
    if name == "get_council_consensus":
        row = await p.fetchrow(
            """SELECT s.id, s.as_of_date, c.outcome, c.direction, c.conviction, c.invalidation_price, c.agreement_ratio
                 FROM council_sessions s JOIN council_consensus c ON c.session_id=s.id
                WHERE s.subject_ticker=$1 AND s.trades_portfolios ORDER BY s.as_of_date DESC LIMIT 1""", t)
        return ({"consensus": _clean([row])[0]}, [f"council:{row['id']}"]) if row else ({"error": "I don't have that data"}, [])
    if name == "search_glossary":
        q = str(args.get("query", "")).lower()
        hits = [v for k, v in GLOSSARY.items() if k in q or any(w in q for w in k.split())]
        return {"definitions": hits[:3] or ["I don't have a definition for that."]}, []
    return {"error": f"unknown tool {name}"}, []


async def stream_with_tools(messages: list[dict], *, model: str, user_id: Any, max_tokens: int = 700,
                            run: Callable[[str, dict, Any], Awaitable[tuple[dict, list[str]]]] = run_tool
                            ) -> AsyncIterator[dict]:
    """Yield {'type': 'token'|'tool'|'citation'|'usage'|'final'} events; at most MAX_TOOL_CALLS tool calls per turn."""
    convo = list(messages)
    calls_made, text_parts, refs, tool_log = 0, [], [], []
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SECONDS) as client:
        while True:
            body = {"model": model, "messages": convo, "max_tokens": max_tokens, "temperature": 0.3, "stream": True,
                    "stream_options": {"include_usage": True}}
            if calls_made < MAX_TOOL_CALLS:
                body["tools"] = TOOLS
            pending: dict[int, dict] = {}
            round_text = ""
            async with client.stream("POST", OPENROUTER_URL, json=body,
                                     headers={"Authorization": f"Bearer {os.environ['LLM_API_KEY']}"}) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: ") or line.endswith("[DONE]"):
                        continue
                    try:
                        chunk = json.loads(line[6:])
                    except ValueError:
                        continue
                    if chunk.get("usage"):
                        yield {"type": "usage", **chunk["usage"]}
                    if not chunk.get("choices"):
                        continue
                    delta = chunk["choices"][0].get("delta", {})
                    if delta.get("content"):
                        round_text += delta["content"]
                        yield {"type": "token", "text": delta["content"]}
                    for tc in delta.get("tool_calls") or []:
                        slot = pending.setdefault(tc["index"], {"id": "", "name": "", "arguments": ""})
                        slot["id"] = tc.get("id") or slot["id"]
                        fn = tc.get("function", {})
                        slot["name"] += fn.get("name") or ""
                        slot["arguments"] += fn.get("arguments") or ""
            if not pending or calls_made >= MAX_TOOL_CALLS:
                text_parts.append(round_text)
                break
            convo.append({"role": "assistant", "content": round_text or None, "tool_calls": [
                {"id": s["id"], "type": "function", "function": {"name": s["name"], "arguments": s["arguments"]}} for s in pending.values()]})
            for slot in pending.values():
                calls_made += 1
                try:
                    args = json.loads(slot["arguments"] or "{}")
                except ValueError:
                    args = {}
                yield {"type": "tool", "name": slot["name"]}
                result, new_refs = await run(slot["name"], args if isinstance(args, dict) else {}, user_id)
                refs.extend(new_refs)
                tool_log.append({"name": slot["name"], "args": args, "result_ref": new_refs})
                convo.append({"role": "tool", "tool_call_id": slot["id"], "content": json.dumps(result, default=str)[:12000]})
    if refs:
        yield {"type": "citation", "refs": list(dict.fromkeys(refs))}
    yield {"type": "final", "text": "".join(text_parts), "tool_calls": tool_log, "refs": list(dict.fromkeys(refs))}
