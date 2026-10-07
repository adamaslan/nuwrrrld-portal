"""Signal Digest, signal history, indicators, sector rotation."""
from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query

from nuwrrrld import DISCLAIMER, db
from nuwrrrld.api.deps import require_entitlement
from nuwrrrld.calendar import ET, TradingCalendar

router = APIRouter(tags=["digest"])


def _expected_session(now: dt.datetime | None = None) -> dt.date:
    """The session whose digest should exist now (today's after 18:30 ET, otherwise the previous one)."""
    et = (now or dt.datetime.now(ET)).astimezone(ET)
    cal = TradingCalendar()
    today = et.date()
    if cal.is_session(today) and et.time() >= dt.time(18, 30):
        return today
    return cal.prev_session(today)


async def _digest(as_of: dt.date) -> dict | None:
    rows = await db.pool().fetch(
        """SELECT s.ticker, i.name, s.direction, s.strength::float AS strength, s.timeframe, s.horizon_days,
                  s.fired_indicators, s.explanation_md, s.explanation_source
             FROM signals s JOIN instruments i ON i.ticker=s.ticker JOIN signal_runs r ON r.id=s.run_id
            WHERE s.as_of_date=$1 AND r.status='published' ORDER BY abs(s.strength) DESC, s.ticker""", as_of)
    return {"as_of": as_of.isoformat(), "signals": [dict(r) for r in rows]} if rows else None


@router.get("/digest/latest")
async def digest_latest(user: dict = Depends(require_entitlement)):
    as_of = await db.pool().fetchval("SELECT max(as_of_date) FROM signal_runs WHERE status='published'")
    if as_of is None:
        raise HTTPException(404, detail={"code": "no_digest"})
    out = await _digest(as_of)
    return {**out, "data_delayed": as_of < _expected_session(), "disclaimer": DISCLAIMER}


@router.get("/digest/{date}")
async def digest_on(date: dt.date, user: dict = Depends(require_entitlement)):
    out = await _digest(date)
    if out is None:
        raise HTTPException(404, detail={"code": "no_digest"})
    return {**out, "disclaimer": DISCLAIMER}


@router.get("/signals/{ticker}")
async def signal_history(ticker: str, from_: dt.date | None = Query(None, alias="from"), to: dt.date | None = None,
                         user: dict = Depends(require_entitlement)):
    rows = await db.pool().fetch(
        """SELECT s.as_of_date, s.direction, s.strength::float AS strength, s.timeframe, s.horizon_days, s.fired_indicators,
                  s.explanation_md FROM signals s JOIN signal_runs r ON r.id=s.run_id
            WHERE s.ticker=$1 AND r.status='published' AND s.as_of_date >= COALESCE($2::date, DATE '1900-01-01') AND s.as_of_date <= COALESCE($3::date, DATE '2999-01-01')
            ORDER BY s.as_of_date DESC LIMIT 500""", ticker.upper(), from_, to)
    return {"ticker": ticker.upper(), "signals": [dict(r) for r in rows], "disclaimer": DISCLAIMER}


@router.get("/indicators/{ticker}")
async def indicators(ticker: str, date: dt.date | None = None, user: dict = Depends(require_entitlement)):
    as_of = date or await db.pool().fetchval("SELECT max(bar_date) FROM indicator_values WHERE ticker=$1", ticker.upper())
    rows = await db.pool().fetch(
        "SELECT DISTINCT ON (indicator) indicator, value::float AS value, components, engine_version FROM indicator_values "
        "WHERE ticker=$1 AND bar_date=$2 ORDER BY indicator, computed_at DESC", ticker.upper(), as_of)
    return {"ticker": ticker.upper(), "date": as_of, "indicators": [dict(r) for r in rows]}


@router.get("/sector-rotation")
async def sector_rotation(date: dt.date | None = None, user: dict = Depends(require_entitlement)):
    as_of = date or await db.pool().fetchval("SELECT max(as_of_date) FROM sector_rotation_snapshots")
    rows = await db.pool().fetch(
        "SELECT ticker, rs_ratio::float AS rs_ratio, rs_momentum::float AS rs_momentum, quadrant, rank "
        "FROM sector_rotation_snapshots WHERE as_of_date=$1 ORDER BY rank", as_of)
    return {"date": as_of, "rotation": [dict(r) for r in rows]}
