"""Real-Postgres tests: schema, idempotency guard, exactly-once fills, rebuild, immutability."""
import datetime as dt
import json
from decimal import Decimal as D

import psycopg
import pytest

from nuwrrrld.core.paper import fills, sizing
from nuwrrrld.jobs.runner import run_job
from tests.conftest import make_user

pytestmark = pytest.mark.usefixtures("conn")


def test_schema_has_all_tables_and_view(conn):
    n = conn.execute("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'").fetchone()["n"]
    assert n >= 45
    assert conn.execute("SELECT count(*) AS n FROM information_schema.views WHERE table_name='user_access'").fetchone()["n"] == 1


# --- run_job -----------------------------------------------------------------------------------
def test_run_job_claims_once_and_skips_succeeded(conn):
    with run_job(conn, "j", "k1") as ctx:
        assert ctx is not None
    with run_job(conn, "j", "k1") as ctx:
        assert ctx is None                                  # already succeeded
    assert conn.execute("SELECT status FROM job_runs WHERE job_name='j'").fetchone()["status"] == "succeeded"


def test_run_job_failed_is_retaken_with_attempt_counter(conn):
    with pytest.raises(RuntimeError):
        with run_job(conn, "j", "k2"):
            raise RuntimeError("boom")
    row = conn.execute("SELECT status, attempt, error FROM job_runs WHERE job_name='j' AND run_key='k2'").fetchone()
    assert row["status"] == "failed" and "boom" in row["error"]
    with run_job(conn, "j", "k2") as ctx:
        assert ctx is not None
    assert conn.execute("SELECT attempt FROM job_runs WHERE run_key='k2'").fetchone()["attempt"] == 2


def test_run_job_fresh_running_blocks_but_stale_is_taken_over(conn):
    cm = run_job(conn, "j", "k3")
    ctx = cm.__enter__()
    with run_job(conn, "j", "k3") as other:
        assert other is None                                # another container owns it
    conn.execute("UPDATE job_runs SET heartbeat_at = now() - interval '2 hours' WHERE run_key='k3'")
    with run_job(conn, "j", "k3") as taken:
        assert taken is not None
    cm.__exit__(None, None, None)


def test_run_job_skip_and_force(conn):
    with run_job(conn, "j", "k4") as ctx:
        ctx.skip("market closed")
    assert conn.execute("SELECT status, detail FROM job_runs WHERE run_key='k4'").fetchone()["status"] == "skipped"
    with run_job(conn, "j", "k4", force=True) as ctx:
        assert ctx is not None


# --- paper engine ---------------------------------------------------------------------------------
def make_portfolio(conn, universe_rows, cash=100000):
    conn.execute("INSERT INTO paper_portfolios (owner_type,cadence,name,starting_cash,cash,rules,inception_date,peak_equity) "
                 "VALUES ('council','daily','P1',%s,%s,%s,'2026-01-01',%s)", (cash, cash, json.dumps(sizing.DEFAULT_RULES), cash))
    return conn.execute("SELECT * FROM paper_portfolios WHERE name='P1'").fetchone()


def make_order(conn, pf, side="buy", qty=10, intent="open", ticker="XLE", inval=None, key=None, decision="2026-10-06", target="2026-10-07"):
    return conn.execute(
        """INSERT INTO paper_orders (portfolio_id,ticker,side,quantity,order_type,intent,decision_date,target_session,expires_session,
                                     invalidation_price,status,idempotency_key)
           VALUES (%s,%s,%s,%s,'market_on_open',%s,%s,%s,%s,%s,'pending',%s) RETURNING *""",
        (pf["id"], ticker, side, qty, intent, decision, target, target, inval, key or f"{pf['id']}:{decision}:{ticker}:{intent}:{side}")).fetchone()


def test_fill_is_exactly_once(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    o = make_order(conn, pf, qty=10, inval=D(90))
    r1 = fills.fill_order(conn, o["id"], D(100), None, sizing.DEFAULT_RULES, dt.date(2026, 10, 7), "test")
    r2 = fills.fill_order(conn, o["id"], D(100), None, sizing.DEFAULT_RULES, dt.date(2026, 10, 7), "test")
    assert r1 is not None and r2 is None
    assert conn.execute("SELECT count(*) AS n FROM paper_fills").fetchone()["n"] == 1
    pos = conn.execute("SELECT * FROM paper_positions").fetchone()
    assert pos["quantity"] == 10 and pos["invalidation_price"] == 90
    # buy at 100 * (1 + 6bps) = 100.06 -> cash 100000 - 1000.60
    assert conn.execute("SELECT cash FROM paper_portfolios").fetchone()["cash"] == D("98999.40")


def test_one_fill_per_order_is_a_db_constraint(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    o = make_order(conn, pf)
    fills.fill_order(conn, o["id"], D(100), None, sizing.DEFAULT_RULES, dt.date(2026, 10, 7), "t")
    with pytest.raises(psycopg.errors.UniqueViolation):
        conn.execute("INSERT INTO paper_fills (order_id,portfolio_id,ticker,side,quantity,reference_price,fill_price,slippage_bps,session_date,price_source) "
                     "VALUES (%s,%s,'XLE','buy',1,100,100,5,'2026-10-07','t')", (o["id"], pf["id"]))


def test_no_lookahead_is_a_db_check(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    with pytest.raises(psycopg.errors.CheckViolation):
        make_order(conn, pf, decision="2026-10-07", target="2026-10-07")


def test_crash_before_commit_leaves_order_pending_then_retry_fills_once(conn, universe_rows, monkeypatch):
    pf = make_portfolio(conn, universe_rows)
    o = make_order(conn, pf)
    real = fills.apply_fill

    def boom(*a, **k):
        raise RuntimeError("crash mid-fill")
    monkeypatch.setattr(fills, "apply_fill", boom)
    with pytest.raises(RuntimeError):
        fills.fill_order(conn, o["id"], D(100), None, sizing.DEFAULT_RULES, dt.date(2026, 10, 7), "t")
    assert conn.execute("SELECT status FROM paper_orders WHERE id=%s", (o["id"],)).fetchone()["status"] == "pending"
    assert conn.execute("SELECT count(*) AS n FROM paper_fills").fetchone()["n"] == 0        # rolled back
    monkeypatch.setattr(fills, "apply_fill", real)
    assert fills.fill_order(conn, o["id"], D(100), None, sizing.DEFAULT_RULES, dt.date(2026, 10, 7), "t") is not None
    assert conn.execute("SELECT count(*) AS n FROM paper_fills").fetchone()["n"] == 1


def test_open_add_reduce_flip_close_then_rebuild_matches(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    d = dt.date(2026, 10, 7)
    steps = [("buy", 10, "open", 100), ("buy", 10, "increase", 110), ("sell", 5, "reduce", 120),
             ("sell", 15, "close", 130), ("sell_short", 8, "open", 125), ("buy_to_cover", 3, "reduce", 120)]
    for i, (side, qty, intent, px) in enumerate(steps):
        o = make_order(conn, pf, side=side, qty=qty, intent=intent, key=f"k{i}")
        fills.fill_order(conn, o["id"], D(px), None, sizing.DEFAULT_RULES, d, "t")
    pos = conn.execute("SELECT quantity FROM paper_positions").fetchone()
    assert pos["quantity"] == -5
    assert fills.verify_rebuild(conn, pf["id"]) == []


def test_verify_rebuild_detects_tampering(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    fills.fill_order(conn, make_order(conn, pf)["id"], D(100), None, sizing.DEFAULT_RULES, dt.date(2026, 10, 7), "t")
    conn.execute("UPDATE paper_positions SET quantity = quantity + 1")
    issues = fills.verify_rebuild(conn, pf["id"])
    assert issues and "XLE" in issues[0]


def test_stop_only_tightens_on_increase(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    d = dt.date(2026, 10, 7)
    fills.fill_order(conn, make_order(conn, pf, qty=10, inval=D(90), key="a")["id"], D(100), None, sizing.DEFAULT_RULES, d, "t")
    fills.fill_order(conn, make_order(conn, pf, qty=5, intent="increase", inval=D(85), key="b")["id"], D(100), None, sizing.DEFAULT_RULES, d, "t")
    assert conn.execute("SELECT invalidation_price FROM paper_positions").fetchone()["invalidation_price"] == 90   # looser stop ignored
    fills.fill_order(conn, make_order(conn, pf, qty=5, intent="increase", inval=D(95), key="c")["id"], D(100), None, sizing.DEFAULT_RULES, d, "t")
    assert conn.execute("SELECT invalidation_price FROM paper_positions").fetchone()["invalidation_price"] == 95


def test_order_idempotency_key_is_unique(conn, universe_rows):
    pf = make_portfolio(conn, universe_rows)
    make_order(conn, pf, key="same")
    with pytest.raises(psycopg.errors.UniqueViolation):
        make_order(conn, pf, key="same")


# --- followed immutability ---------------------------------------------------------------------------
def test_followed_tables_are_immutable(conn, universe_rows):
    conn.execute("INSERT INTO signal_runs (as_of_date,engine_version,status) VALUES ('2026-10-06','1','published')")
    run = conn.execute("SELECT id FROM signal_runs").fetchone()
    conn.execute("INSERT INTO followed_batches (batch_month,freeze_session,source_signal_run,selection_rules) VALUES ('2026-10-01','2026-10-07',%s,'{}')", (run["id"],))
    b = conn.execute("SELECT id FROM followed_batches").fetchone()
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("UPDATE followed_batches SET selection_rules='{\"x\":1}' WHERE id=%s", (b["id"],))
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("DELETE FROM followed_batches WHERE id=%s", (b["id"],))


# --- access view + grants -------------------------------------------------------------------------------
def test_trial_grant_is_idempotent_and_grants_access(conn):
    from nuwrrrld.billing import users
    u = make_user(conn)
    users.grant_trial(conn, u["id"], "a@example.com")
    users.grant_trial(conn, u["id"], "a@example.com")
    assert conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE kind='trial'").fetchone()["n"] == 1
    until = conn.execute("SELECT access_until FROM user_access WHERE user_id=%s", (u["id"],)).fetchone()["access_until"]
    assert until > dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=6)


def test_second_account_same_email_gets_no_trial(conn):
    from nuwrrrld.billing import users
    first = make_user(conn, "dup@example.com", "user_1")
    second = make_user(conn, "Dup@Example.com", "user_2")
    assert conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE user_id=%s", (first["id"],)).fetchone()["n"] == 1
    assert conn.execute("SELECT count(*) AS n FROM entitlement_grants WHERE user_id=%s", (second["id"],)).fetchone()["n"] == 0


def test_get_or_create_is_idempotent_and_referral_codes_unique(conn):
    a = make_user(conn, "x@example.com", "user_x")
    again = make_user(conn, "x@example.com", "user_x")
    b = make_user(conn, "y@example.com", "user_y")
    assert a["id"] == again["id"] and a["referral_code"] != b["referral_code"]
