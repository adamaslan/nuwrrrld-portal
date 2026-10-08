"""Share & Earn + Stripe/Clerk handlers against real Postgres and a recording Stripe double."""
import datetime as dt
import time

import pytest

from nuwrrrld.billing import checkout, referrals, stripe_events, users
from nuwrrrld.api.routers import webhooks
from tests.conftest import make_user

NOW = dt.datetime.now(dt.timezone.utc)


class FakeStripe:
    """Records calls; returns canned objects."""
    def __init__(self):
        self.subs, self.credits, self.charges = {}, [], {}
        outer = self

        class Subscription:
            @staticmethod
            def retrieve(sid):
                return outer.subs[sid]

        class Price:
            @staticmethod
            def retrieve(pid):
                return {"unit_amount": 2900, "currency": "usd"}

        class Customer:
            @staticmethod
            def create_balance_transaction(cid, **kw):
                outer.credits.append((cid, kw))
                return {"id": f"cbtxn_{len(outer.credits)}"}

        class Charge:
            @staticmethod
            def retrieve(cid):
                return outer.charges[cid]

        class Invoice:
            @staticmethod
            def list(**kw):
                return {"data": outer.invoices}

        self.Subscription, self.Price, self.Customer, self.Charge, self.Invoice = Subscription, Price, Customer, Charge, Invoice
        self.invoices = []


def sub_obj(sid="sub_1", customer="cus_1", status="active", uid=None, created=None, meta=None, period_end=None, cancel=False):
    end = int((period_end or NOW + dt.timedelta(days=30)).timestamp())
    return {"id": sid, "customer": customer, "status": status, "metadata": {"user_id": str(uid), **(meta or {})},
            "cancel_at_period_end": cancel, "current_period_start": int(NOW.timestamp()), "current_period_end": end,
            "items": {"data": [{"price": {"id": "price_m"}}]}, "trial_end": None, "canceled_at": None}


def evt(etype, obj, created=None):
    return {"id": f"evt_{etype}_{created}", "type": etype, "created": created or int(time.time()), "data": {"object": obj}}


@pytest.fixture()
def pair(conn):
    referrer = make_user(conn, "ref@example.com", "user_ref")
    friend = make_user(conn, "friend@example.com", "user_friend")
    return referrer, friend


# --- attribution table (15.4) ---------------------------------------------------------------------------------
def test_unknown_code_raises_without_row(conn, pair):
    with pytest.raises(referrals.ReferralError):
        referrals.attribute(conn, pair[1], "nope")
    assert conn.execute("SELECT count(*) AS n FROM referrals").fetchone()["n"] == 0


def test_valid_code_is_pending_and_idempotent(conn, pair):
    ref, friend = pair
    r1 = referrals.attribute(conn, friend, ref["referral_code"])
    r2 = referrals.attribute(conn, friend, ref["referral_code"])
    assert r1["status"] == "pending" and r1["id"] == r2["id"]
    assert conn.execute("SELECT referred_by_user_id FROM users WHERE id=%s", (friend["id"],)).fetchone()["referred_by_user_id"] == ref["id"]


def test_self_referral_rejected(conn, pair):
    r = referrals.attribute(conn, pair[0], pair[0]["referral_code"])
    assert r["status"] == "rejected" and r["reason"] == "self_referral"
    assert conn.execute("SELECT count(*) AS n FROM referrals").fetchone()["n"] == 0          # not persistable: schema CHECK
    assert conn.execute("SELECT count(*) AS n FROM audit_log WHERE action='referral.rejected.self_referral'").fetchone()["n"] == 1


def test_late_attribution_rejected(conn, pair):
    ref, friend = pair
    conn.execute("UPDATE users SET created_at = now() - interval '3 days' WHERE id=%s", (friend["id"],))
    old = conn.execute("SELECT * FROM users WHERE id=%s", (friend["id"],)).fetchone()
    assert referrals.attribute(conn, old, ref["referral_code"])["reason"] == "late_attribution"


def test_duplicate_email_rejected(conn, pair):
    ref, _ = pair
    other = make_user(conn, "ref@example.com", "user_ref2")                    # same email hash as the referrer
    assert referrals.attribute(conn, other, ref["referral_code"])["reason"] == "duplicate_email"


def test_inactive_referrer_rejected(conn, pair):
    ref, friend = pair
    conn.execute("UPDATE users SET deleted_at=now() WHERE id=%s", (ref["id"],))
    assert referrals.attribute(conn, friend, ref["referral_code"])["reason"] == "referrer_inactive"


# --- friend month ----------------------------------------------------------------------------------------------------
def test_friend_month_eligibility(conn, pair, monkeypatch):
    ref, friend = pair
    assert referrals.friend_month_eligible(conn, friend["id"]) is None          # no referral
    r = referrals.attribute(conn, friend, ref["referral_code"])
    assert referrals.friend_month_eligible(conn, friend["id"])["id"] == r["id"]
    monkeypatch.setenv("FRIEND_REWARD_MODE", "on_signup")
    assert referrals.friend_month_eligible(conn, friend["id"]) is None


def test_checkout_params_friend_trial_vs_app_trial_end(monkeypatch):
    monkeypatch.setenv("STRIPE_PRICE_ID_MONTHLY", "price_m")
    seen = {}

    class S:
        class checkout:
            class Session:
                @staticmethod
                def create(**kw):
                    seen.update(kw)
                    return {"url": "https://stripe.test/c"}
    user = {"id": "u1", "email": "f@example.com"}
    assert checkout.create_checkout_url(S, user, stripe_customer_id=None, friend_month_eligible=True, today_et="2026-10-07") == "https://stripe.test/c"
    assert seen["subscription_data"]["trial_period_days"] == 30 and seen["subscription_data"]["metadata"]["referral_friend_month"] == "1"
    assert seen["customer_email"] == "f@example.com" and seen["idempotency_key"] == "checkout:u1:2026-10-07:1"
    seen.clear()
    checkout.create_checkout_url(S, user, stripe_customer_id="cus_9", friend_month_eligible=False, today_et="2026-10-07", app_trial_end=1900000000)
    assert seen["subscription_data"]["trial_end"] == 1900000000 and seen["customer"] == "cus_9" and "customer_email" not in seen


# --- qualification + referrer reward ------------------------------------------------------------------------------------
def invoice(paid=2900, cust="cus_f", id_="in_1"):
    return {"id": id_, "amount_paid": paid, "customer": cust, "charge": "ch_1"}


def test_zero_amount_invoice_does_not_qualify(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    assert referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(0), FakeStripe()) is None
    assert conn.execute("SELECT status FROM referrals").fetchone()["status"] == "pending"


def test_first_paid_invoice_rewards_non_paying_referrer_with_stacked_grant(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    stripe = FakeStripe()
    done = referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(), stripe)
    assert done["status"] == "rewarded" and stripe.credits == []
    g = conn.execute("SELECT * FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()
    trial = conn.execute("SELECT ends_at FROM entitlement_grants WHERE user_id=%s AND kind='trial'", (ref["id"],)).fetchone()
    assert g["applied_via"] == "app" and g["starts_at"] >= trial["ends_at"] and (g["ends_at"] - g["starts_at"]).days == 30    # stacks after existing access
    # a second paid invoice must not double-reward
    assert referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(id_="in_2"), stripe) is None
    assert conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()["n"] == 1


def test_paying_referrer_gets_stripe_credit_with_idempotency_key(conn, pair):
    ref, friend = pair
    r = referrals.attribute(conn, friend, ref["referral_code"])
    conn.execute("INSERT INTO billing_customers (user_id,stripe_customer_id) VALUES (%s,'cus_ref')", (ref["id"],))
    conn.execute("INSERT INTO subscriptions (user_id,stripe_subscription_id,stripe_price_id,status,current_period_end,last_event_created) "
                 "VALUES (%s,'sub_r','price_m','active',now()+interval '20 days',now())", (ref["id"],))
    stripe = FakeStripe()
    referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(), stripe)
    cid, kw = stripe.credits[0]
    assert cid == "cus_ref" and kw["amount"] == -2900 and kw["idempotency_key"] == f"ref:{r['id']}:referrer"
    g = conn.execute("SELECT * FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()
    assert g["applied_via"] == "stripe_credit" and g["stripe_ref"] == "cbtxn_1"


def test_canceling_referrer_gets_app_grant_after_period_end_not_a_credit(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    conn.execute("INSERT INTO billing_customers (user_id,stripe_customer_id) VALUES (%s,'cus_ref')", (ref["id"],))
    conn.execute("INSERT INTO subscriptions (user_id,stripe_subscription_id,stripe_price_id,status,current_period_end,cancel_at_period_end,last_event_created) "
                 "VALUES (%s,'sub_r','price_m','active',now()+interval '20 days',true,now())", (ref["id"],))
    stripe = FakeStripe()
    referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(), stripe)
    g = conn.execute("SELECT * FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()
    sub_end = conn.execute("SELECT current_period_end FROM subscriptions").fetchone()["current_period_end"]
    assert stripe.credits == [] and g["applied_via"] == "app" and g["starts_at"] >= sub_end


def test_reward_cap_leaves_status_qualified(conn, pair, monkeypatch):
    ref, friend = pair
    monkeypatch.setenv("REFERRAL_MAX_REWARDS_PER_YEAR", "0")
    referrals.attribute(conn, friend, ref["referral_code"])
    done = referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(), FakeStripe())
    assert done["status"] == "qualified" and done["reason"] == "cap_reached"
    assert conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()["n"] == 0


def test_deleted_referrer_gets_nothing_friend_keeps_reward(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    conn.execute("UPDATE users SET deleted_at=now() WHERE id=%s", (ref["id"],))
    done = referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(), FakeStripe())
    assert done["status"] == "rejected" and done["reason"] == "referrer_deleted"


def test_reversal_revokes_unstarted_grant_but_not_a_started_one(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    referrals.qualify_on_paid_invoice(conn, friend["id"], invoice(id_="in_rev"), FakeStripe())
    assert referrals.reverse_for_invoice(conn, "in_rev") == 1
    assert conn.execute("SELECT status FROM referrals").fetchone()["status"] == "reversed"
    g = conn.execute("SELECT revoked_at FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()
    assert g["revoked_at"] is not None                                          # queued after the trial -> unstarted -> revoked
    # started grant is left alone
    conn.execute("UPDATE referrals SET status='rewarded'")
    conn.execute("UPDATE entitlement_grants SET revoked_at=NULL, starts_at=now()-interval '1 day' WHERE kind='referral_referrer'")
    referrals.reverse_for_invoice(conn, "in_rev")
    assert conn.execute("SELECT revoked_at FROM entitlement_grants WHERE kind='referral_referrer'").fetchone()["revoked_at"] is None


def test_friend_grant_on_signup_mode(conn, pair):
    ref, friend = pair
    r = referrals.attribute(conn, friend, ref["referral_code"])
    referrals.grant_friend_on_signup(conn, r)
    referrals.grant_friend_on_signup(conn, r)
    g = conn.execute("SELECT * FROM entitlement_grants WHERE kind='referral_friend'").fetchall()
    assert len(g) == 1 and g[0]["applied_via"] == "app"


# --- Stripe dispatch -----------------------------------------------------------------------------------------------------
def test_checkout_completed_links_customer_subscription_and_friend_grant(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    s = FakeStripe()
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "trialing", friend["id"], meta={"referral_friend_month": "1"})
    stripe_events.dispatch(conn, evt("checkout.session.completed", {"id": "cs_1", "client_reference_id": str(friend["id"]),
                                                                    "customer": "cus_f", "subscription": "sub_f", "metadata": {}}), s)
    assert conn.execute("SELECT stripe_customer_id FROM billing_customers WHERE user_id=%s", (friend["id"],)).fetchone()["stripe_customer_id"] == "cus_f"
    assert conn.execute("SELECT status FROM subscriptions").fetchone()["status"] == "trialing"
    g = conn.execute("SELECT * FROM entitlement_grants WHERE kind='referral_friend'").fetchone()
    assert g["applied_via"] == "stripe_trial" and g["stripe_ref"] == "cs_1"
    assert referrals.friend_month_eligible(conn, friend["id"]) is None            # already used


def test_out_of_order_subscription_events_do_not_regress_state(conn, pair):
    _, friend = pair
    s = FakeStripe()
    conn.execute("INSERT INTO billing_customers (user_id,stripe_customer_id) VALUES (%s,'cus_f')", (friend["id"],))
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "active", friend["id"])
    stripe_events.dispatch(conn, evt("customer.subscription.updated", s.subs["sub_f"], created=2000), s)
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "past_due", friend["id"])         # a STALE event arrives late
    stripe_events.dispatch(conn, evt("customer.subscription.updated", s.subs["sub_f"], created=1000), s)
    assert conn.execute("SELECT status FROM subscriptions").fetchone()["status"] == "active"
    stripe_events.dispatch(conn, evt("customer.subscription.updated", s.subs["sub_f"], created=3000), s)
    assert conn.execute("SELECT status FROM subscriptions").fetchone()["status"] == "past_due"


def test_subscription_grants_access_and_past_due_keeps_it(conn, pair):
    _, friend = pair
    conn.execute("DELETE FROM entitlement_grants WHERE user_id=%s", (friend["id"],))
    assert conn.execute("SELECT access_until FROM user_access WHERE user_id=%s", (friend["id"],)).fetchone()["access_until"] is None
    s = FakeStripe()
    conn.execute("INSERT INTO billing_customers (user_id,stripe_customer_id) VALUES (%s,'cus_f')", (friend["id"],))
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "past_due", friend["id"])
    stripe_events.dispatch(conn, evt("invoice.payment_failed", {"subscription": "sub_f", "customer": "cus_f"}, created=5), s)
    assert conn.execute("SELECT access_until FROM user_access WHERE user_id=%s", (friend["id"],)).fetchone()["access_until"] > NOW
    assert conn.execute("SELECT count(*) AS n FROM audit_log WHERE action='notify:payment_failed'").fetchone()["n"] == 1
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "canceled", friend["id"])
    stripe_events.dispatch(conn, evt("customer.subscription.deleted", s.subs["sub_f"], created=9), s)
    assert conn.execute("SELECT access_until FROM user_access WHERE user_id=%s", (friend["id"],)).fetchone()["access_until"] is None


def test_invoice_paid_dispatch_qualifies_and_refund_reverses(conn, pair):
    ref, friend = pair
    referrals.attribute(conn, friend, ref["referral_code"])
    conn.execute("INSERT INTO billing_customers (user_id,stripe_customer_id) VALUES (%s,'cus_f')", (friend["id"],))
    s = FakeStripe()
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "active", friend["id"])
    stripe_events.dispatch(conn, evt("invoice.paid", {"id": "in_9", "subscription": "sub_f", "customer": "cus_f", "amount_paid": 2900, "charge": "ch_9"}, created=10), s)
    assert conn.execute("SELECT status FROM referrals").fetchone()["status"] == "rewarded"
    s.charges["ch_9"] = {"invoice": "in_9"}
    out = stripe_events.dispatch(conn, evt("charge.refunded", {"id": "ch_9", "invoice": "in_9"}, created=20), s)
    assert out == "reversed:1" and conn.execute("SELECT status FROM referrals").fetchone()["status"] == "reversed"


def test_unknown_event_ignored(conn):
    assert stripe_events.dispatch(conn, evt("customer.created", {}), FakeStripe()) == "ignored"


# --- Clerk / webhook ledger ------------------------------------------------------------------------------------------------
CLERK_USER = {"id": "user_new", "first_name": "Ada", "last_name": "L", "primary_email_address_id": "e1",
              "email_addresses": [{"id": "e1", "email_address": "ada@example.com", "verification": {"status": "verified"}}]}


def test_clerk_upsert_creates_user_trial_and_updates(conn):
    u = users.upsert_from_clerk(conn, CLERK_USER)
    assert u["email_verified"] and u["display_name"] == "Ada L" and u["referral_code"]
    assert conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE kind='trial'").fetchone()["n"] == 1
    users.upsert_from_clerk(conn, {**CLERK_USER, "first_name": "Adaline"})
    assert conn.execute("SELECT count(*) AS n FROM users").fetchone()["n"] == 1
    assert conn.execute("SELECT display_name FROM users").fetchone()["display_name"] == "Adaline L"


def test_clerk_delete_locks_out_then_purge_removes_personal_data(conn):
    u = users.upsert_from_clerk(conn, CLERK_USER)
    conn.execute("INSERT INTO instruments (ticker,name,asset_type) VALUES ('XLE','x','etf')")
    conn.execute("INSERT INTO holdings (user_id,ticker,quantity) VALUES (%s,'XLE',5)", (u["id"],))
    conn.execute("INSERT INTO llm_usage (user_id,feature,provider,model,input_tokens,output_tokens) VALUES (%s,'chat','p','m',1,1)", (u["id"],))
    users.soft_delete(conn, "user_new")
    assert conn.execute("SELECT deleted_at FROM users").fetchone()["deleted_at"] is not None
    assert users.purge_deleted(conn) == 0                                         # inside the 24h lockout window
    conn.execute("UPDATE users SET deleted_at = now() - interval '2 days'")
    assert users.purge_deleted(conn) == 1
    assert conn.execute("SELECT count(*) AS n FROM holdings").fetchone()["n"] == 0
    assert conn.execute("SELECT user_id FROM llm_usage").fetchone()["user_id"] is None
    assert conn.execute("SELECT email FROM users").fetchone()["email"] is None


def test_webhook_ledger_duplicates_and_failures(conn):
    assert webhooks.begin(conn, "stripe", "evt_1", "x", {"a": 1}) is True
    webhooks.done(conn, "stripe", "evt_1")
    assert webhooks.begin(conn, "stripe", "evt_1", "x", {"a": 1}) is False        # processed -> duplicate

    with pytest.raises(RuntimeError):
        webhooks._process(conn, "clerk", "svix_1", "user.created", {}, lambda c: (_ for _ in ()).throw(RuntimeError("bad")))
    row = conn.execute("SELECT attempts, last_error, processed_at FROM webhook_events WHERE event_id='svix_1'").fetchone()
    assert row["attempts"] == 1 and "bad" in row["last_error"] and row["processed_at"] is None
    assert webhooks._process(conn, "clerk", "svix_1", "user.created", {}, lambda c: None) == {"ok": True}     # redelivery succeeds
    assert webhooks._process(conn, "clerk", "svix_1", "user.created", {}, lambda c: None)["duplicate"] is True


def test_billing_reconcile_replays_unprocessed_and_repairs_drift(conn, pair):
    from nuwrrrld.jobs import billing_jobs
    _, friend = pair
    conn.execute("INSERT INTO billing_customers (user_id,stripe_customer_id) VALUES (%s,'cus_f')", (friend["id"],))
    s = FakeStripe()
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "active", friend["id"])
    e = evt("customer.subscription.created", s.subs["sub_f"], created=100)
    webhooks.begin(conn, "stripe", e["id"], e["type"], e)
    conn.execute("UPDATE webhook_events SET received_at = now() - interval '1 hour'")
    out = billing_jobs.billing_reconcile(conn, s)
    assert out["replayed"] == 1 and conn.execute("SELECT status FROM subscriptions").fetchone()["status"] == "active"
    s.subs["sub_f"] = sub_obj("sub_f", "cus_f", "canceled", friend["id"])
    assert billing_jobs.billing_reconcile(conn, s)["drift_repaired"] == 1


def test_trial_sweeper_notices_once(conn):
    from nuwrrrld.jobs import billing_jobs
    u = make_user(conn)
    conn.execute("UPDATE entitlement_grants SET ends_at = now() + interval '47 hours 30 minutes' WHERE user_id=%s", (u["id"],))
    assert billing_jobs.trial_sweeper(conn, "h1")["notices"] == 1
    assert billing_jobs.trial_sweeper(conn, "h2")["notices"] == 0
