"""Account: profile, disclaimer, export, delete."""
from __future__ import annotations

import os

import httpx
from fastapi import APIRouter, Depends

from nuwrrrld import DISCLAIMER, db
from nuwrrrld.api.deps import current_user
from nuwrrrld.api.sync import with_conn
from nuwrrrld.billing import users as users_biz
from nuwrrrld.config import settings

router = APIRouter(tags=["account"])
CLERK_API = "https://api.clerk.com/v1"
EXPORT_TABLES = ("holdings", "watchlists", "user_alerts", "chat_threads", "portfolio_health_checks", "entitlement_grants",
                 "subscriptions", "referrals")


async def _access(user_id) -> dict:
    p = db.pool()
    until = await p.fetchval("SELECT access_until FROM user_access WHERE user_id=$1", user_id)
    grant = await p.fetchrow("SELECT kind, ends_at FROM entitlement_grants WHERE user_id=$1 AND revoked_at IS NULL "
                             "AND starts_at <= now() ORDER BY ends_at DESC LIMIT 1", user_id)
    sub = await p.fetchrow("SELECT status, current_period_end FROM subscriptions WHERE user_id=$1 AND status IN "
                           "('active','trialing','past_due') ORDER BY current_period_end DESC NULLS LAST LIMIT 1", user_id)
    queued = await p.fetchval("SELECT max(ends_at) FROM entitlement_grants WHERE user_id=$1 AND revoked_at IS NULL", user_id)
    source = "subscription" if sub and (not grant or (sub["current_period_end"] or until) >= grant["ends_at"]) else (grant["kind"] if grant else None)
    return {"access_until": until, "source": source, "access_until_including_queued": queued}


@router.get("/me")
async def get_me(user: dict = Depends(current_user)):
    return {"id": str(user["id"]), "email": user["email"], "display_name": user["display_name"], "timezone": user["timezone"],
            "role": user["role"], "referral_code": user["referral_code"],
            "disclaimer": {"accepted": user["disclaimer_accepted_at"] is not None and user["disclaimer_version"] == settings().disclaimer_version,
                           "current_version": settings().disclaimer_version, "text": DISCLAIMER},
            **await _access(user["id"])}


@router.post("/me/disclaimer")
async def accept_disclaimer(user: dict = Depends(current_user)):
    await db.pool().execute("UPDATE users SET disclaimer_accepted_at=now(), disclaimer_version=$2 WHERE id=$1",
                            user["id"], settings().disclaimer_version)
    return {"accepted": True, "version": settings().disclaimer_version}


@router.get("/me/export")
async def export_me(user: dict = Depends(current_user)):
    p = db.pool()
    out: dict = {"user": {k: (str(v) if v is not None else None) for k, v in user.items()}}
    for table in EXPORT_TABLES:          # literals only
        key = "referred_user_id" if table == "referrals" else "user_id"
        rows = await p.fetch(f"SELECT * FROM {table} WHERE {key}=$1", user["id"])
        out[table] = [{k: (v if isinstance(v, (int, float, bool, type(None), dict, list)) else str(v)) for k, v in r.items()} for r in rows]
    out["chat_messages"] = [{k: str(v) for k, v in r.items()} for r in await p.fetch(
        "SELECT id, thread_id, role, content, created_at FROM chat_messages WHERE user_id=$1 ORDER BY created_at", user["id"])]
    return out


@router.delete("/me", status_code=204)
async def delete_me(user: dict = Depends(current_user)):
    await with_conn(users_biz.soft_delete, user["clerk_user_id"])     # immediate lockout; purge job follows
    key = os.environ.get("CLERK_SECRET_KEY")
    if key:
        async with httpx.AsyncClient(timeout=10.0) as c:
            await c.delete(f"{CLERK_API}/users/{user['clerk_user_id']}", headers={"Authorization": f"Bearer {key}"})
