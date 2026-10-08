"""Request dependencies: current user (lazy upsert), entitlement + disclaimer gate, admin gate."""
from __future__ import annotations

import os
from datetime import datetime, timezone

import httpx
from fastapi import Depends, HTTPException
from starlette.concurrency import run_in_threadpool

from nuwrrrld import db
from nuwrrrld.api.auth import AuthUser, current_auth
from nuwrrrld.billing import users as users_biz
from nuwrrrld.config import settings

CLERK_API = "https://api.clerk.com/v1"
CLERK_TIMEOUT_SECONDS = 10.0


async def _clerk_profile(clerk_user_id: str) -> tuple[str | None, str | None]:
    """Email/name for lazy creation; None on any failure (the webhook fills it in later)."""
    key = os.environ.get("CLERK_SECRET_KEY")
    if not key:
        return None, None
    try:
        async with httpx.AsyncClient(timeout=CLERK_TIMEOUT_SECONDS) as c:
            r = await c.get(f"{CLERK_API}/users/{clerk_user_id}", headers={"Authorization": f"Bearer {key}"})
            r.raise_for_status()
        data = r.json()
        email, _ = users_biz._primary_email(data)
        return email, " ".join(x for x in (data.get("first_name"), data.get("last_name")) if x) or None
    except httpx.HTTPError:
        return None, None


def _create_user_sync(clerk_id: str, email: str | None, name: str | None) -> dict:
    conn = db.sync_connect()
    try:
        return dict(users_biz.get_or_create_by_clerk_id(conn, clerk_id, email, name))
    finally:
        conn.close()


async def current_user(auth: AuthUser = Depends(current_auth)) -> dict:
    row = await db.pool().fetchrow("SELECT * FROM users WHERE clerk_user_id=$1", auth.clerk_user_id)
    if row is None:
        email, name = await _clerk_profile(auth.clerk_user_id)
        user = await run_in_threadpool(_create_user_sync, auth.clerk_user_id, email, name)
    else:
        user = dict(row)
    if user.get("deleted_at") is not None:
        raise HTTPException(403, detail={"code": "account_deleted"})
    return user


async def require_entitlement(user: dict = Depends(current_user)) -> dict:
    row = await db.pool().fetchrow("SELECT access_until FROM user_access WHERE user_id=$1", user["id"])
    until = row["access_until"] if row else None
    if until is None or until <= datetime.now(timezone.utc):
        raise HTTPException(402, detail={"code": "subscription_required"})
    if user.get("disclaimer_accepted_at") is None or user.get("disclaimer_version") != settings().disclaimer_version:
        raise HTTPException(403, detail={"code": "disclaimer_required"})
    return user


async def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":                       # the DB role is authoritative, never token claims
        raise HTTPException(403, detail={"code": "admin_only"})
    return user
