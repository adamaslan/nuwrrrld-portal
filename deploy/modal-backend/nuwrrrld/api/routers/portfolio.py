"""Portfolio Intel: holdings, watchlists, alerts, summary, AI health check."""
from __future__ import annotations

import csv
import io
import re
from datetime import date
from decimal import Decimal, InvalidOperation
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from nuwrrrld import DISCLAIMER, db
from nuwrrrld.api import pagination, ratelimit, spawn
from nuwrrrld.api.deps import require_entitlement
from nuwrrrld.api.sync import with_conn
from nuwrrrld.core import portfolio_metrics
from nuwrrrld.jobs import health

router = APIRouter(tags=["portfolio"])
MAX_IMPORT_ROWS = 500
TICKER_RE = re.compile(r"^[A-Z]{1,6}([.-][A-Z])?$")


class HoldingIn(BaseModel):
    ticker: str = Field(pattern=r"^[A-Za-z.\-]{1,8}$")
    quantity: Decimal
    cost_basis: Decimal | None = Field(default=None, gt=0)
    opened_at: date | None = None
    account_label: str = Field(default="default", max_length=40)
    notes: str | None = Field(default=None, max_length=500)       # untrusted: only ever passed to prompts as data


class HoldingPatch(BaseModel):
    quantity: Decimal | None = None
    cost_basis: Decimal | None = Field(default=None, gt=0)
    notes: str | None = Field(default=None, max_length=500)


class WatchlistIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    is_default: bool = False


class ItemIn(BaseModel):
    alert_rules: dict[str, bool] = Field(default_factory=dict)
    position: int = 0


class ImportIn(BaseModel):
    csv: str = Field(max_length=200_000)


async def _valid_ticker(ticker: str) -> str:
    t = ticker.upper().replace(".", "-")
    if not await db.pool().fetchval("SELECT 1 FROM instruments WHERE ticker=$1 AND active", t):
        raise HTTPException(422, detail={"code": "unknown_ticker", "detail": f"{t} is not a tracked instrument"})
    return t


# --- holdings -----------------------------------------------------------------------------------
@router.get("/holdings")
async def list_holdings(user: dict = Depends(require_entitlement)):
    rows = await db.pool().fetch(
        """SELECT h.id, h.ticker, h.quantity, h.cost_basis, h.opened_at, h.account_label, h.source, h.notes,
                  (SELECT adj_close FROM price_bars b WHERE b.ticker=h.ticker ORDER BY bar_date DESC LIMIT 1) AS last_close
             FROM holdings h WHERE h.user_id=$1 ORDER BY h.ticker""", user["id"])
    return {"holdings": [{**dict(r), "quantity": float(r["quantity"]), "last_close": float(r["last_close"]) if r["last_close"] else None,
                          "cost_basis": float(r["cost_basis"]) if r["cost_basis"] else None} for r in rows]}


@router.post("/holdings", status_code=201)
async def create_holding(body: HoldingIn, user: dict = Depends(require_entitlement)):
    if body.quantity == 0:
        raise HTTPException(422, detail={"code": "zero_quantity"})
    t = await _valid_ticker(body.ticker)
    try:
        row = await db.pool().fetchrow(
            """INSERT INTO holdings (user_id, ticker, quantity, cost_basis, opened_at, account_label, notes)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id""", user["id"], t, body.quantity, body.cost_basis, body.opened_at,
            body.account_label, body.notes)
    except asyncpg.UniqueViolationError as exc:
        raise HTTPException(409, detail={"code": "holding_exists"}) from exc
    return {"id": str(row["id"])}


@router.patch("/holdings/{holding_id}")
async def patch_holding(holding_id: UUID, body: HoldingPatch, user: dict = Depends(require_entitlement)):
    if body.quantity == 0:
        raise HTTPException(422, detail={"code": "zero_quantity"})
    n = await db.pool().execute(
        "UPDATE holdings SET quantity=COALESCE($3,quantity), cost_basis=COALESCE($4,cost_basis), notes=COALESCE($5,notes) "
        "WHERE id=$1 AND user_id=$2", holding_id, user["id"], body.quantity, body.cost_basis, body.notes)
    if n == "UPDATE 0":
        raise HTTPException(404, detail={"code": "not_found"})
    return {"ok": True}


@router.delete("/holdings/{holding_id}", status_code=204)
async def delete_holding(holding_id: UUID, user: dict = Depends(require_entitlement)):
    await db.pool().execute("DELETE FROM holdings WHERE id=$1 AND user_id=$2", holding_id, user["id"])


@router.post("/holdings/import")
async def import_holdings(body: ImportIn, dry_run: bool = Query(True), user: dict = Depends(require_entitlement)):
    await ratelimit.hit("import", str(user["id"]))
    reader = csv.DictReader(io.StringIO(body.csv))
    rows, errors = [], []
    for i, rec in enumerate(reader, start=2):
        if len(rows) + len(errors) >= MAX_IMPORT_ROWS:
            errors.append({"line": i, "error": f"row limit {MAX_IMPORT_ROWS} reached"})
            break
        try:
            ticker = (rec.get("ticker") or "").strip().upper()
            if not TICKER_RE.match(ticker):
                raise ValueError("invalid ticker")
            t = await _valid_ticker(ticker)
            qty = Decimal((rec.get("quantity") or "").strip())
            if qty == 0:
                raise ValueError("quantity must be non-zero")
            basis = Decimal(rec["cost_basis"].strip()) if (rec.get("cost_basis") or "").strip() else None
            rows.append((t, qty, basis, (rec.get("account_label") or "default").strip()[:40]))
        except (ValueError, InvalidOperation, HTTPException) as exc:
            errors.append({"line": i, "error": str(getattr(exc, "detail", exc))})
    if not dry_run and rows:
        async with db.pool().acquire() as conn, conn.transaction():
            await conn.executemany(
                """INSERT INTO holdings (user_id, ticker, quantity, cost_basis, account_label, source)
                   VALUES ($1,$2,$3,$4,$5,'csv_import') ON CONFLICT (user_id, account_label, ticker)
                   DO UPDATE SET quantity=EXCLUDED.quantity, cost_basis=EXCLUDED.cost_basis""",
                [(user["id"], t, q, b, a) for t, q, b, a in rows])
    return {"dry_run": dry_run, "valid": len(rows), "errors": errors}


# --- watchlists -------------------------------------------------------------------------------------
@router.get("/watchlists")
async def list_watchlists(user: dict = Depends(require_entitlement)):
    p = db.pool()
    lists = await p.fetch("SELECT id, name, is_default FROM watchlists WHERE user_id=$1 ORDER BY created_at", user["id"])
    out = []
    for w in lists:
        items = await p.fetch("SELECT ticker, position, alert_rules FROM watchlist_items WHERE watchlist_id=$1 ORDER BY position, ticker", w["id"])
        out.append({**dict(w), "id": str(w["id"]), "items": [dict(i) for i in items]})
    return {"watchlists": out}


@router.post("/watchlists", status_code=201)
async def create_watchlist(body: WatchlistIn, user: dict = Depends(require_entitlement)):
    async with db.pool().acquire() as conn, conn.transaction():
        if body.is_default:
            await conn.execute("UPDATE watchlists SET is_default=false WHERE user_id=$1", user["id"])
        try:
            row = await conn.fetchrow("INSERT INTO watchlists (user_id, name, is_default) VALUES ($1,$2,$3) RETURNING id",
                                      user["id"], body.name, body.is_default)
        except asyncpg.UniqueViolationError as exc:
            raise HTTPException(409, detail={"code": "watchlist_exists"}) from exc
    return {"id": str(row["id"])}


@router.patch("/watchlists/{wid}")
async def patch_watchlist(wid: UUID, body: WatchlistIn, user: dict = Depends(require_entitlement)):
    async with db.pool().acquire() as conn, conn.transaction():
        if body.is_default:
            await conn.execute("UPDATE watchlists SET is_default=false WHERE user_id=$1", user["id"])
        n = await conn.execute("UPDATE watchlists SET name=$3, is_default=$4 WHERE id=$1 AND user_id=$2", wid, user["id"], body.name, body.is_default)
    if n == "UPDATE 0":
        raise HTTPException(404, detail={"code": "not_found"})
    return {"ok": True}


@router.delete("/watchlists/{wid}", status_code=204)
async def delete_watchlist(wid: UUID, user: dict = Depends(require_entitlement)):
    await db.pool().execute("DELETE FROM watchlists WHERE id=$1 AND user_id=$2", wid, user["id"])


async def _own_watchlist(wid: UUID, user: dict) -> None:
    if not await db.pool().fetchval("SELECT 1 FROM watchlists WHERE id=$1 AND user_id=$2", wid, user["id"]):
        raise HTTPException(404, detail={"code": "not_found"})


@router.put("/watchlists/{wid}/items/{ticker}")
async def put_item(wid: UUID, ticker: str, body: ItemIn, user: dict = Depends(require_entitlement)):
    await _own_watchlist(wid, user)
    t = await _valid_ticker(ticker)
    allowed = {"signal_flip", "hold_fold_change", "quadrant_change"}
    if set(body.alert_rules) - allowed:
        raise HTTPException(422, detail={"code": "bad_alert_rule", "detail": f"allowed: {sorted(allowed)}"})
    await db.pool().execute(
        """INSERT INTO watchlist_items (watchlist_id, ticker, position, alert_rules) VALUES ($1,$2,$3,$4)
           ON CONFLICT (watchlist_id, ticker) DO UPDATE SET position=EXCLUDED.position, alert_rules=EXCLUDED.alert_rules""",
        wid, t, body.position, body.alert_rules)
    return {"ok": True}


@router.delete("/watchlists/{wid}/items/{ticker}", status_code=204)
async def delete_item(wid: UUID, ticker: str, user: dict = Depends(require_entitlement)):
    await _own_watchlist(wid, user)
    await db.pool().execute("DELETE FROM watchlist_items WHERE watchlist_id=$1 AND ticker=$2", wid, ticker.upper().replace(".", "-"))


# --- alerts -------------------------------------------------------------------------------------------
@router.get("/alerts")
async def alerts(unread: bool = False, cursor: str | None = None, limit: int = Query(25), user: dict = Depends(require_entitlement)):
    limit, cur = pagination.clamp(limit), pagination.decode(cursor)
    rows = await db.pool().fetch(
        """SELECT id, ticker, as_of_date, kind, payload, read_at, created_at FROM user_alerts
            WHERE user_id=$1 AND (NOT $2 OR read_at IS NULL) AND ($3::timestamptz IS NULL OR (created_at, id::text) < ($3, $4))
            ORDER BY created_at DESC, id DESC LIMIT $5""", user["id"], unread, cur[0] if cur else None, cur[1] if cur else None, limit + 1)
    page = rows[:limit]
    return {"alerts": [{**dict(r), "id": str(r["id"])} for r in page],
            "next_cursor": pagination.encode(page[-1]["created_at"], page[-1]["id"]) if len(rows) > limit else None}


@router.post("/alerts/{alert_id}/read")
async def read_alert(alert_id: UUID, user: dict = Depends(require_entitlement)):
    await db.pool().execute("UPDATE user_alerts SET read_at=now() WHERE id=$1 AND user_id=$2 AND read_at IS NULL", alert_id, user["id"])
    return {"ok": True}


# --- summary + health check -----------------------------------------------------------------------------
async def _positions(user_id) -> list[dict]:
    rows = await db.pool().fetch(
        """SELECT h.ticker, h.quantity::float AS quantity, h.account_label, i.sector,
                  (SELECT adj_close::float FROM price_bars b WHERE b.ticker=h.ticker ORDER BY bar_date DESC LIMIT 1) AS close,
                  (SELECT value::float FROM factor_exposures f WHERE f.ticker=h.ticker AND f.factor='beta_spy_252' ORDER BY as_of_date DESC LIMIT 1) AS beta,
                  (SELECT value::float FROM factor_exposures f WHERE f.ticker=h.ticker AND f.factor='vol_63' ORDER BY as_of_date DESC LIMIT 1) AS vol_63,
                  (SELECT direction FROM signals s WHERE s.ticker=h.ticker ORDER BY as_of_date DESC LIMIT 1) AS signal_direction,
                  (SELECT verdict FROM hold_fold_verdicts v WHERE v.ticker=h.ticker AND v.scope='global' ORDER BY as_of_date DESC LIMIT 1) AS verdict
             FROM holdings h JOIN instruments i ON i.ticker=h.ticker WHERE h.user_id=$1""", user_id)
    return [dict(r) for r in rows]


@router.get("/portfolio/summary")
async def summary(user: dict = Depends(require_entitlement)):
    metrics = portfolio_metrics.compute_metrics(await _positions(user["id"]))
    return {"metrics": metrics, "findings": portfolio_metrics.findings(metrics), "disclaimer": DISCLAIMER}


@router.post("/portfolio/health-check", status_code=202)
async def start_health_check(user: dict = Depends(require_entitlement)):
    spawn.require_llm()
    await ratelimit.hit("health_check", str(user["id"]))
    check_id, created = await with_conn(health.create_check, str(user["id"]), "on_demand")
    if created:
        await spawn.spawn("run_health_check", check_id)
    return {"id": check_id, "status": "queued" if created else "cached"}


@router.get("/portfolio/health-check/latest")
async def latest_check(user: dict = Depends(require_entitlement)):
    row = await db.pool().fetchrow("SELECT * FROM portfolio_health_checks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", user["id"])
    if row is None:
        raise HTTPException(404, detail={"code": "no_check"})
    return {**dict(row), "id": str(row["id"]), "user_id": str(row["user_id"]), "disclaimer": DISCLAIMER}


@router.get("/portfolio/health-check/{check_id}")
async def get_check(check_id: UUID, user: dict = Depends(require_entitlement)):
    row = await db.pool().fetchrow("SELECT * FROM portfolio_health_checks WHERE id=$1 AND user_id=$2", check_id, user["id"])
    if row is None:
        raise HTTPException(404, detail={"code": "not_found"})
    return {**dict(row), "id": str(row["id"]), "user_id": str(row["user_id"]), "disclaimer": DISCLAIMER}
