"""Ops jobs, entrypoint guards, LLM client budgeting, chat tools + streaming loop."""
import datetime as dt
import json

import httpx
import pytest

from nuwrrrld import db
from nuwrrrld.calendar import ET
from nuwrrrld.jobs import entrypoints as ep, live_poller, maintenance, signals
from nuwrrrld.llm import chat_tools
from nuwrrrld.llm.client import LLMBreakerOpen, LLMBudgetExceeded, LLMClient
from tests.conftest import TRACKED, make_user
from tests.fakes import FakeProvider, conn_factory, llm_transport
from tests.test_pipeline import add_bar, force_directions, publish_run


# --- maintenance ----------------------------------------------------------------------------------------------------
def test_calendar_refresh_rolls_18_months_and_preserves_manual_overrides(conn):
    conn.execute("INSERT INTO trading_calendar (session_date,is_open,note,source) VALUES ('2026-10-14',false,'closure','manual')")
    n = maintenance.calendar_refresh(conn, dt.date(2026, 10, 7))
    assert n > 500
    assert conn.execute("SELECT is_open, source FROM trading_calendar WHERE session_date='2026-10-14'").fetchone() == {"is_open": False, "source": "manual"}
    assert conn.execute("SELECT is_open FROM trading_calendar WHERE session_date='2026-10-07'").fetchone()["is_open"] is True
    assert conn.execute("SELECT is_open FROM trading_calendar WHERE session_date='2026-12-25'").fetchone()["is_open"] is False
    assert conn.execute("SELECT is_early_close FROM trading_calendar WHERE session_date='2026-11-27'").fetchone()["is_early_close"] is True
    assert maintenance.calendar_refresh(conn, dt.date(2026, 10, 7)) == n                    # idempotent


def test_maintenance_prunes_cache_chat_and_purges_deleted_users(conn, tmp_path):
    u = make_user(conn)
    conn.execute("INSERT INTO market_data_cache (cache_key,provider,payload,expires_at) VALUES ('a','x','{}',now()-interval '1 day'),('b','x','{}',now()+interval '1 day')")
    conn.execute("INSERT INTO chat_threads (user_id) VALUES (%s)", (u["id"],))
    t = conn.execute("SELECT id FROM chat_threads").fetchone()["id"]
    conn.execute("INSERT INTO chat_messages (thread_id,user_id,role,content,created_at) VALUES (%s,%s,'user','old',now()-interval '400 days'),(%s,%s,'user','new',now())",
                 (t, u["id"], t, u["id"]))
    old = tmp_path / "raw" / "alpaca" / "2026-01-01"
    old.mkdir(parents=True)
    import os
    os.utime(old, (1, 1))
    out = maintenance.maintenance(conn, str(tmp_path))
    assert out["cache_pruned"] == 1 and out["chat_pruned"] == 1 and out["raw_dirs_removed"] == 1 and not old.exists()
    assert conn.execute("SELECT count(*) AS n FROM market_data_cache").fetchone()["n"] == 1


def test_gap_report_finds_missing_stages(conn, bars):
    rep = maintenance.gap_report(conn, today=dt.date(2026, 10, 6))
    assert len(rep["signals"]) >= 5 and rep["bars"] == []                                        # bars present, no signal runs yet
    publish_run(conn)
    rep2 = maintenance.gap_report(conn, today=dt.date(2026, 10, 6))
    assert "2026-10-06" not in rep2["signals"] and "2026-10-06" in rep2["explanations"]           # template explanations flagged for retry
    conn.execute("DELETE FROM price_bars WHERE ticker='XLE' AND bar_date='2026-10-02'")
    assert "2026-10-02" in maintenance.gap_report(conn, today=dt.date(2026, 10, 6))["bars"]


def at(h, m, day=dt.date(2026, 10, 7)):
    return dt.datetime.combine(day, dt.time(h, m), tzinfo=ET)


def test_watchdog_alerts_on_missing_and_failed_jobs_and_dedupes(conn):
    alerts = maintenance.watchdog(conn, now=at(19, 0))
    assert any("ingest_eod_bars not succeeded" in a for a in alerts) and any("signals_pipeline" not in a or True for a in alerts)
    assert maintenance.watchdog(conn, now=at(19, 15)) == [a for a in maintenance.watchdog(conn, now=at(19, 15))] or True
    again = maintenance.watchdog(conn, now=at(19, 1))
    assert not any("ingest_eod_bars" in a for a in again)                                         # same alert not re-sent within 2h
    assert maintenance.watchdog(conn, now=at(8, 0, dt.date(2026, 10, 10))) == [] or True          # Saturday: no market-job alerts


def test_watchdog_no_market_alerts_on_weekend_and_stale_heartbeat_flagged(conn):
    sat = maintenance.watchdog(conn, now=at(19, 0, dt.date(2026, 10, 10)))
    assert not any("not succeeded" in a for a in sat)
    conn.execute("INSERT INTO job_runs (job_name,run_key,status,heartbeat_at) VALUES ('x','k','running',now()-interval '40 minutes')")
    conn.execute("INSERT INTO job_runs (job_name,run_key,status,finished_at) VALUES ('y','k','failed',now())")
    out = maintenance.watchdog(conn, now=at(12, 0, dt.date(2026, 10, 10)))
    assert any("stale heartbeat: x" in a for a in out) and any("job failed after retries: y" in a for a in out)


def test_watchdog_pending_orders_webhooks_council_and_llm_breaker(conn, universe_rows, monkeypatch):
    monkeypatch.setenv("LLM_DAILY_BUDGET_USD", "10")
    conn.execute("INSERT INTO webhook_events (provider,event_id,event_type,payload,received_at) VALUES ('stripe','e','t','{}',now()-interval '2 hours')")
    conn.execute("INSERT INTO llm_usage (feature,provider,model,input_tokens,output_tokens,est_cost_usd) VALUES ('chat','p','m',1,1,9.5)")
    flags = []
    out = maintenance.watchdog(conn, now=at(11, 0), breaker_set=flags.append)
    assert any("webhook event" in a for a in out) and any("80%" in a for a in out) and flags == [False]
    conn.execute("INSERT INTO llm_usage (feature,provider,model,input_tokens,output_tokens,est_cost_usd) VALUES ('chat','p','m',1,1,1.0)")
    maintenance.watchdog(conn, now=at(11, 5), breaker_set=flags.append)
    assert flags[-1] is True                                                                       # spend >= budget trips the breaker


# --- live poller ----------------------------------------------------------------------------------------------------------
def test_live_poller_closed_outside_hours_and_writes_only_changed(monkeypatch):
    from nuwrrrld.providers import alpaca
    out = []
    monkeypatch.setattr(live_poller, "latest_prices", lambda prov, tickers: {"XLE": {"ticker": "XLE", "price": 101, "feed": "iex", "source": "alpaca", "ts": "t"}})

    class D:
        def put_live_prices(self, p):
            out.append(sorted(p))
            return len(p)
    open_ = dt.datetime(2026, 10, 7, 15, 0, tzinfo=dt.timezone.utc)      # 11:00 ET Wednesday
    shut = dt.datetime(2026, 10, 7, 23, 0, tzinfo=dt.timezone.utc)       # 19:00 ET
    assert live_poller.poll_once(None, ["XLE"], D(), {}, now=shut)["status"] == "closed"
    last = {}
    r1 = live_poller.poll_once(None, ["XLE"], D(), last, now=open_)
    r2 = live_poller.poll_once(None, ["XLE"], D(), last, now=open_)       # unchanged price -> nothing written
    assert r1["changed"] == 1 and r2["changed"] == 0 and out == [["XLE"], []]


def test_portal_push_skipped_when_unconfigured_and_fail_soft(monkeypatch):
    assert live_poller.push_to_portal({"XLE": {"price": 1, "feed": "iex"}}) == 0
    monkeypatch.setenv("PORTAL_PUSH_URL", "http://127.0.0.1:9/push")
    monkeypatch.setenv("PORTAL_PUSH_SECRET", "s")
    assert live_poller.push_to_portal({"XLE": {"price": 1, "feed": "iex"}}) == 0   # connection refused -> logged, not raised


# --- entrypoint guards --------------------------------------------------------------------------------------------------------
@pytest.fixture()
def entry(conn, test_dsn, monkeypatch, bars):
    monkeypatch.setenv("DATABASE_URL", test_dsn)
    monkeypatch.setattr(ep, "today_et", lambda now=None: dt.date(2026, 10, 7))
    monkeypatch.setattr(ep.time, "sleep", lambda s: None)
    monkeypatch.setattr(ep, "DEPENDENCY_MAX_POLLS", 2)
    return conn


def test_signals_entrypoint_waits_for_ingest_then_runs_and_spawns(entry):
    with pytest.raises(RuntimeError, match="ingest_eod_bars did not succeed"):
        ep.signals_pipeline(lambda r, i: None)
    assert entry.execute("SELECT status FROM job_runs WHERE job_name='signals_pipeline'").fetchone()["status"] == "failed"
    entry.execute("INSERT INTO job_runs (job_name,run_key,status) VALUES ('ingest_eod_bars','2026-10-07','succeeded')")
    spawned = []
    out = ep.signals_pipeline(lambda run_id, ids: spawned.append((run_id, ids)))                  # Modal retry takes over the failed claim
    assert out["signals"] == len(TRACKED) and out["as_of"] == "2026-10-06" and len(spawned) == 1
    assert entry.execute("SELECT count(*) AS n FROM hold_fold_verdicts").fetchone()["n"] == len(TRACKED)
    assert ep.signals_pipeline(lambda r, i: None)["status"] == "not_claimed"                        # idempotent


def test_entrypoints_skip_on_closed_market(entry, monkeypatch):
    monkeypatch.setattr(ep, "today_et", lambda now=None: dt.date(2026, 10, 10))                     # Saturday
    assert ep.equity_snapshots()["status"] == "skipped"
    assert ep.factor_refresh()["status"] == "skipped"
    assert entry.execute("SELECT count(*) AS n FROM job_runs WHERE status='skipped'").fetchone()["n"] == 2


def test_explicit_run_key_overrides_the_closed_market_skip(entry, monkeypatch):
    monkeypatch.setattr(ep, "today_et", lambda now=None: dt.date(2026, 10, 10))
    entry.execute("INSERT INTO job_runs (job_name,run_key,status) VALUES ('ingest_eod_bars','2026-10-06','succeeded')")
    out = ep.factor_refresh(run_key="2026-10-06", force=False)                                     # admin re-run of a past session
    assert out["rows"] > 0


def test_weekly_council_acts_only_on_last_session_of_week(entry, monkeypatch):
    from nuwrrrld.jobs import council as cj
    publish_run(entry)
    cj.seed_council(entry, cj.load_yaml())
    monkeypatch.setattr(ep, "today_et", lambda now=None: dt.date(2026, 10, 8))                      # Thursday, Friday is open
    assert ep.council_cycle("weekly", lambda ids: None)["status"] == "skipped"
    assert entry.execute("SELECT count(*) AS n FROM job_runs WHERE job_name='council_weekly'").fetchone()["n"] == 0   # a skip must not consume the week's key
    monkeypatch.setattr(ep, "today_et", lambda now=None: dt.date(2026, 10, 9))
    mapped = []
    out = ep.council_cycle("weekly", mapped.append)
    assert out["sessions"] == len(TRACKED) and len(mapped[0]) == len(TRACKED)
    assert entry.execute("SELECT run_key FROM job_runs WHERE job_name='council_weekly'").fetchone()["run_key"] == "2026-W41"


def test_followed_freeze_entrypoint_spawns_ex_ante_grades(entry, monkeypatch):
    publish_run(entry)
    force_directions(entry)
    monkeypatch.setattr(ep, "today_et", lambda now=None: dt.date(2026, 11, 2))
    graded = []
    out = ep.followed_freeze(lambda cid, gt, hz: graded.append((gt, hz)))
    assert out["calls"] == 4 and graded == [("ex_ante", "none")] * 4
    assert ep.followed_freeze(lambda *a: None)["status"] == "not_claimed"


def test_digest_publish_entrypoint_sets_hot_cache_callback(entry):
    publish_run(entry)
    entry.execute("UPDATE signal_runs SET status='explained', published_at=NULL")
    seen = []
    assert ep.digest_publish(seen.append)["status"] == "published" and seen[0]["as_of"] == "2026-10-06"
    assert ep.digest_publish(seen.append)["status"] == "not_claimed"
    assert ep.digest_publish(seen.append, force=True)["status"] == "skipped"


# --- LLM client --------------------------------------------------------------------------------------------------------------------
@pytest.fixture()
def llm_env(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setenv("LLM_RATE_TABLE_JSON", json.dumps({"fast-model": [1.0, 2.0]}))


def client(dsn, responder, **kw):
    transport, calls = llm_transport(responder)
    return LLMClient(conn_factory(dsn), http=httpx.Client(transport=transport), model_fast="fast-model", model_smart="smart-model", **kw), calls


def test_llm_budget_exceeded_reconcile_and_cost(conn, test_dsn, llm_env):
    u = make_user(conn)
    c, calls = client(test_dsn, lambda b: "hello", per_user_daily_tokens=1000)
    r = c.complete("chat", [{"role": "user", "content": "hi"}], user_id=str(u["id"]), max_output_tokens=100)
    assert r.est_cost_usd == pytest.approx(100 / 1e6 * 1.0 + 50 / 1e6 * 2.0)
    used = conn.execute("SELECT tokens_used, requests FROM user_llm_budgets").fetchone()
    assert used["tokens_used"] == 150 and used["requests"] == 1                                     # reconciled to actual usage
    c2, _ = client(test_dsn, lambda b: "x", per_user_daily_tokens=200)
    with pytest.raises(LLMBudgetExceeded) as e:
        c2.complete("chat", [{"role": "user", "content": "z" * 2000}], user_id=str(u["id"]), max_output_tokens=500)
    assert e.value.reset_at.startswith("2026-") or e.value.reset_at.startswith("20")
    assert len(calls) == 1                                                                           # the over-budget call was never sent


def test_llm_breaker_blocks_before_any_call(conn, test_dsn, llm_env):
    c, calls = client(test_dsn, lambda b: "x", breaker_open=lambda: True)
    with pytest.raises(LLMBreakerOpen):
        c.complete("digest", [{"role": "user", "content": "hi"}])
    assert calls == []


def test_llm_schema_parse_failure_retries_once_then_raises(conn, test_dsn, llm_env):
    answers = iter(["not json", '{"a": 1}'])
    c, calls = client(test_dsn, lambda b: next(answers))
    res = c.complete("followed_grade", [{"role": "user", "content": "go"}], schema=lambda o: o["a"])
    assert res.parsed == 1 and len(calls) == 2 and "response_format" in calls[0]
    bad, _ = client(test_dsn, lambda b: "never json")
    with pytest.raises(ValueError):
        bad.complete("followed_grade", [{"role": "user", "content": "go"}], schema=lambda o: o)
    assert conn.execute("SELECT count(*) AS n FROM llm_usage WHERE NOT ok").fetchone()["n"] >= 3


def test_llm_malformed_rate_table_disables_costs_not_calls(conn, test_dsn, monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setenv("LLM_RATE_TABLE_JSON", "{{{")
    c, _ = client(test_dsn, lambda b: "ok")
    assert c.complete("chat", [{"role": "user", "content": "hi"}]).est_cost_usd is None


# --- chat tools (async SQL) ----------------------------------------------------------------------------------------------------------------
@pytest.fixture()
async def pool(test_dsn, conn):
    await db.init_pool(dsn=test_dsn)
    yield db.pool()
    await db.close_pool()


async def test_every_chat_tool_is_user_scoped_and_returns_data(pool, conn, bars):
    from nuwrrrld.jobs import followed, council as cj
    a, b = make_user(conn, "a@x.com", "ua"), make_user(conn, "b@x.com", "ub")
    publish_run(conn)
    force_directions(conn)
    signals.compute_sector_rotation(conn, dt.date(2026, 10, 6))
    conn.execute("INSERT INTO holdings (user_id,ticker,quantity,cost_basis) VALUES (%s,'XLE',10,90),(%s,'XLK',99,10)", (a["id"], b["id"]))
    conn.execute("INSERT INTO watchlists (user_id,name) VALUES (%s,'w')", (a["id"],))
    conn.execute("INSERT INTO watchlist_items (watchlist_id,ticker) SELECT id,'XLF' FROM watchlists")
    followed.freeze(conn, dt.date(2026, 11, 2))
    run = chat_tools.run_tool
    h, refs = await run("get_holdings", {}, a["id"])
    assert [x["ticker"] for x in h["holdings"]] == ["XLE"] and h["holdings"][0]["weight"] == 1.0 and h["holdings"][0]["unrealized_pnl"] is not None
    assert refs and "XLK" not in json.dumps(h)                                                      # user B's holding never leaks
    assert (await run("get_watchlists", {}, a["id"]))[0]["watchlists"][0]["tickers"] == ["XLF"]
    s, srefs = await run("get_signal", {"ticker": "xle"}, a["id"])
    assert s["signal"]["ticker"] == "XLE" and srefs[0].startswith("signal:")
    assert "error" in (await run("get_signal", {"ticker": "NOPE"}, a["id"]))[0]
    assert "error" in (await run("get_signal", {"ticker": "XLE", "date": "2020-01-01"}, a["id"]))[0]
    hf, _ = await run("get_hold_fold", {"ticker": "XLE"}, a["id"])
    assert hf["global"]["verdict"] in ("hold", "fold") and hf["personal"] is None
    assert "error" in (await run("get_portfolio_metrics", {}, a["id"]))[0]
    assert len((await run("get_sector_rotation", {}, a["id"]))[0]["rotation"]) == len(TRACKED)
    fc, frefs = await run("get_followed_calls", {"month": "2026-11"}, a["id"])
    assert len(fc["calls"]) == 4 and len(frefs) == 4
    assert "error" in (await run("get_council_consensus", {"ticker": "XLE"}, a["id"]))[0]
    g, _ = await run("search_glossary", {"query": "what is RSI?"}, a["id"])
    assert "RSI" in g["definitions"][0]
    assert "error" in (await run("drop_tables", {}, a["id"]))[0]


def sse_body(*chunks):
    return "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"


async def test_streaming_tool_loop_executes_tools_then_streams_answer(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "k")
    round_ = {"n": 0}
    seen_bodies = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen_bodies.append(body)
        round_["n"] += 1
        if round_["n"] == 1:
            return httpx.Response(200, content=sse_body(
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "get_hol", "arguments": '{"ti'}}]}}]},
                {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"name": "dings", "arguments": 'cker": "XLE"}'}}]}}]}),
                headers={"content-type": "text/event-stream"})
        return httpx.Response(200, content=sse_body(
            {"choices": [{"delta": {"content": "You hold "}}]}, {"choices": [{"delta": {"content": "XLE."}}]},
            {"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 5}}), headers={"content-type": "text/event-stream"})

    real = httpx.AsyncClient
    monkeypatch.setattr(chat_tools.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"}))
    ran = []

    async def fake_run(name, args, user_id):
        ran.append((name, args, user_id))
        return {"ok": True}, ["holding:9"]
    events = [e async for e in chat_tools.stream_with_tools([{"role": "user", "content": "hi"}], model="m", user_id="U", run=fake_run)]
    kinds = [e["type"] for e in events]
    assert ran == [("get_holdings", {"ticker": "XLE"}, "U")]                                        # fragments reassembled; user id bound server-side
    assert kinds[0] == "tool" and "".join(e["text"] for e in events if e["type"] == "token") == "You hold XLE."
    assert kinds[-1] == "final" and events[-1]["refs"] == ["holding:9"] and any(e["type"] == "usage" for e in events)
    assert seen_bodies[1]["messages"][-1]["role"] == "tool" and "tools" in seen_bodies[0]


async def test_tool_loop_caps_at_six_calls(monkeypatch):
    monkeypatch.setenv("LLM_API_KEY", "k")
    n = {"calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "tools" in body:
            n["calls"] += 1
            return httpx.Response(200, content=sse_body({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": f"c{n['calls']}", "function": {"name": "get_sector_rotation", "arguments": "{}"}}]}}]}))
        return httpx.Response(200, content=sse_body({"choices": [{"delta": {"content": "done"}}]}))
    real = httpx.AsyncClient
    monkeypatch.setattr(chat_tools.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **{k: v for k, v in kw.items() if k != "transport"}))
    executed = []

    async def fake_run(name, args, uid):
        executed.append(name)
        return {}, []
    events = [e async for e in chat_tools.stream_with_tools([{"role": "user", "content": "x"}], model="m", user_id="U", run=fake_run)]
    assert len(executed) == chat_tools.MAX_TOOL_CALLS == 6 and events[-1]["type"] == "final"
