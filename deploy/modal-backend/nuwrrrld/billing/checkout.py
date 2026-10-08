"""Stripe Checkout + Billing Portal session creation."""
from __future__ import annotations

import os

APP_URL = "https://financial.nuwrrrld.com"
FRIEND_TRIAL_DAYS = 30


def create_checkout_url(stripe, user: dict, *, stripe_customer_id: str | None, friend_month_eligible: bool,
                        today_et: str, app_trial_end: int | None = None) -> str:
    sub_data: dict = {"metadata": {"user_id": str(user["id"])}}
    if friend_month_eligible:
        sub_data["trial_period_days"] = FRIEND_TRIAL_DAYS
        sub_data["metadata"]["referral_friend_month"] = "1"
    elif app_trial_end:
        sub_data["trial_end"] = app_trial_end        # don't waste remaining app-trial days
    params = dict(
        mode="subscription", line_items=[{"price": os.environ["STRIPE_PRICE_ID_MONTHLY"], "quantity": 1}],
        client_reference_id=str(user["id"]),
        success_url=f"{APP_URL}/billing/success?session_id={{CHECKOUT_SESSION_ID}}", cancel_url=f"{APP_URL}/billing",
        subscription_data=sub_data, metadata={"user_id": str(user["id"])})
    if stripe_customer_id:
        params["customer"] = stripe_customer_id
    else:
        params["customer_email"] = user["email"]
    session = stripe.checkout.Session.create(
        **params, idempotency_key=f"checkout:{user['id']}:{today_et}:{int(friend_month_eligible)}")
    return session["url"]


def create_portal_url(stripe, stripe_customer_id: str) -> str:
    return stripe.billing_portal.Session.create(customer=stripe_customer_id, return_url=f"{APP_URL}/billing")["url"]
