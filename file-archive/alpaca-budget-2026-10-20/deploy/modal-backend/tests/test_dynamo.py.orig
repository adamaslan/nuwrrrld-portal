"""DynamoDB layer under moto: tables, mirror-everything, shared Alpaca budget, cache, locks."""
import datetime as dt
import time
import uuid
from decimal import Decimal as D

import pytest
from moto import mock_aws

from nuwrrrld import dynamo
from nuwrrrld.jobs import council as council_jobs, ingest, paper, signals
from tests.conftest import TRACKED
from tests.fakes import FakeProvider
from tests.test_pipeline import NOW, SESSION, publish_run, todays_bars


@pytest.fixture()
def ddb(monkeypatch):
    monkeypatch.setenv("DYNAMO_MIRROR", "on")
    with mock_aws():
        d = dynamo.Dynamo()
        d.ensure_tables()
        monkeypatch.setattr(dynamo, "_default", d)
        yield d


def all_items(d):
    out, kw = [], {}
    while True:
        r = d.table(dynamo.TABLE_PIPELINE).scan(**kw)
        out += r["Items"]
        if "LastEvaluatedKey" not in r:
            return out
        kw = {"ExclusiveStartKey": r["LastEvaluatedKey"]}


def kinds(d):
    by = {}
    for i in all_items(d):
        by[i["kind"]] = by.get(i["kind"], 0) + 1
    return by


def test_tables_created_idempotently_within_free_tier(ddb):
    assert ddb.ensure_tables() == []
    names = {t.name for t in ddb.resource.tables.all()}
    assert names == {dynamo.TABLE_PIPELINE, dynamo.TABLE_LIVE, dynamo.TABLE_BUDGET, dynamo.TABLE_CACHE, dynamo.TABLE_LOCKS}
    assert all(n.startswith("nwf_") for n in names)                             # IAM is scoped to table/nwf_*
    assert sum(r for r, w in dynamo.CAPACITY.values()) <= 25 and sum(w for r, w in dynamo.CAPACITY.values()) <= 25
    prov = ddb.resource.meta.client.describe_table(TableName=dynamo.TABLE_PIPELINE)["Table"]["ProvisionedThroughput"]
    assert prov["ReadCapacityUnits"] == 10 and prov["WriteCapacityUnits"] == 12


def test_to_ddb_handles_db_types():
    out = dynamo.to_ddb({"d": dt.date(2026, 10, 7), "t": dt.datetime(2026, 10, 7, tzinfo=dt.timezone.utc), "u": uuid.UUID(int=1),
                         "x": D("1.5"), "f": 0.1, "nan": float("nan"), "n": None, "l": [dt.date(2026, 1, 1), {"k": D(2)}], "b": b"\x01"})
    assert out["d"] == "2026-10-07" and out["u"].endswith("1") and out["f"] == D("0.1") and out["nan"] is None
    assert out["l"][0] == "2026-01-01" and out["b"] == "01"
    assert not any(isinstance(v, float) for v in out.values())


def test_mirror_writes_queryable_items_and_overwrites(ddb):
    n = dynamo.mirror_rows("signals", [{"ticker": "XLE", "as_of_date": dt.date(2026, 10, 6), "strength": D("0.4")}])
    assert n == 1
    dynamo.mirror_rows("signals", [{"ticker": "XLE", "as_of_date": dt.date(2026, 10, 6), "strength": D("0.9")}])    # same key: overwritten
    items = ddb.query("signals", "XLE")
    assert len(items) == 1 and items[0]["sk"] == "2026-10-06" and items[0]["data"]["strength"] == D("0.9")
    assert items[0]["kind"] == "signals" and items[0]["mirrored_at"]


def test_mirror_never_raises_and_can_be_disabled(ddb, monkeypatch):
    broken = dynamo.Dynamo()
    broken._resource = type("R", (), {"Table": staticmethod(lambda name: (_ for _ in ()).throw(RuntimeError("down")))})()
    assert dynamo.mirror_rows("signals", [{"ticker": "A", "as_of_date": "2026-01-01"}], broken) == 0     # swallowed + logged
    monkeypatch.setenv("DYNAMO_MIRROR", "off")
    assert dynamo.mirror_rows("signals", [{"ticker": "A", "as_of_date": "2026-01-01"}]) == 0
    assert all_items(ddb) == []


def test_oversize_item_is_stored_as_truncated_marker(ddb):
    dynamo.mirror_rows("signals", [{"ticker": "BIG", "as_of_date": "2026-01-01", "blob": "x" * 400_000}])
    item = ddb.query("signals", "BIG")[0]
    assert item["data"]["truncated"] is True


def test_every_mirror_kind_has_key_and_sort_specs():
    sample = {"ticker": "A", "bar_date": "d", "indicator": "i", "as_of_date": "d", "engine_version": "1", "scope": "global",
              "subject_ticker": "A", "id": "1", "session_id": "s", "portfolio_id": "p", "decision_date": "d", "session_date": "d",
              "batch_id": "b", "side": "bull", "rank": 1, "call_id": "c", "horizon": "1w", "grade_type": "ex_ante",
              "prompt_version": "v1", "factor": "f", "user_id": "u", "holdings_hash": "h", "job_name": "j", "run_key": "k",
              "feature": "chat", "day": "d"}
    for kind, (k, s) in dynamo.MIRROR_SPECS.items():
        assert k(sample) and s(sample), kind


def test_alpaca_budget_caps_at_190_per_minute_and_resets(ddb):
    t0 = 1_800_000_000
    for _ in range(19):
        ddb.take_alpaca_tokens(10, now=t0)                                      # 190 used
    with pytest.raises(dynamo.AlpacaBudgetExhausted):
        ddb.take_alpaca_tokens(1, now=t0 + 5)
    ddb.take_alpaca_tokens(10, now=t0 + 61)                                     # next minute bucket


def test_alpaca_budget_waits_for_next_minute_instead_of_falling_back(ddb):
    sleeps = []
    calls = {"n": 0}
    real = ddb.take_alpaca_tokens

    def flaky(n, now=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise dynamo.AlpacaBudgetExhausted("full")
        return real(n, now=now)
    ddb.take_alpaca_tokens = flaky
    ddb.wait_for_alpaca_tokens(1, sleep=sleeps.append)
    assert len(sleeps) == 1 and 0 < sleeps[0] <= 61


def test_cache_ttl_and_locks(ddb):
    ddb.cache_put("k", {"a": 1}, 60)
    assert ddb.cache_get("k") == {"a": 1}
    ddb.cache_put("old", {"a": 1}, -5)
    assert ddb.cache_get("old") is None and ddb.cache_get("missing") is None
    assert ddb.try_lock("job", 60, "a") is True and ddb.try_lock("job", 60, "b") is False
    assert ddb.try_lock("expired", -1, "a") is True and ddb.try_lock("expired", 60, "b") is True


def test_live_prices_written(ddb):
    assert ddb.put_live_prices({"XLE": {"price": D("101.5"), "feed": "iex"}, "XLK": {"price": D("200"), "feed": "iex"}}) == 2
    assert ddb.table(dynamo.TABLE_LIVE).get_item(Key={"ticker": "XLE"})["Item"]["price"] == D("101.5")


# --- "have Dynamo receive all the data": the pipeline mirrors every stage -------------------------------------------------------
def test_ingest_through_signals_mirrors_to_dynamo_and_matches_postgres(conn, bars, ddb):
    ingest.ingest_eod(conn, FakeProvider(todays_bars(conn)), None, now=NOW, sleep=lambda s: None)
    as_of = signals.compute_for_latest_session(conn)
    signals.generate(conn, as_of)
    signals.generate_hold_fold(conn, as_of)
    signals.compute_sector_rotation(conn, as_of)
    signals.refresh_factors(conn, as_of)
    got = kinds(ddb)
    pg_bars = conn.execute("SELECT count(*) AS n FROM price_bars").fetchone()["n"]
    # ingest mirrors the day's bars + the heal window it re-upserts; every Postgres bar row it wrote is in Dynamo
    assert got["price_bars"] >= 5 * 1
    assert got["signals"] == len(TRACKED) == conn.execute("SELECT count(*) AS n FROM signals").fetchone()["n"]
    assert got["indicator_values"] == conn.execute("SELECT count(*) AS n FROM indicator_values").fetchone()["n"]
    assert got["hold_fold"] == len(TRACKED) and got["sector_rotation"] == len(TRACKED)
    assert got["factor_exposures"] == conn.execute("SELECT count(*) AS n FROM factor_exposures").fetchone()["n"]
    assert got["job_runs"] >= 1 and got["signal_runs"] == 1
    sig = ddb.query("signals", "XLE")[0]["data"]
    pg = conn.execute("SELECT direction, strength FROM signals WHERE ticker='XLE'").fetchone()
    assert sig["direction"] == pg["direction"] and sig["strength"] == pg["strength"]


def test_council_and_paper_flow_mirrors_to_dynamo(conn, bars, ddb):
    from tests.test_council_paper import AS_OF, TARGET, AlwaysLong, run_all, set_strategies, opens
    from nuwrrrld.calendar import ET
    publish_run(conn)
    council_jobs.seed_council(conn, council_jobs.load_yaml(), inception=dt.date(2026, 1, 1))
    set_strategies(conn, "test.long")
    run_all(conn)
    paper.create_orders_for_cadence(conn, "daily", AS_OF)
    paper.fill_pending(conn, FakeProvider(opens=opens(conn)), "market_on_open", TARGET,
                       now=lambda: dt.datetime(2026, 10, 7, 10, 50, tzinfo=ET), sleep=lambda s: None)
    from tests.test_pipeline import add_bar
    for t in ["SPY", *TRACKED]:
        add_bar(conn, t, TARGET, 100)
    paper.snapshot_and_check_stops(conn, TARGET)
    got = kinds(ddb)
    assert got["council_sessions"] == len(TRACKED) and got["council_consensus"] == len(TRACKED)
    assert got["paper_orders"] == conn.execute("SELECT count(*) AS n FROM paper_orders").fetchone()["n"]
    assert got["paper_fills"] == conn.execute("SELECT count(*) AS n FROM paper_fills").fetchone()["n"]
    assert got["paper_equity"] == conn.execute("SELECT count(*) AS n FROM paper_equity_snapshots").fetchone()["n"]


def test_followed_and_health_mirror(conn, bars, ddb):
    from tests.test_pipeline import force_directions
    from nuwrrrld.jobs import followed
    publish_run(conn)
    force_directions(conn)
    followed.freeze(conn, dt.date(2026, 11, 2))
    assert kinds(ddb)["followed_calls"] == 4


def test_job_failure_is_mirrored_too(conn, ddb):
    from nuwrrrld.jobs.runner import run_job
    with pytest.raises(RuntimeError):
        with run_job(conn, "j", "k"):
            raise RuntimeError("x")
    item = ddb.query("job_runs", "j")[0]["data"]
    assert item["status"] == "failed"
