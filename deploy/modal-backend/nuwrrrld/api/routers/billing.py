"""Stripe Checkout, Billing Portal and status."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException

from nuwrrrld import db
from nuwrrrld.api import ratelimit
from nuwrrrld.api.deps import current_user
from nuwrrrld.api.sync import with_conn
from nuwrrrld.billing import checkout, referrals
from nuwrrrld.calendar import today_et

router = APIRouter(prefix="/billing", tags=["billing"])


def _stripe():
    import stripe
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    return stripe


def _prepare_checkout(conn, user: dict) -> tuple[str | None, bool, int | None]:
    cust = conn.execute("SELECT stripe_customer_id FROM billing_customers WHERE user_id=%s", (user["id"],)).fetchone()
    eligible = referrals.friend_month_eligible(conn, user["id"]) is not None
    trial = conn.execute("SELECT ends_at FROM entitlement_grants WHERE user_id=%s AND kind='trial' AND revoked_at IS NULL", (user["id"],)).fetchone()
    trial_end = int(trial["ends_at"].timestamp()) if trial and trial["ends_at"].timestamp() > __import__("time").time() + 172800 else None
    return (cust["stripe_customer_id"] if cust else None), eligible, trial_end


@router.post("/checkout")
async def create_checkout(user: dict = Depends(current_user)):
    await ratelimit.hit("checkout", str(user["id"]))
    customer_id, eligible, trial_end = await with_conn(_prepare_checkout, user)
    url = checkout.create_checkout_url(_stripe(), user, stripe_customer_id=customer_id, friend_month_eligible=eligible,
                                       today_et=today_et().isoformat(), app_trial_end=trial_end)
    return {"url": url}


@router.post("/portal")
async def create_portal(user: dict = Depends(current_user)):
    cust = await db.pool().fetchval("SELECT stripe_customer_id FROM billing_customers WHERE user_id=$1", user["id"])
    if cust is None:
        raise HTTPException(404, detail={"code": "no_billing_customer"})
    return {"url": checkout.create_portal_url(_stripe(), cust)}


@router.get("/status")
async def status(user: dict = Depends(current_user)):
    p = db.pool()
    sub = await p.fetchrow("SELECT status, current_period_end, cancel_at_period_end, stripe_trial_end FROM subscriptions "
                           "WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", user["id"])
    grants = await p.fetch("SELECT kind, starts_at, ends_at, applied_via, starts_at > now() AS queued FROM entitlement_grants "
                           "WHERE user_id=$1 AND revoked_at IS NULL ORDER BY starts_at", user["id"])
    return {"subscription": dict(sub) if sub else None, "grants": [dict(g) for g in grants],
            "next_renewal": sub["current_period_end"] if sub and not sub["cancel_at_period_end"] else None}
