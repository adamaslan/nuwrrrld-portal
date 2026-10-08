"""Stripe webhook dispatch: idempotent, order-tolerant handlers that re-fetch canonical objects (Section 15.3)."""
from __future__ import annotations

import datetime as dt
import logging

from nuwrrrld.billing import referrals

log = logging.getLogger(__name__)


def _ts(v: int | None) -> dt.datetime | None:
    return dt.datetime.fromtimestamp(v, dt.timezone.utc) if v else None


def _period(sub: dict) -> tuple[int | None, int | None]:
    item = (sub.get("items") or {}).get("data", [{}])[0]
    return (sub.get("current_period_start") or item.get("current_period_start"),
            sub.get("current_period_end") or item.get("current_period_end"))


def _user_for(conn, customer_id: str | None, metadata: dict | None):
    if customer_id:
        row = conn.execute("SELECT user_id FROM billing_customers WHERE stripe_customer_id=%s", (customer_id,)).fetchone()
        if row:
            return row["user_id"]
    uid = (metadata or {}).get("user_id")
    return uid


def upsert_subscription(conn, sub: dict, event_created: int) -> None:
    user_id = _user_for(conn, sub.get("customer"), sub.get("metadata"))
    if user_id is None:
        log.warning("subscription %s has no resolvable user; skipped", sub["id"])
        return
    if sub.get("customer"):
        conn.execute("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                     (user_id, sub["customer"]))
    start, end = _period(sub)
    price_id = ((sub.get("items") or {}).get("data") or [{}])[0].get("price", {}).get("id", "")
    conn.execute(
        """INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_price_id, status, current_period_start,
                   current_period_end, cancel_at_period_end, canceled_at, stripe_trial_end, last_event_created)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
           ON CONFLICT (stripe_subscription_id) DO UPDATE SET stripe_price_id=EXCLUDED.stripe_price_id, status=EXCLUDED.status,
             current_period_start=EXCLUDED.current_period_start, current_period_end=EXCLUDED.current_period_end,
             cancel_at_period_end=EXCLUDED.cancel_at_period_end, canceled_at=EXCLUDED.canceled_at,
             stripe_trial_end=EXCLUDED.stripe_trial_end, last_event_created=EXCLUDED.last_event_created
           WHERE subscriptions.last_event_created <= EXCLUDED.last_event_created""",
        (user_id, sub["id"], price_id, sub["status"], _ts(start), _ts(end), bool(sub.get("cancel_at_period_end")),
         _ts(sub.get("canceled_at")), _ts(sub.get("trial_end")), _ts(event_created)))


def dispatch(conn, event: dict, stripe) -> str:
    etype, obj, created = event["type"], event["data"]["object"], event.get("created", 0)
    if etype == "checkout.session.completed":
        uid = obj.get("client_reference_id") or (obj.get("metadata") or {}).get("user_id")
        if obj.get("customer") and uid:
            conn.execute("INSERT INTO billing_customers (user_id, stripe_customer_id) VALUES (%s,%s) ON CONFLICT DO NOTHING",
                         (uid, obj["customer"]))
        if obj.get("subscription"):
            sub = stripe.Subscription.retrieve(obj["subscription"])
            upsert_subscription(conn, sub, created)
            flagged = ((sub.get("metadata") or {}).get("referral_friend_month") == "1"
                       or (obj.get("metadata") or {}).get("referral_friend_month") == "1")
            ref = conn.execute("SELECT * FROM referrals WHERE referred_user_id=%s", (uid,)).fetchone() if (uid and flagged) else None
            if ref:
                referrals.record_friend_grant(conn, ref, obj.get("id"))
        return "checkout"
    if etype in ("customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"):
        upsert_subscription(conn, stripe.Subscription.retrieve(obj["id"]), created)
        return "subscription"
    if etype == "invoice.paid":
        if obj.get("subscription"):
            upsert_subscription(conn, stripe.Subscription.retrieve(obj["subscription"]), created)
        uid = _user_for(conn, obj.get("customer"), None)
        if uid:
            referrals.qualify_on_paid_invoice(conn, uid, obj, stripe)
        return "invoice_paid"
    if etype == "invoice.payment_failed":
        if obj.get("subscription"):
            upsert_subscription(conn, stripe.Subscription.retrieve(obj["subscription"]), created)
        uid = _user_for(conn, obj.get("customer"), None)
        if uid:
            conn.execute("INSERT INTO audit_log (actor, action, target) VALUES ('stripe','notify:payment_failed',%s)", (str(uid),))
        return "payment_failed"
    if etype in ("charge.refunded", "charge.dispute.created"):
        invoice = obj.get("invoice")
        if invoice is None and obj.get("charge"):
            invoice = stripe.Charge.retrieve(obj["charge"]).get("invoice")
        return f"reversed:{referrals.reverse_for_invoice(conn, invoice)}" if invoice else "no_invoice"
    return "ignored"
