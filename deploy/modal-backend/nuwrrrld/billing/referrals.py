"""Share & Earn: attribution, qualification, rewards, reversal (Section 15.4)."""
from __future__ import annotations

import datetime as dt
import json
import logging

from nuwrrrld.config import settings

log = logging.getLogger(__name__)
LATE_ATTRIBUTION_HOURS = 24
REWARD_DAYS = 30
REVERSAL_WINDOW_DAYS = 30
PAYING_STATUSES = ("active", "trialing", "past_due")


class ReferralError(Exception):
    pass


def attribute(conn, user: dict, code: str) -> dict:
    """Create the referral row once. Rejections are recorded (status=rejected) except an unknown code."""
    existing = conn.execute("SELECT * FROM referrals WHERE referred_user_id=%s", (user["id"],)).fetchone()
    if existing:
        return existing
    referrer = conn.execute("SELECT * FROM users WHERE referral_code=%s", (code,)).fetchone()
    if referrer is None:
        raise ReferralError("unknown referral code")
    reason = None
    if referrer["id"] == user["id"]:
        # The schema forbids a referral row with referrer == referred, so this rejection cannot be persisted
        # there; record it in the audit log and return the same shape the API reports for other rejections.
        conn.execute("INSERT INTO audit_log (actor, action, target) VALUES ('system','referral.rejected.self_referral',%s)", (str(user["id"]),))
        return {"status": "rejected", "reason": "self_referral", "id": None, "referrer_user_id": referrer["id"],
                "referred_user_id": user["id"]}
    elif referrer["deleted_at"] is not None or referrer["role"] == "banned":
        reason = "referrer_inactive"
    elif user["created_at"] < dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=LATE_ATTRIBUTION_HOURS):
        reason = "late_attribution"
    elif user["email"] and conn.execute(
            "SELECT 1 FROM trial_fingerprints f WHERE f.email_hash=%s AND f.user_id <> %s",
            (__import__("hashlib").sha256(user["email"].strip().lower().encode()).hexdigest(), user["id"])).fetchone():
        reason = "duplicate_email"
    status = "rejected" if reason else "pending"
    row = conn.execute(
        """INSERT INTO referrals (referrer_user_id, referred_user_id, code_used, status, reason)
           VALUES (%s,%s,%s,%s,%s) ON CONFLICT (referred_user_id) DO NOTHING RETURNING *""",
        (referrer["id"], user["id"], code, status, reason)).fetchone()
    if row and not reason:
        conn.execute("UPDATE users SET referred_by_user_id=%s WHERE id=%s", (referrer["id"], user["id"]))
    return row or conn.execute("SELECT * FROM referrals WHERE referred_user_id=%s", (user["id"],)).fetchone()


def friend_month_eligible(conn, user_id) -> dict | None:
    """The referral that entitles this user to a free first month at checkout (on_first_subscription mode)."""
    if settings().friend_reward_mode != "on_first_subscription":
        return None
    ref = conn.execute("SELECT * FROM referrals WHERE referred_user_id=%s AND status IN ('pending','qualified')", (user_id,)).fetchone()
    if ref is None:
        return None
    got = conn.execute("SELECT 1 FROM entitlement_grants WHERE user_id=%s AND kind='referral_friend' AND revoked_at IS NULL", (user_id,)).fetchone()
    had_sub = conn.execute("SELECT 1 FROM subscriptions WHERE user_id=%s", (user_id,)).fetchone()
    return None if (got or had_sub) else ref


def record_friend_grant(conn, referral: dict, stripe_ref: str | None, applied_via: str = "stripe_trial") -> None:
    conn.execute(
        """INSERT INTO entitlement_grants (user_id, kind, starts_at, ends_at, applied_via, stripe_ref, referral_id, idempotency_key)
           VALUES (%s,'referral_friend', now(), now() + make_interval(days => %s), %s, %s, %s, %s) ON CONFLICT DO NOTHING""",
        (referral["referred_user_id"], REWARD_DAYS, applied_via, stripe_ref, referral["id"], f"ref:{referral['id']}:friend"))


def grant_friend_on_signup(conn, referral: dict) -> None:
    """Alternative mode `on_signup`: free month starting when the app trial ends."""
    trial_end = conn.execute("SELECT ends_at FROM entitlement_grants WHERE user_id=%s AND kind='trial'", (referral["referred_user_id"],)).fetchone()
    start = trial_end["ends_at"] if trial_end else dt.datetime.now(dt.timezone.utc)
    conn.execute(
        """INSERT INTO entitlement_grants (user_id, kind, starts_at, ends_at, applied_via, referral_id, idempotency_key)
           VALUES (%s,'referral_friend',%s,%s + make_interval(days => %s),'app',%s,%s) ON CONFLICT DO NOTHING""",
        (referral["referred_user_id"], start, start, REWARD_DAYS, referral["id"], f"ref:{referral['id']}:friend"))


def qualify_on_paid_invoice(conn, friend_user_id, invoice: dict, stripe) -> dict | None:
    """First paid invoice (amount_paid > 0) qualifies the referral; then reward the referrer."""
    if invoice.get("amount_paid", 0) <= 0:
        return None
    paid_before = conn.execute("SELECT 1 FROM audit_log WHERE action='invoice.paid.first' AND target=%s", (str(friend_user_id),)).fetchone()
    ref = conn.execute("SELECT * FROM referrals WHERE referred_user_id=%s AND status='pending'", (friend_user_id,)).fetchone()
    if ref is None or paid_before:
        return None
    conn.execute("INSERT INTO audit_log (actor, action, target, detail) VALUES ('stripe','invoice.paid.first',%s,%s)",
                 (str(friend_user_id), json.dumps({"invoice": invoice.get("id"), "charge": invoice.get("charge")})))
    ref = conn.execute("UPDATE referrals SET status='qualified', qualified_at=now() WHERE id=%s AND status='pending' RETURNING *", (ref["id"],)).fetchone()
    if ref is None:
        return None
    return reward_referrer(conn, ref, stripe)


def _queued_access_end(conn, user_id) -> dt.datetime:
    """Latest end across grants (incl. queued) and paid subscription periods."""
    now = dt.datetime.now(dt.timezone.utc)
    g = conn.execute("SELECT max(ends_at) AS e FROM entitlement_grants WHERE user_id=%s AND revoked_at IS NULL", (user_id,)).fetchone()["e"]
    s = conn.execute("SELECT max(current_period_end) AS e FROM subscriptions WHERE user_id=%s AND status IN ('active','trialing','past_due')",
                     (user_id,)).fetchone()["e"]
    return max([x for x in (g, s, now) if x is not None])


def reward_referrer(conn, referral: dict, stripe) -> dict:
    """Idempotent on `ref:{id}:referrer` (DB) and the same key on the Stripe call."""
    key = f"ref:{referral['id']}:referrer"
    year_ago = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=365)
    count = conn.execute("SELECT count(*) AS n FROM referrals WHERE referrer_user_id=%s AND status='rewarded' AND rewarded_at > %s",
                         (referral["referrer_user_id"], year_ago)).fetchone()["n"]
    if count >= settings().referral_cap:
        return conn.execute("UPDATE referrals SET reason='cap_reached' WHERE id=%s RETURNING *", (referral["id"],)).fetchone()
    referrer = conn.execute("SELECT * FROM users WHERE id=%s", (referral["referrer_user_id"],)).fetchone()
    if referrer["deleted_at"] is not None:
        return conn.execute("UPDATE referrals SET status='rejected', reason='referrer_deleted' WHERE id=%s RETURNING *", (referral["id"],)).fetchone()
    sub = conn.execute("SELECT * FROM subscriptions WHERE user_id=%s AND status IN ('active','trialing','past_due') "
                       "ORDER BY current_period_end DESC NULLS LAST LIMIT 1", (referrer["id"],)).fetchone()
    customer = conn.execute("SELECT stripe_customer_id FROM billing_customers WHERE user_id=%s", (referrer["id"],)).fetchone()
    if sub and customer and not sub["cancel_at_period_end"]:
        price = stripe.Price.retrieve(sub["stripe_price_id"])
        txn = stripe.Customer.create_balance_transaction(
            customer["stripe_customer_id"], amount=-int(price["unit_amount"]), currency=price["currency"],
            description="Referral reward", idempotency_key=key)
        conn.execute(
            """INSERT INTO entitlement_grants (user_id, kind, starts_at, ends_at, applied_via, stripe_ref, referral_id, idempotency_key)
               VALUES (%s,'referral_referrer', now(), now() + make_interval(days => %s), 'stripe_credit', %s, %s, %s) ON CONFLICT DO NOTHING""",
            (referrer["id"], REWARD_DAYS, txn["id"], referral["id"], key))
    else:
        start = _queued_access_end(conn, referrer["id"])
        conn.execute(
            """INSERT INTO entitlement_grants (user_id, kind, starts_at, ends_at, applied_via, referral_id, idempotency_key)
               VALUES (%s,'referral_referrer', %s, %s + make_interval(days => %s), 'app', %s, %s) ON CONFLICT DO NOTHING""",
            (referrer["id"], start, start, REWARD_DAYS, referral["id"], key))
    done = conn.execute("UPDATE referrals SET status='rewarded', rewarded_at=now() WHERE id=%s RETURNING *", (referral["id"],)).fetchone()
    for uid, kind in ((referrer["id"], "referral_reward"), (referral["referred_user_id"], "referral_friend_month")):
        conn.execute("INSERT INTO audit_log (actor, action, target, detail) VALUES ('system',%s,%s,%s)",
                     (f"notify:{kind}", str(uid), json.dumps({"referral_id": str(referral["id"])})))
    return done


def reverse_for_invoice(conn, invoice_id: str) -> int:
    """Refund/dispute within 30 days: mark reversed and revoke an unstarted referrer grant; leave started grants."""
    rows = conn.execute(
        """SELECT r.* FROM referrals r JOIN audit_log a ON a.action='invoice.paid.first' AND a.target = r.referred_user_id::text
            WHERE a.detail->>'invoice' = %s AND r.status IN ('qualified','rewarded')
              AND r.qualified_at > now() - make_interval(days => %s)""", (invoice_id, REVERSAL_WINDOW_DAYS)).fetchall()
    for r in rows:
        conn.execute("UPDATE referrals SET status='reversed', reason='refund_or_dispute' WHERE id=%s", (r["id"],))
        conn.execute("UPDATE entitlement_grants SET revoked_at=now(), revoke_reason='referral_reversed' "
                     "WHERE referral_id=%s AND starts_at > now() AND revoked_at IS NULL", (r["id"],))
        conn.execute("INSERT INTO audit_log (actor, action, target) VALUES ('stripe','referral.reversed',%s)", (str(r["id"]),))
    return len(rows)
