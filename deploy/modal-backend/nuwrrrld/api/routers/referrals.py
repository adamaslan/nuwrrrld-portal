"""Share & Earn endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from nuwrrrld import db
from nuwrrrld.api import ratelimit
from nuwrrrld.api.deps import current_user
from nuwrrrld.api.sync import with_conn
from nuwrrrld.billing import referrals as biz

router = APIRouter(prefix="/referrals", tags=["referrals"])
SHARE_BASE = "https://financial.nuwrrrld.com/r/"


class CodeIn(BaseModel):
    code: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


@router.get("")
async def my_referrals(user: dict = Depends(current_user)):
    p = db.pool()
    funnel = await p.fetch("SELECT status, count(*) AS n FROM referrals WHERE referrer_user_id=$1 GROUP BY status", user["id"])
    clicks = await p.fetchval("SELECT count(*) FROM referral_clicks WHERE code=$1", user["referral_code"])
    rewards = await p.fetch("SELECT kind, starts_at, ends_at, applied_via FROM entitlement_grants WHERE user_id=$1 AND kind='referral_referrer' "
                            "AND revoked_at IS NULL ORDER BY starts_at", user["id"])
    return {"code": user["referral_code"], "share_url": SHARE_BASE + user["referral_code"], "clicks": clicks,
            "funnel": {r["status"]: r["n"] for r in funnel}, "rewards": [dict(r) for r in rewards]}


@router.post("/attribute")
async def attribute(body: CodeIn, user: dict = Depends(current_user)):
    await ratelimit.hit("referral_attribute", str(user["id"]))
    try:
        row = await with_conn(biz.attribute, user, body.code)
    except biz.ReferralError as exc:
        raise HTTPException(400, detail={"code": "unknown_code", "detail": str(exc)}) from exc
    return {"status": row["status"], "reason": row["reason"]}


@router.post("/click")
async def click(body: CodeIn, request: Request):
    """Public (called by the web /r/{code} route); rate-limited per hashed IP."""
    h = ratelimit.ip_hash(request)
    await ratelimit.hit("referral_click", h)
    await db.pool().execute("INSERT INTO referral_clicks (code, ip_hash, user_agent) VALUES ($1,$2,$3)",
                            body.code, h, (request.headers.get("user-agent") or "")[:200])
    return {"ok": True}
