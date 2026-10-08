"""Followed Tickers: monthly frozen batches, scores, grades, leaderboard."""
from __future__ import annotations

import re
from datetime import date
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from nuwrrrld import DISCLAIMER, PAPER_DISCLAIMER, db
from nuwrrrld.api.deps import require_entitlement
from nuwrrrld.core.scoring import HORIZONS

router = APIRouter(prefix="/followed", tags=["followed"])
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


def _num(v):
    return float(v) if v is not None and hasattr(v, "as_tuple") else v


async def _calls(batch_id) -> list[dict]:
    p = db.pool()
    calls = await p.fetch("SELECT * FROM followed_calls WHERE batch_id=$1 ORDER BY side, rank", batch_id)
    ids = [c["id"] for c in calls]
    scores = await p.fetch("SELECT * FROM followed_horizon_scores WHERE call_id = ANY($1)", ids)
    grades = await p.fetch("SELECT call_id, grade_type, horizon, overall_score, letter_grade, rubric_scores, rationale_md, model, prompt_version "
                           "FROM followed_llm_grades WHERE call_id = ANY($1)", ids)
    out = []
    for c in calls:
        s = {r["horizon"]: {k: _num(v) for k, v in dict(r).items() if k not in ("call_id", "horizon")} for r in scores if r["call_id"] == c["id"]}
        out.append({**{k: _num(v) for k, v in dict(c).items()}, "id": str(c["id"]), "batch_id": str(c["batch_id"]), "signal_id": str(c["signal_id"]),
                    "horizons": {h: s.get(h) for h in HORIZONS},
                    "grades": [{**{k: _num(v) for k, v in dict(g).items()}, "call_id": str(g["call_id"])} for g in grades if g["call_id"] == c["id"]]})
    return out


@router.get("/batches")
async def batches(user: dict = Depends(require_entitlement)):
    rows = await db.pool().fetch(
        """SELECT b.batch_month, b.freeze_session, b.frozen_at, count(c.id) AS calls FROM followed_batches b
             LEFT JOIN followed_calls c ON c.batch_id=b.id GROUP BY b.id ORDER BY b.batch_month DESC""")
    return {"batches": [dict(r) for r in rows], "disclaimer": DISCLAIMER}


@router.get("/batches/{month}")
async def batch(month: str, user: dict = Depends(require_entitlement)):
    if not MONTH_RE.match(month):
        raise HTTPException(422, detail={"code": "bad_month", "detail": "use YYYY-MM"})
    b = await db.pool().fetchrow("SELECT * FROM followed_batches WHERE batch_month=$1", date.fromisoformat(month + "-01"))
    if b is None:
        raise HTTPException(404, detail={"code": "no_batch"})
    return {"batch_month": b["batch_month"], "freeze_session": b["freeze_session"], "selection_rules": b["selection_rules"],
            "calls": await _calls(b["id"]), "disclaimer": DISCLAIMER}


@router.get("/calls/{call_id}")
async def call(call_id: UUID, user: dict = Depends(require_entitlement)):
    c = await db.pool().fetchrow("SELECT batch_id FROM followed_calls WHERE id=$1", call_id)
    if c is None:
        raise HTTPException(404, detail={"code": "not_found"})
    return {"call": next(x for x in await _calls(c["batch_id"]) if x["id"] == str(call_id)), "disclaimer": DISCLAIMER}


@router.get("/leaderboard")
async def leaderboard(side: str | None = Query(None, pattern="^(bull|bear)$"), horizon: str | None = Query(None),
                      user: dict = Depends(require_entitlement)):
    if horizon and horizon not in HORIZONS:
        raise HTTPException(422, detail={"code": "bad_horizon"})
    p = db.pool()
    agg = await p.fetch(
        """SELECT h.horizon, c.side, count(*) AS n, avg((h.hit)::int)::float AS hit_rate,
                  avg(h.directional_return)::float AS avg_return, avg(h.excess_return)::float AS avg_excess
             FROM followed_horizon_scores h JOIN followed_calls c ON c.id=h.call_id
            WHERE h.status='scored' AND ($1::text IS NULL OR c.side=$1) AND ($2::text IS NULL OR h.horizon=$2)
            GROUP BY h.horizon, c.side ORDER BY h.horizon, c.side""", side, horizon)
    dist = await p.fetch("SELECT grade_type, letter_grade, count(*) AS n FROM followed_llm_grades GROUP BY 1,2 ORDER BY 1,2")
    return {"aggregates": [dict(r) for r in agg], "grade_distribution": [dict(r) for r in dist],
            "note": "All horizons and both hits and misses are shown; frozen calls are never edited.",
            "disclaimer": DISCLAIMER, "performance_disclaimer": PAPER_DISCLAIMER}
