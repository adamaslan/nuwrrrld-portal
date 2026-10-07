"""End-to-end jobs on real Postgres with fake providers / mocked LLM transport."""
import datetime as dt
import json
from decimal import Decimal as D

import httpx
import pandas as pd
import pytest

from nuwrrrld.jobs import digest, followed, ingest, signals, universe
from nuwrrrld.llm.client import LLMClient
from nuwrrrld.providers.base import CorporateAction
from tests.conftest import TRACKED, seed_bars
from tests.fakes import FakeProvider, bar, conn_factory, llm_transport

NOW = dt.datetime(2026, 10, 7, 20, 0, tzinfo=dt.timezone.utc)      # 16:00 ET, Wednesday (a session)
SESSION = dt.date(2026, 10, 7)


@pytest.fixture(autouse=True)
def _llm_env(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "test-key")
    monkeypatch.setenv("LLM_MODEL_FAST", "fast-model")
    monkeypatch.setenv("LLM_MODEL_SMART", "smart-model")


def last_close(conn, t):
    return conn.execute("SELECT close FROM price_bars WHERE ticker=%s ORDER BY bar_date DESC LIMIT 1", (t,)).fetchone()["close"]


def todays_bars(conn, move=D("1.01")):
    return [bar(t, SESSION, last_close(conn, t) * move) for t in ["SPY", *TRACKED]]


# --- ingest ---------------------------------------------------------------------------------------------
def test_ingest_success_upserts_validates_and_writes_parquet(conn, bars, tmp_path):
    p = FakeProvider(todays_bars(conn))
    out = ingest.ingest_eod(conn, p, None, cache_dir=str(tmp_path), now=NOW, sleep=lambda s: None)
    assert out["status"] == "succeeded"
    assert conn.execute("SELECT count(*) AS n FROM price_bars WHERE bar_date=%s", (SESSION,)).fetchone()["n"] == 5
    assert conn.execute("SELECT status FROM job_runs WHERE job_name='ingest_eod_bars'").fetchone()["status"] == "succeeded"
    assert (tmp_path / "bars" / "1d" / "XLE.parquet").exists()
    # idempotent: a second run is a no-op
    assert ingest.ingest_eod(conn, p, None, now=NOW, sleep=lambda s: None)["status"] == "not_claimed"


def test_ingest_fails_closed_when_a_tracked_etf_is_missing(conn, bars):
    p = FakeProvider([b for b in todays_bars(conn) if b.ticker != "XLK"])
    with pytest.raises(ingest.IngestFailed, match="XLK"):
        ingest.ingest_eod(conn, p, None, now=NOW, sleep=lambda s: None, max_polls=2)
    assert conn.execute("SELECT status FROM job_runs WHERE job_name='ingest_eod_bars'").fetchone()["status"] == "failed"
    assert conn.execute("SELECT count(*) AS n FROM price_bars WHERE bar_date=%s", (SESSION,)).fetchone()["n"] == 0


def test_ingest_polls_until_data_arrives(conn, bars):
    class Late(FakeProvider):
        def daily_bars(self, tickers, start, end):
            self.calls += 1
            return [] if self.calls < 3 else super().daily_bars(tickers, start, end)
    sleeps = []
    out = ingest.ingest_eod(conn, Late(todays_bars(conn)), None, now=NOW, sleep=sleeps.append, max_polls=5)
    assert out["status"] == "succeeded" and sleeps == [300, 300]


def test_big_move_without_corporate_action_fails_but_split_explains_it(conn, bars):
    big = todays_bars(conn)
    big[1] = bar("XLE", SESSION, last_close(conn, "XLE") * D("0.5"))
    with pytest.raises(ingest.IngestFailed):
        ingest.ingest_eod(conn, FakeProvider(big), None, now=NOW, sleep=lambda s: None, max_polls=1)
    split = CorporateAction("XLE", SESSION, "split", D("0.5"), None)
    out = ingest.ingest_eod(conn, FakeProvider(big, actions=[split]), None, now=NOW, sleep=lambda s: None, max_polls=1, force=True)
    assert out["status"] == "succeeded"
    assert conn.execute("SELECT count(*) AS n FROM corporate_actions").fetchone()["n"] == 1


def test_ingest_skips_non_session(conn, bars):
    sat = dt.datetime(2026, 10, 10, 20, 0, tzinfo=dt.timezone.utc)
    assert ingest.ingest_eod(conn, FakeProvider(), None, now=sat, sleep=lambda s: None)["status"] == "skipped"


def test_validate_bars_ohlc_insanity():
    good = bar("A", SESSION, 100)
    insane = good.__class__(**{**good.__dict__, "high": D(90)})
    ok, bad = ingest.validate_bars([good, insane], {}, set())
    assert len(ok) == 1 and bad[0][0] == "A"


# --- signals pipeline ------------------------------------------------------------------------------------
def test_signals_pipeline_is_deterministic_and_idempotent(conn, bars):
    as_of = signals.compute_for_latest_session(conn)
    assert as_of == dt.date(2026, 10, 6)
    run_id, ids = signals.generate(conn, as_of)
    assert len(ids) == len(TRACKED)
    run_id2, ids2 = signals.generate(conn, as_of)
    assert run_id == run_id2 and sorted(ids) == sorted(ids2)
    assert conn.execute("SELECT count(*) AS n FROM signals").fetchone()["n"] == len(TRACKED)
    rows = conn.execute("SELECT direction, strength, fired_indicators FROM signals").fetchall()
    assert all(-1 <= r["strength"] <= 1 for r in rows)
    assert conn.execute("SELECT count(DISTINCT indicator) AS n FROM indicator_values").fetchone()["n"] >= 8


def add_bar(conn, ticker, day, close):
    close = D(str(close))
    conn.execute("INSERT INTO price_bars (ticker,timeframe,bar_date,open,high,low,close,volume,adj_close,adj_factor,provider) "
                 "VALUES (%s,'1d',%s,%s,%s,%s,%s,1000000,%s,1,'t') ON CONFLICT DO NOTHING",
                 (ticker, day, close, close * D("1.01"), close * D("0.99"), close, close))


def test_signals_do_not_change_when_future_bars_change(conn, bars):
    as_of = dt.date(2026, 10, 6)
    signals.generate(conn, as_of)
    before = {r["ticker"]: (r["direction"], r["strength"], json.dumps(r["fired_indicators"], sort_keys=True))
              for r in conn.execute("SELECT ticker, direction, strength, fired_indicators FROM signals").fetchall()}
    conn.execute("TRUNCATE signals, indicator_values, signal_runs CASCADE")
    for day in (dt.date(2026, 10, 7), dt.date(2026, 10, 8), dt.date(2026, 10, 9)):      # wild FUTURE bars
        for t in ["SPY", *TRACKED]:
            add_bar(conn, t, day, 5000)
    signals.generate(conn, as_of)
    after = {r["ticker"]: (r["direction"], r["strength"], json.dumps(r["fired_indicators"], sort_keys=True))
             for r in conn.execute("SELECT ticker, direction, strength, fired_indicators FROM signals").fetchall()}
    assert before == after


def test_hold_fold_rotation_factors(conn, bars):
    as_of = dt.date(2026, 10, 6)
    signals.generate(conn, as_of)
    assert signals.generate_hold_fold(conn, as_of) == len(TRACKED)
    assert signals.generate_hold_fold(conn, as_of) == len(TRACKED)               # upsert, no duplicates
    assert conn.execute("SELECT count(*) AS n FROM hold_fold_verdicts").fetchone()["n"] == len(TRACKED)
    v = conn.execute("SELECT * FROM hold_fold_verdicts LIMIT 1").fetchone()
    assert v["verdict"] in ("hold", "fold") and v["scope"] == "global"
    assert signals.compute_sector_rotation(conn, as_of) == len(TRACKED)
    assert {r["quadrant"] for r in conn.execute("SELECT quadrant FROM sector_rotation_snapshots").fetchall()} <= {"leading", "weakening", "lagging", "improving"}
    assert signals.refresh_factors(conn, as_of) > 0
    assert conn.execute("SELECT count(*) AS n FROM factor_exposures WHERE factor='beta_spy_252'").fetchone()["n"] == len(TRACKED)


def test_backfill_run_is_flagged_and_never_alerts(conn, bars):
    rid = signals.generate_backfill(conn, "2026-10-06")
    assert conn.execute("SELECT is_backfill FROM signal_runs WHERE id=%s", (rid,)).fetchone()["is_backfill"] is True


def test_watchlist_alert_on_signal_flip(conn, bars):
    from tests.conftest import make_user
    u = make_user(conn)
    day1, day2 = dt.date(2026, 10, 5), dt.date(2026, 10, 6)
    signals.generate(conn, day1)
    signals.generate(conn, day2)
    conn.execute("UPDATE signals SET direction='bullish' WHERE as_of_date=%s", (day1,))
    conn.execute("UPDATE signals SET direction='bearish' WHERE as_of_date=%s", (day2,))
    conn.execute("INSERT INTO watchlists (user_id,name,is_default) VALUES (%s,'w',true)", (u["id"],))
    wl = conn.execute("SELECT id FROM watchlists").fetchone()
    conn.execute("INSERT INTO watchlist_items (watchlist_id,ticker,alert_rules) VALUES (%s,'XLE','{\"signal_flip\":true}')", (wl["id"],))
    assert signals.evaluate_watchlist_alerts(conn, day2) == 1
    assert signals.evaluate_watchlist_alerts(conn, day2) == 0                 # unique per (user,ticker,date,kind)
    a = conn.execute("SELECT payload FROM user_alerts").fetchone()["payload"]
    assert a["from"] == "bullish" and a["to"] == "bearish"


# --- digest with an LLM transport -----------------------------------------------------------------------------------
def make_llm(dsn, responder):
    transport, calls = llm_transport(responder)
    return LLMClient(conn_factory(dsn), http=httpx.Client(transport=transport)), calls


def first_signal(conn):
    return conn.execute("SELECT s.*, i.name FROM signals s JOIN instruments i USING (ticker) ORDER BY ticker LIMIT 1").fetchone()


def test_explain_uses_llm_when_numbers_validate(conn, bars, test_dsn):
    signals.generate(conn, dt.date(2026, 10, 6))
    sig = first_signal(conn)
    llm, calls = make_llm(test_dsn, lambda b: f"{sig['ticker']} reads {sig['direction']} at strength {float(sig['strength'])}. You should buy now.")
    assert digest.explain_signal(conn, llm, str(sig["id"])) == "llm"
    row = first_signal(conn)
    assert row["explanation_source"] == "llm" and row["explanation_validated"] and "should buy" not in row["explanation_md"].lower()
    assert "Educational only" in row["explanation_md"]
    assert digest.explain_signal(conn, llm, str(sig["id"])) == "llm" and len(calls) == 1      # idempotent per prompt_version
    assert conn.execute("SELECT count(*) AS n FROM llm_usage WHERE feature='digest' AND ok").fetchone()["n"] == 1


def test_explain_falls_back_to_template_after_invented_number_retry(conn, bars, test_dsn):
    signals.generate(conn, dt.date(2026, 10, 6))
    sig = first_signal(conn)
    llm, calls = make_llm(test_dsn, lambda b: "The price target is 987.65 soon.")
    assert digest.explain_signal(conn, llm, str(sig["id"])) == "template"
    assert len(calls) == 2                                                   # one retry with the errors listed
    assert "987.65" in json.dumps(calls[1]["messages"][-1])
    assert first_signal(conn)["explanation_source"] == "template"
    assert conn.execute("SELECT count(*) AS n FROM llm_usage WHERE NOT ok").fetchone()["n"] == 2


def test_explain_template_when_breaker_open(conn, bars, test_dsn):
    from nuwrrrld.llm.client import LLMClient as C
    signals.generate(conn, dt.date(2026, 10, 6))
    llm = C(conn_factory(test_dsn), breaker_open=lambda: True)
    assert digest.explain_signal(conn, llm, str(first_signal(conn)["id"])) == "template"


def test_finalize_publish_flow_and_payload(conn, bars, test_dsn):
    as_of = dt.date(2026, 10, 6)
    run_id, ids = signals.generate(conn, as_of)
    digest.explain_signal(conn, None, ids[0])
    stats = digest.finalize_run(conn, run_id, [RuntimeError("one failed")])
    assert stats["failures"] == 1 and stats["llm_share"] == 0.0
    assert conn.execute("SELECT status FROM signal_runs").fetchone()["status"] == "explained"
    assert conn.execute("SELECT count(*) AS n FROM signals WHERE explanation_md IS NULL").fetchone()["n"] == 0
    payload = digest.publish_latest(conn)
    assert payload["as_of"] == "2026-10-06" and len(payload["signals"]) == len(TRACKED)
    assert digest.publish_latest(conn) is None                                # nothing newer


# --- followed tickers -------------------------------------------------------------------------------------------------
def publish_run(conn, as_of=dt.date(2026, 10, 6)):
    run_id, ids = signals.generate(conn, as_of)
    signals.generate_hold_fold(conn, as_of)
    for i in ids:
        digest.explain_signal(conn, None, i)
    digest.finalize_run(conn, run_id, [])
    conn.execute("UPDATE signal_runs SET status='published', published_at=now() WHERE id=%s", (run_id,))
    return run_id


def force_directions(conn):
    """Make the sample universe decisive: two bullish, two bearish."""
    for t, s in zip(TRACKED, [0.9, 0.5, -0.6, -0.8]):
        conn.execute("UPDATE signals SET strength=%s, direction=%s WHERE ticker=%s", (s, "bullish" if s > 0 else "bearish", t))


def test_followed_freeze_is_forward_only_idempotent_and_immutable(conn, bars):
    publish_run(conn)
    force_directions(conn)
    nov2 = dt.date(2026, 11, 2)
    assert followed.freeze(conn, dt.date(2026, 11, 3))["status"] == "skipped"       # not the first session
    res = followed.freeze(conn, nov2)
    assert res["status"] == "frozen" and len(res["call_ids"]) == 4
    assert followed.freeze(conn, nov2)["status"] == "skipped"                        # batch exists
    assert conn.execute("SELECT count(*) AS n FROM followed_horizon_scores").fetchone()["n"] == 4 * 7
    calls = conn.execute("SELECT side, rank, ticker FROM followed_calls ORDER BY side, rank").fetchall()
    assert [c["ticker"] for c in calls if c["side"] == "bull"] == ["XLE", "XLK"]
    assert [c["ticker"] for c in calls if c["side"] == "bear"] == ["XLV", "XLF"]
    import psycopg
    with pytest.raises(psycopg.errors.RaiseException):
        conn.execute("UPDATE followed_calls SET reasoning_md='edited'")
    h = conn.execute("SELECT h.target_session FROM followed_horizon_scores h WHERE horizon='1w' LIMIT 1").fetchone()
    assert h["target_session"] == dt.date(2026, 10, 13)                                 # 5 sessions after Oct 6


def test_followed_scores_bull_and_bear_with_sign_flip(conn, bars):
    publish_run(conn)
    force_directions(conn)
    followed.freeze(conn, dt.date(2026, 11, 2))
    entry = {r["ticker"]: r["entry_price"] for r in conn.execute("SELECT ticker, entry_price FROM followed_calls").fetchall()}
    for d in [dt.date(2026, 10, 7), dt.date(2026, 10, 8), dt.date(2026, 10, 9), dt.date(2026, 10, 12), dt.date(2026, 10, 13)]:
        for t in ["SPY", *TRACKED]:
            add_bar(conn, t, d, 100 if t == "SPY" else entry.get(t, 100) * D("1.10"))
    out = followed.score_due(conn)
    assert out["scored"] == 4
    by = {(r["ticker"], r["horizon"]): r for r in conn.execute(
        "SELECT c.ticker, h.* FROM followed_horizon_scores h JOIN followed_calls c ON c.id=h.call_id WHERE h.status='scored'").fetchall()}
    assert by[("XLE", "1w")]["hit"] is True and float(by[("XLE", "1w")]["directional_return"]) == pytest.approx(0.10, abs=1e-6)
    assert by[("XLV", "1w")]["hit"] is False and float(by[("XLV", "1w")]["directional_return"]) == pytest.approx(-0.10, abs=1e-6)
    assert followed.score_due(conn)["scored"] == 0                                        # idempotent


def test_followed_grade_ex_ante_and_unique_per_prompt_version(conn, bars, test_dsn):
    publish_run(conn)
    force_directions(conn)
    cid = followed.freeze(conn, dt.date(2026, 11, 2))["call_ids"][0]
    rubric = json.dumps({"rubric_scores": {k: 4 for k in followed.RUBRIC}, "rationale_md": "Solid evidence use."})
    llm, calls = make_llm(test_dsn, lambda b: rubric)
    assert followed.grade_call(conn, llm, cid, "ex_ante") == "graded"
    assert followed.grade_call(conn, llm, cid, "ex_ante") == "exists"
    g = conn.execute("SELECT * FROM followed_llm_grades").fetchone()
    assert g["letter_grade"] == "B" and float(g["overall_score"]) == 80.0 and g["horizon"] == "none"
    bad, _ = make_llm(test_dsn, lambda b: "not json")
    assert followed.grade_call(conn, bad, cid, "ex_post", "1w") == "not_scored"


def test_letter_grade_boundaries():
    assert [followed.letter_grade(x) for x in (95, 90, 85, 75, 65, 10)] == ["A", "A", "B", "C", "D", "F"]
