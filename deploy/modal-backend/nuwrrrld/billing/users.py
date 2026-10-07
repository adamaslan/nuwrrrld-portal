"""Users, referral codes and the 7-day no-card trial (Sections 14, 15.2). Shared by webhook + lazy-upsert paths."""
from __future__ import annotations

import hashlib
import secrets

TRIAL_DAYS = 7
REFERRAL_CODE_BYTES = 6
MAX_CODE_ATTEMPTS = 5


def email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()


def new_referral_code() -> str:
    return secrets.token_urlsafe(REFERRAL_CODE_BYTES).replace("-", "x").replace("_", "y").lower()


def grant_trial(conn, user_id, email: str | None) -> bool:
    """Idempotent. A refused trial (fingerprint already used by another account) returns False."""
    if email:
        h = email_hash(email)
        conn.execute("INSERT INTO trial_fingerprints (email_hash, user_id) VALUES (%s,%s) ON CONFLICT DO NOTHING", (h, user_id))
        owner = conn.execute("SELECT user_id FROM trial_fingerprints WHERE email_hash=%s", (h,)).fetchone()
        if owner and owner["user_id"] != user_id:
            return False
    conn.execute(
        """INSERT INTO entitlement_grants (user_id, kind, starts_at, ends_at, idempotency_key)
           VALUES (%s,'trial', now(), now() + make_interval(days => %s), %s) ON CONFLICT DO NOTHING""",
        (user_id, TRIAL_DAYS, f"trial:{user_id}"))
    return True


def get_or_create_by_clerk_id(conn, clerk_user_id: str, email: str | None = None, display_name: str | None = None) -> dict:
    row = conn.execute("SELECT * FROM users WHERE clerk_user_id=%s", (clerk_user_id,)).fetchone()
    if row:
        return row
    for _ in range(MAX_CODE_ATTEMPTS):
        row = conn.execute(
            """INSERT INTO users (clerk_user_id, email, display_name, referral_code) VALUES (%s,%s,%s,%s)
               ON CONFLICT DO NOTHING RETURNING *""", (clerk_user_id, email, display_name, new_referral_code())).fetchone()
        if row:
            grant_trial(conn, row["id"], email)
            return row
        existing = conn.execute("SELECT * FROM users WHERE clerk_user_id=%s", (clerk_user_id,)).fetchone()
        if existing:          # lost a race with the webhook path
            return existing
    raise RuntimeError("could not allocate a unique referral code")


def _primary_email(data: dict) -> tuple[str | None, bool]:
    primary = data.get("primary_email_address_id")
    for e in data.get("email_addresses", []):
        if e.get("id") == primary:
            return e.get("email_address"), (e.get("verification") or {}).get("status") == "verified"
    emails = data.get("email_addresses") or []
    return (emails[0].get("email_address"), False) if emails else (None, False)


def upsert_from_clerk(conn, data: dict) -> dict:
    email, verified = _primary_email(data)
    name = " ".join(x for x in (data.get("first_name"), data.get("last_name")) if x) or None
    user = get_or_create_by_clerk_id(conn, data["id"], email, name)
    return conn.execute(
        "UPDATE users SET email=COALESCE(%s,email), email_verified=%s, display_name=COALESCE(%s,display_name) WHERE id=%s RETURNING *",
        (email, verified, name, user["id"])).fetchone()


def soft_delete(conn, clerk_user_id: str) -> None:
    conn.execute("UPDATE users SET deleted_at=now() WHERE clerk_user_id=%s AND deleted_at IS NULL", (clerk_user_id,))
    conn.execute("INSERT INTO audit_log (actor, action, target) VALUES ('clerk','user.deleted',%s)", (clerk_user_id,))


def purge_deleted(conn, older_than_hours: int = 24) -> int:
    """Within 24h of deletion: hard-delete personal data (FK cascades); keep billing; anonymize usage."""
    rows = conn.execute("SELECT id FROM users WHERE deleted_at < now() - make_interval(hours => %s)", (older_than_hours,)).fetchall()
    for r in rows:
        uid = r["id"]
        conn.execute("UPDATE llm_usage SET user_id=NULL WHERE user_id=%s", (uid,))
        for table in ("holdings", "watchlists", "user_alerts", "chat_threads", "portfolio_health_checks", "user_llm_budgets"):
            conn.execute(f"DELETE FROM {table} WHERE user_id=%s", (uid,))   # table names are literals above
        conn.execute("DELETE FROM hold_fold_verdicts WHERE user_id=%s", (uid,))
        conn.execute("UPDATE users SET email=NULL, display_name=NULL WHERE id=%s", (uid,))
    return len(rows)


def access_until(conn, user_id) -> object:
    return conn.execute("SELECT access_until FROM user_access WHERE user_id=%s", (user_id,)).fetchone()
