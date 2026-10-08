"""Signature-verified inbound webhooks (Clerk via Svix, Stripe). Shared pattern: Section 15.1."""
from __future__ import annotations

import json
import os

from fastapi import APIRouter, HTTPException, Request

from nuwrrrld.api.sync import with_conn
from nuwrrrld.billing import stripe_events, users

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


def begin(conn, provider: str, event_id: str, etype: str, payload: dict, created=None) -> bool:
    """Record the event; False when it was already processed (duplicate delivery)."""
    conn.execute("INSERT INTO webhook_events (provider, event_id, event_type, event_created, payload) VALUES (%s,%s,%s,%s,%s) "
                 "ON CONFLICT (provider, event_id) DO NOTHING", (provider, event_id, etype, created, json.dumps(payload)))
    row = conn.execute("SELECT processed_at FROM webhook_events WHERE provider=%s AND event_id=%s", (provider, event_id)).fetchone()
    return row["processed_at"] is None


def done(conn, provider: str, event_id: str) -> None:
    conn.execute("UPDATE webhook_events SET processed_at=now(), attempts=attempts+1, last_error=NULL WHERE provider=%s AND event_id=%s",
                 (provider, event_id))


def fail(conn, provider: str, event_id: str, err: str) -> None:
    conn.execute("UPDATE webhook_events SET attempts=attempts+1, last_error=%s WHERE provider=%s AND event_id=%s",
                 (err[:2000], provider, event_id))


def _process(conn, provider: str, event_id: str, etype: str, payload: dict, handler) -> dict:
    if not begin(conn, provider, event_id, etype, payload, None):
        return {"ok": True, "duplicate": True}
    try:
        handler(conn)
        done(conn, provider, event_id)
    except Exception as exc:
        fail(conn, provider, event_id, repr(exc))
        raise
    return {"ok": True}


@router.post("/clerk")
async def clerk_webhook(request: Request):
    from svix.webhooks import Webhook, WebhookVerificationError
    body = await request.body()                                     # raw bytes: signatures cover them
    headers = {k: request.headers.get(k, "") for k in ("svix-id", "svix-timestamp", "svix-signature")}
    try:
        Webhook(os.environ["CLERK_WEBHOOK_SECRET"]).verify(body, headers)    # raises on a bad signature / stale timestamp
    except WebhookVerificationError as exc:
        raise HTTPException(400, "Invalid signature") from exc
    evt = json.loads(body)             # svix versions differ on verify()'s return value; parse the verified bytes ourselves
    etype, data = evt["type"], evt["data"]

    def handle(conn):
        if etype in ("user.created", "user.updated"):
            users.upsert_from_clerk(conn, data)
        elif etype == "user.deleted":
            users.soft_delete(conn, data["id"])

    try:
        return await with_conn(_process, "clerk", headers["svix-id"], etype, evt, handle)
    except Exception as exc:
        raise HTTPException(500, "Processing failed") from exc     # Svix will retry


@router.post("/stripe")
async def stripe_webhook(request: Request):
    import stripe
    payload = await request.body()
    try:
        event = stripe.Webhook.construct_event(payload=payload, sig_header=request.headers.get("stripe-signature", ""),
                                               secret=os.environ["STRIPE_WEBHOOK_SECRET"])
    except (ValueError, stripe.SignatureVerificationError) as exc:
        raise HTTPException(400, "Invalid signature") from exc
    stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
    ev = event.to_dict() if hasattr(event, "to_dict") else dict(event)
    try:
        return await with_conn(_process, "stripe", ev["id"], ev["type"], ev,
                               lambda conn: stripe_events.dispatch(conn, ev, stripe))
    except Exception as exc:
        raise HTTPException(500, "Processing failed") from exc     # Stripe will retry
