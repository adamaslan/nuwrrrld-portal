"""Admin endpoints ([A] = users.role = 'admin', DB-authoritative)."""
from __future__ import annotations

import datetime as dt
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from nuwrrrld import db
from nuwrrrld.api import spawn
from nuwrrrld.api.deps import require_admin

router = APIRouter(prefix="/admin", tags=["admin"])
RUNNABLE_JOBS = {"paper_fill_open", "paper_fill_close", "ingest_eod_bars", "equity_snapshots", "signals_pipeline", "followed_score",
                 "council_daily", "council_weekly", "factor_refresh", "digest_publish", "followed_freeze", "health_checks_weekly",
                 "trial_sweeper", "billing_reconcile", "referral_qualifier", "backfill_gaps", "calendar_refresh", "maintenance", "watchdog"}


class RunIn(BaseModel):
    run_key: str | None = Field(default=None, max_length=40)
    force: bool = False


class BackfillIn(BaseModel):
    stage: Literal["all", "bars", "signals"] = "all"
    start: dt.date
    end: dt.date


class GrantIn(BaseModel):
    user_id: str
    days: int = Field(gt=0, le=366)
    reason: str = Field(min_length=3, max_length=200)


class OverrideIn(BaseModel):
    session_date: dt.date
    is_open: bool
    note: str = Field(min_length=3, max_length=200)


@router.get("/job-runs")
async def job_runs(since: dt.datetime | None = None, admin: dict = Depends(require_admin)):
    rows = await db.pool().fetch("SELECT * FROM job_runs WHERE started_at >= COALESCE($1, now() - interval '3 days') ORDER BY started_at DESC LIMIT 500", since)
    return {"runs": [{k: (str(v) if isinstance(v, dt.datetime) else v) for k, v in dict(r).items()} for r in rows]}


@router.post("/jobs/{job}/run", status_code=202)
async def run_job_now(job: str, body: RunIn, admin: dict = Depends(require_admin)):
    if job not in RUNNABLE_JOBS:
        raise HTTPException(404, detail={"code": "unknown_job"})
    call_id = await spawn.spawn(job, run_key=body.run_key, force=body.force)    # idempotent unless force
    await db.pool().execute("INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,'admin.job_run',$2,$3)",
                            f"admin:{admin['id']}", job, body.model_dump())
    return {"call_id": call_id}


@router.post("/backfill", status_code=202)
async def backfill(body: BackfillIn, admin: dict = Depends(require_admin)):
    if body.end < body.start or (body.end - body.start).days > 800:
        raise HTTPException(422, detail={"code": "bad_range"})
    call_id = await spawn.spawn("backfill_job", body.start.isoformat(), body.end.isoformat(), body.stage)
    return {"call_id": call_id}


@router.get("/llm-usage")
async def llm_usage(from_: dt.date = Query(alias="from"), to: dt.date = Query(), admin: dict = Depends(require_admin)):
    rows = await db.pool().fetch(
        """SELECT feature, model, count(*) AS calls, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
                  sum(est_cost_usd)::float AS est_cost_usd FROM llm_usage WHERE created_at >= $1 AND created_at < $2::date + 1
            GROUP BY feature, model ORDER BY est_cost_usd DESC NULLS LAST""", from_, to)
    return {"usage": [dict(r) for r in rows]}


@router.post("/grants", status_code=201)
async def comp_grant(body: GrantIn, admin: dict = Depends(require_admin)):
    row = await db.pool().fetchrow(
        """INSERT INTO entitlement_grants (user_id, kind, starts_at, ends_at, idempotency_key)
           VALUES ($1::uuid,'admin_comp', now(), now() + make_interval(days => $2), $3) ON CONFLICT DO NOTHING RETURNING id""",
        body.user_id, body.days, f"comp:{body.user_id}:{dt.date.today()}:{body.days}")
    await db.pool().execute("INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,'admin.comp',$2,$3)",
                            f"admin:{admin['id']}", body.user_id, {"days": body.days, "reason": body.reason})
    return {"granted": row is not None}


@router.post("/calendar/override")
async def calendar_override(body: OverrideIn, admin: dict = Depends(require_admin)):
    await db.pool().execute(
        """INSERT INTO trading_calendar (session_date, is_open, note, source) VALUES ($1,$2,$3,'manual')
           ON CONFLICT (session_date) DO UPDATE SET is_open=EXCLUDED.is_open, note=EXCLUDED.note, source='manual'""",
        body.session_date, body.is_open, body.note)
    return {"ok": True}


@router.post("/portfolios/{portfolio_id}/resume")
async def resume_portfolio(portfolio_id: str, admin: dict = Depends(require_admin)):
    n = await db.pool().execute("UPDATE paper_portfolios SET status='active', peak_equity=COALESCE("
                                "(SELECT equity FROM paper_equity_snapshots WHERE portfolio_id=$1::uuid ORDER BY session_date DESC LIMIT 1), peak_equity) "
                                "WHERE id=$1::uuid AND status='halted'", portfolio_id)
    if n == "UPDATE 0":
        raise HTTPException(404, detail={"code": "not_halted"})
    await db.pool().execute("INSERT INTO audit_log (actor, action, target) VALUES ($1,'admin.resume_portfolio',$2)", f"admin:{admin['id']}", portfolio_id)
    return {"ok": True}
