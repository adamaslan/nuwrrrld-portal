"""trial_sweeper, billing_reconcile, referral_qualifier (Sections 7, 15)."""
from __future__ import annotations

import json
import logging

from nuwrrrld.billing import referrals, stripe_events

log = logging.getLogger(__name__)
NOTICE_WINDOWS_HOURS = (48, 24)


def trial_sweeper(conn, hour_key: str) -> dict:
    """Trial-ending notices at T-48h and T-24h; each (user, window) is recorded once."""
    sent = 0
    for hours in NOTICE_WINDOWS_HOURS:
        rows = conn.execute(
            """SELECT g.user_id FROM entitlement_grants g
                WHERE g.kind='trial' AND g.revoked_at IS NULL
                  AND g.ends_at BETWEEN now() + make_interval(hours => %s - 1) AND now() + make_interval(hours => %s)
                  AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id=g.user_id AND s.status IN ('active','trialing'))""",
            (hours, hours)).fetchall()
        for r in rows:
            action = f"notify:trial_ending_{hours}h"
            if not conn.execute("SELECT 1 FROM audit_log WHERE action=%s AND target=%s", (action, str(r["user_id"]))).fetchone():
                conn.execute("INSERT INTO audit_log (actor, action, target, detail) VALUES ('system',%s,%s,%s)",
                             (action, str(r["user_id"]), json.dumps({"hour": hour_key})))
                sent += 1
    expired = conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE kind='trial' AND ends_at < now() AND ends_at > now() - interval '1 hour'").fetchone()["n"]
    return {"notices": sent, "expired_trials_last_hour": expired}


def billing_reconcile(conn, stripe) -> dict:
    """Repair subscription drift from Stripe and replay unprocessed webhook events."""
    replayed = failed = 0
    for ev in conn.execute("SELECT provider, event_id, payload FROM webhook_events WHERE provider='stripe' AND processed_at IS NULL "
                           "AND received_at < now() - interval '10 minutes' ORDER BY received_at LIMIT 200").fetchall():
        try:
            stripe_events.dispatch(conn, ev["payload"], stripe)
            conn.execute("UPDATE webhook_events SET processed_at=now(), attempts=attempts+1, last_error=NULL WHERE provider=%s AND event_id=%s",
                         (ev["provider"], ev["event_id"]))
            replayed += 1
        except Exception as exc:  # keep reconciling the rest
            conn.execute("UPDATE webhook_events SET attempts=attempts+1, last_error=%s WHERE provider=%s AND event_id=%s",
                         (repr(exc)[:2000], ev["provider"], ev["event_id"]))
            failed += 1
    drift = 0
    for sub in conn.execute("SELECT stripe_subscription_id, status FROM subscriptions WHERE status IN ('active','trialing','past_due','incomplete')").fetchall():
        live = stripe.Subscription.retrieve(sub["stripe_subscription_id"])
        if live["status"] != sub["status"]:
            stripe_events.upsert_subscription(conn, live, int(__import__("time").time()))
            drift += 1
    return {"replayed": replayed, "replay_failed": failed, "drift_repaired": drift}


def referral_qualifier(conn, stripe) -> dict:
    """Catch-up for referrals whose invoice.paid webhook was missed: look at the friend's Stripe invoices."""
    qualified = 0
    for ref in conn.execute("SELECT * FROM referrals WHERE status='pending'").fetchall():
        cust = conn.execute("SELECT stripe_customer_id FROM billing_customers WHERE user_id=%s", (ref["referred_user_id"],)).fetchone()
        if not cust:
            continue
        for inv in stripe.Invoice.list(customer=cust["stripe_customer_id"], status="paid", limit=5)["data"]:
            if referrals.qualify_on_paid_invoice(conn, ref["referred_user_id"], inv, stripe):
                qualified += 1
                break
    rewarded = 0
    for ref in conn.execute("SELECT * FROM referrals WHERE status='qualified' AND COALESCE(reason,'') <> 'cap_reached'").fetchall():
        referrals.reward_referrer(conn, ref, stripe)
        rewarded += 1
    return {"qualified": qualified, "rewarded": rewarded}
