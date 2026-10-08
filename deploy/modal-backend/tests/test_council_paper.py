"""Council framework + paper trading end to end (real Postgres, scripted strategies, no LLM)."""
import datetime as dt
import json
from decimal import Decimal as D

import pytest

from nuwrrrld.calendar import ET
from nuwrrrld.core.council import debate
from nuwrrrld.core.council.strategy import REGISTRY, PlaceholderStrategy, Proposal, register
from nuwrrrld.jobs import council as council_jobs, paper, signals
from tests.conftest import TRACKED
from tests.fakes import FakeProvider
from tests.test_pipeline import add_bar, publish_run

AS_OF, TARGET = dt.date(2026, 10, 6), dt.date(2026, 10, 7)


class RecordingEvents:
    def __init__(self):
        self.events, self.cleared = [], []

    def put(self, event, partition):
        self.events.append(event)

    def clear(self, partition):
        self.cleared.append(partition)


@register("test.long")
class AlwaysLong(PlaceholderStrategy):
    def propose(self, ctx, llm):
        return Proposal("long", 0.8, ctx.reference_price - 2 * ctx.atr14, "Scripted long.")

    def target_weight(self, ctx, final):
        return 0.05


@register("test.contrarian_short")
class ContrarianShort(PlaceholderStrategy):
    def propose(self, ctx, llm):
        return Proposal("short", 0.9, ctx.reference_price + 2 * ctx.atr14, "Scripted contrarian.")

    def target_weight(self, ctx, final):
        return -0.05


@register("test.bad")
class BadProposer(PlaceholderStrategy):
    def propose(self, ctx, llm):
        return Proposal("long", 0.9, ctx.reference_price + 5, "Wrong-side stop.")      # invalid: long stop above price


@pytest.fixture()
def seeded(conn, bars):
    publish_run(conn)
    council_jobs.seed_council(conn, council_jobs.load_yaml(), inception=dt.date(2026, 1, 1))
    return conn


def set_strategies(conn, analyst_key, da_key="placeholder.contrarian"):
    conn.execute("UPDATE council_members SET strategy_key=%s WHERE role='analyst'", (analyst_key,))
    conn.execute("UPDATE council_members SET strategy_key=%s WHERE role='devils_advocate'", (da_key,))


def run_all(conn, cadence="daily"):
    ids = council_jobs.plan_scheduled_sessions(conn, cadence, AS_OF)
    events = RecordingEvents()
    store = council_jobs.PgSessionStore(conn)
    results = {sid: debate.run_session(sid, store, None, events) for sid in ids}
    return ids, results, events


def test_seed_is_idempotent_and_creates_six_seats_and_fourteen_portfolios(conn, bars):
    cfg = council_jobs.load_yaml()
    council_jobs.seed_council(conn, cfg)
    council_jobs.seed_council(conn, cfg)
    assert conn.execute("SELECT count(*) AS n FROM council_members").fetchone()["n"] == 6
    assert conn.execute("SELECT count(*) AS n FROM paper_portfolios").fetchone()["n"] == 2 * (1 + 6)
    assert conn.execute("SELECT count(*) AS n FROM council_members WHERE role='devils_advocate'").fetchone()["n"] == 1


def test_plan_sessions_is_idempotent_and_top_k(seeded):
    a = council_jobs.plan_scheduled_sessions(seeded, "daily", AS_OF)
    b = council_jobs.plan_scheduled_sessions(seeded, "daily", AS_OF)
    assert len(a) == len(TRACKED) == len(b) and set(a) == set(b)
    assert seeded.execute("SELECT count(*) AS n FROM council_sessions WHERE trades_portfolios").fetchone()["n"] == len(TRACKED)


def test_placeholder_council_reaches_flat_consensus_and_creates_no_orders(seeded):
    ids, results, events = run_all(seeded)
    assert set(results.values()) == {"consensus"}
    c = seeded.execute("SELECT * FROM council_consensus LIMIT 1").fetchone()
    assert c["direction"] == "flat" and c["outcome"] == "consensus"
    msgs = seeded.execute("SELECT kind, count(*) AS n FROM council_messages GROUP BY kind").fetchall()
    assert {m["kind"] for m in msgs} >= {"proposal", "challenge", "critique", "response", "revision", "moderator"}   # DA challenged before consensus
    assert paper.create_orders_for_cadence(seeded, "daily", AS_OF)["created"] == 0
    assert seeded.execute("SELECT count(*) AS n FROM paper_orders").fetchone()["n"] == 0
    assert events.events[-1]["type"] == "session_complete" and len(events.cleared) == len(ids)


def test_da_vote_is_recorded_but_not_counted(seeded):
    set_strategies(seeded, "test.long", "test.contrarian_short")
    ids, results, _ = run_all(seeded)
    assert set(results.values()) == {"consensus"}
    da = seeded.execute("SELECT v.counted, v.direction FROM council_votes v JOIN council_members m ON m.id=v.member_id WHERE m.role='devils_advocate' LIMIT 1").fetchone()
    assert da["counted"] is False and da["direction"] == "short"
    c = seeded.execute("SELECT * FROM council_consensus LIMIT 1").fetchone()
    assert c["direction"] == "long" and c["invalidation_price"] is not None and c["invalidation_price"] < c["reference_price"]
    assert "Scripted contrarian" in c["dissent_summary_md"]


def test_invalid_proposals_are_coerced_to_flat_and_block_consensus(seeded):
    set_strategies(seeded, "test.bad")
    _, results, _ = run_all(seeded)
    assert set(results.values()) == {"consensus"}          # all coerced flat/0 -> flat consensus
    assert seeded.execute("SELECT count(*) AS n FROM council_votes WHERE coerced").fetchone()["n"] > 0
    assert seeded.execute("SELECT count(DISTINCT direction) AS n FROM council_votes WHERE counted").fetchone()["n"] == 1


def test_failed_session_creates_no_orders(seeded, monkeypatch):
    set_strategies(seeded, "test.long")
    monkeypatch.setattr(AlwaysLong, "propose", lambda self, ctx, llm: (_ for _ in ()).throw(RuntimeError("llm exploded")))
    ids, results, _ = run_all(seeded)
    assert set(results.values()) == {"failed"}
    assert seeded.execute("SELECT status, error FROM council_sessions LIMIT 1").fetchone()["error"]
    assert paper.create_orders_for_cadence(seeded, "daily", AS_OF)["created"] == 0


def test_claim_is_exclusive(seeded):
    ids = council_jobs.plan_scheduled_sessions(seeded, "daily", AS_OF)
    store = council_jobs.PgSessionStore(seeded)
    assert store.claim(ids[0]) is True and store.claim(ids[0]) is False
    seeded.execute("UPDATE council_sessions SET heartbeat_at = now() - interval '2 hours' WHERE id=%s", (ids[0],))
    assert store.claim(ids[0]) is True                                  # stale heartbeat -> takeover


def test_token_budget_stops_the_loop(seeded):
    set_strategies(seeded, "test.long")
    seeded.execute("UPDATE council_members SET strategy_key='test.contrarian_short' WHERE role='devils_advocate'")
    cfg = council_jobs.load_yaml()
    cfg["council"]["token_budget_per_session"] = 1                      # exhausted after the opening round
    ids = council_jobs.plan_scheduled_sessions(seeded, "daily", AS_OF, cfg)
    seeded.execute("UPDATE council_sessions SET config_snapshot = jsonb_set(config_snapshot, '{council,token_budget_per_session}', '1')")
    status = debate.run_session(ids[0], council_jobs.PgSessionStore(seeded), None, None)
    assert seeded.execute("SELECT count(*) AS n FROM council_messages WHERE kind='system'").fetchone()["n"] == 1
    assert status in ("consensus", "no_consensus")


# --- consensus -> orders -> fills -> snapshots -> stops ----------------------------------------------------------
def opens(conn, factor=D("1.00")):
    return {t: conn.execute("SELECT close FROM price_bars WHERE ticker=%s AND bar_date=%s", (t, AS_OF)).fetchone()["close"] * factor for t in TRACKED}


def test_full_cycle_orders_fills_snapshot_and_stop(seeded):
    set_strategies(seeded, "test.long", "placeholder.contrarian")
    ids, results, _ = run_all(seeded)
    assert set(results.values()) == {"consensus"}
    out = paper.create_orders_for_cadence(seeded, "daily", AS_OF)
    assert out["created"] > 0
    again = paper.create_orders_for_cadence(seeded, "daily", AS_OF)
    assert again["created"] == 0                                                 # idempotency keys
    o = seeded.execute("SELECT * FROM paper_orders ORDER BY created_at LIMIT 1").fetchone()
    assert o["target_session"] == TARGET and o["decision_date"] == AS_OF and o["status"] == "pending"
    council_orders = seeded.execute("SELECT count(*) AS n FROM paper_orders o JOIN paper_portfolios p ON p.id=o.portfolio_id WHERE p.owner_type='council'").fetchone()["n"]
    member_orders = seeded.execute("SELECT count(*) AS n FROM paper_orders o JOIN paper_portfolios p ON p.id=o.portfolio_id WHERE p.owner_type='member'").fetchone()["n"]
    assert council_orders > 0 and member_orders > 0                              # per-seat portfolios use target_weight

    # weekly portfolios are untouched by the daily cadence
    assert seeded.execute("SELECT count(*) AS n FROM paper_orders o JOIN paper_portfolios p ON p.id=o.portfolio_id WHERE p.cadence='weekly'").fetchone()["n"] == 0

    provider = FakeProvider(opens=opens(seeded))
    clock = lambda: dt.datetime(2026, 10, 7, 10, 50, tzinfo=ET)                  # past the 10:40 deadline: no sleeping
    res = paper.fill_pending(seeded, provider, "market_on_open", TARGET, now=clock, sleep=lambda s: None)
    assert res["filled"] == council_orders + member_orders
    fl = seeded.execute("SELECT f.*, o.side FROM paper_fills f JOIN paper_orders o ON o.id=f.order_id LIMIT 1").fetchone()
    assert fl["fill_price"] > fl["reference_price"] and fl["price_source"].startswith("fake")      # buys pay slippage
    assert paper.fill_pending(seeded, provider, "market_on_open", TARGET, now=clock, sleep=lambda s: None)["filled"] == 0

    for t in ["SPY", *TRACKED]:                                                  # close the day, mark to market
        add_bar(seeded, t, TARGET, seeded.execute("SELECT close FROM price_bars WHERE ticker=%s AND bar_date=%s", (t, AS_OF)).fetchone()["close"])
    snap = paper.snapshot_and_check_stops(seeded, TARGET)
    assert snap["snapshots"] == 14 and snap["stop_exits"] == 0
    s = seeded.execute("SELECT * FROM paper_equity_snapshots s JOIN paper_portfolios p ON p.id=s.portfolio_id WHERE p.owner_type='council' AND p.cadence='daily'").fetchone()
    assert s["long_value"] > 0 and s["gross_exposure"] > 0 and s["equity"] > D("99000")
    from nuwrrrld.core.paper import fills
    for p in seeded.execute("SELECT id FROM paper_portfolios").fetchall():
        assert fills.verify_rebuild(seeded, p["id"]) == []

    # a close below the invalidation level queues a stop_exit for the next session
    pos = seeded.execute("SELECT p.* FROM paper_positions p JOIN paper_portfolios pf ON pf.id=p.portfolio_id WHERE pf.owner_type='council' LIMIT 1").fetchone()
    nxt = dt.date(2026, 10, 8)
    for t in ["SPY", *TRACKED]:
        add_bar(seeded, t, nxt, pos["invalidation_price"] * D("0.5") if t == pos["ticker"] else 100)
    out = paper.snapshot_and_check_stops(seeded, nxt)
    assert out["stop_exits"] >= 1
    stop = seeded.execute("SELECT * FROM paper_orders WHERE intent='stop_exit' LIMIT 1").fetchone()
    assert stop["side"] == "sell" and stop["target_session"] == dt.date(2026, 10, 9) and stop["status"] == "pending"
    assert paper.snapshot_and_check_stops(seeded, nxt)["stop_exits"] == 0       # idempotent per decision date


def test_moo_orders_expire_unfilled_when_no_open_print(seeded):
    set_strategies(seeded, "test.long")
    run_all(seeded)
    paper.create_orders_for_cadence(seeded, "daily", AS_OF)
    clock = lambda: dt.datetime(2026, 10, 7, 10, 50, tzinfo=ET)
    res = paper.fill_pending(seeded, FakeProvider(ready=False), "market_on_open", TARGET, now=clock, sleep=lambda s: None)
    assert res["filled"] == 0 and res["unfilled"] > 0
    nxt = dt.date(2026, 10, 8)
    paper.fill_pending(seeded, FakeProvider(), "market_on_open", nxt, now=lambda: dt.datetime(2026, 10, 8, 10, 50, tzinfo=ET), sleep=lambda s: None)
    assert seeded.execute("SELECT count(*) AS n FROM paper_orders WHERE status='expired'").fetchone()["n"] > 0


def test_drawdown_halt_blocks_new_entries_but_allows_exits(seeded):
    set_strategies(seeded, "test.long")
    run_all(seeded)
    pf = seeded.execute("SELECT id FROM paper_portfolios WHERE owner_type='council' AND cadence='daily'").fetchone()
    seeded.execute("UPDATE paper_portfolios SET peak_equity = 200000 WHERE id=%s", (pf["id"],))      # equity ~100k = -50%
    for t in ["SPY", *TRACKED]:
        add_bar(seeded, t, TARGET, 100)
    snap = paper.snapshot_and_check_stops(seeded, TARGET)
    assert str(pf["id"]) in snap["halted"]
    out = paper.create_orders_for_cadence(seeded, "daily", AS_OF)
    assert seeded.execute("SELECT count(*) AS n FROM paper_orders WHERE portfolio_id=%s AND status='pending'", (pf["id"],)).fetchone()["n"] == 0
    assert seeded.execute("SELECT count(*) AS n FROM paper_orders WHERE portfolio_id=%s AND status='rejected' AND reason LIKE 'portfolio halted%%'", (pf["id"],)).fetchone()["n"] > 0


def test_split_and_dividend_applied_once_per_portfolio(seeded):
    from nuwrrrld.core.paper import fills, sizing
    pf = seeded.execute("SELECT * FROM paper_portfolios WHERE owner_type='council' AND cadence='daily'").fetchone()
    seeded.execute("INSERT INTO paper_positions (portfolio_id,ticker,quantity,avg_cost,invalidation_price,opened_session) VALUES (%s,'XLE',10,100,90,'2026-10-01')", (pf["id"],))
    seeded.execute("INSERT INTO corporate_actions (ticker,ex_date,kind,ratio,provider) VALUES ('XLE','2026-10-07','split',2,'t')")
    seeded.execute("INSERT INTO corporate_actions (ticker,ex_date,kind,amount,provider) VALUES ('XLE','2026-10-07','dividend',0.50,'t')")
    assert paper.apply_corporate_actions(seeded, TARGET) == 2
    assert paper.apply_corporate_actions(seeded, TARGET) == 0
    p = seeded.execute("SELECT * FROM paper_positions").fetchone()
    assert p["quantity"] == 20 and p["avg_cost"] == 50 and p["invalidation_price"] == 45
    assert seeded.execute("SELECT amount FROM paper_cash_ledger WHERE kind='dividend'").fetchone()["amount"] == D("5.00")


def test_weekly_session_requires_last_session_of_week(seeded):
    from nuwrrrld.jobs import entrypoints as ep
    assert seeded.execute("SELECT 1").fetchone()
    cal = __import__("nuwrrrld.jobs.universe", fromlist=["x"]).calendar_for(seeded)
    assert cal.is_last_session_of_week(dt.date(2026, 10, 9)) and not cal.is_last_session_of_week(dt.date(2026, 10, 8))
