import dataclasses

import pandas as pd
import pytest

from nwf_lab import scenarios
from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.data.cache import ResponseCache
from nwf_lab.data.finnhub import FinnhubProvider
from nwf_lab.errors import LabError, VendorGapError
from nwf_lab.features.registry import FEATURES, run_features
from nwf_lab.report import exit_code, summary_line
from nwf_lab.symbols import to_alpaca, to_yahoo


def test_every_in_scope_feature_ok_on_fixture(bundle, cfg):
    results = run_features(bundle, cfg)
    bad = {s: (r.status, r.note) for s, r in results.items()
           if r.status not in ("ok", "skipped_llm")}
    assert not bad, bad
    assert exit_code(results) == 0
    assert "14 in scope" in summary_line(results)


def test_llm_off_returns_prompt_only(bundle, cfg):
    r = run_features(bundle, cfg, only=["brief"])["brief"]
    assert r.status == "skipped_llm" and "prompt" in r.data


def test_llm_on_calls_injected_caller(bundle, cfg):
    r = run_features(bundle, cfg, only=["brief"], with_llm=True, llm_call=lambda p: "RESP")["brief"]
    assert r.status == "ok" and r.data["response"] == "RESP"


def test_config_is_hashable_and_replace(cfg):
    assert hash(cfg) == hash(LabConfig())
    assert cfg.replace(rsi_overbought=65).rsi_overbought == 65
    with pytest.raises(dataclasses.FrozenInstanceError):
        cfg.rsi_window = 5  # type: ignore[misc]


def test_slider_change_does_not_need_new_data(bundle, cfg):
    a = run_features(bundle, cfg, only=["signals-top"])
    b = run_features(bundle, cfg.replace(buy_score=60, sell_score=40), only=["signals-top"])
    assert a["signals-top"].status == b["signals-top"].status == "ok"


def test_bundle_roundtrip_and_hash(bundle, tmp_path, cfg):
    path = bundle.save(tmp_path / "b.parquet")
    loaded = DataBundle.load(path)
    assert loaded.content_hash() == bundle.content_hash()
    assert loaded.tickers == bundle.tickers
    a = run_features(bundle, cfg, only=["analyze"])["analyze"].data
    b = run_features(loaded, cfg, only=["analyze"])["analyze"].data
    assert a == b


def test_load_missing_bundle_raises(tmp_path):
    with pytest.raises(LabError):
        DataBundle.load(tmp_path / "nope.parquet")


def test_scenarios_do_not_mutate_input(bundle):
    before = bundle.content_hash()
    shocked = scenarios.price_shock(bundle, -0.10)
    assert bundle.content_hash() == before
    assert shocked.content_hash() != before
    assert shocked.manual_edits


def test_price_shock_changes_signals(bundle, cfg):
    base = run_features(bundle, cfg, only=["analyze"])["analyze"].data
    shocked = run_features(scenarios.price_shock(bundle, -0.30), cfg, only=["analyze"])["analyze"].data
    assert any(base[t]["price"] != shocked[t]["price"] for t in base)


def test_missing_bars_is_vendor_gap_not_crash(cfg):
    empty = DataBundle(tickers=["AAPL"])
    r = run_features(empty, cfg, only=["analyze", "backtest"])
    assert r["analyze"].status == "vendor_gap" and r["backtest"].status == "vendor_gap"
    assert exit_code(r) == 2


def test_downstream_skipped_when_upstream_fails(cfg):
    r = run_features(DataBundle(tickers=["AAPL"]), cfg, only=["signals-top"])
    assert r["signals-top"].status == "skipped_input"


def test_unknown_slug_rejected(bundle, cfg):
    with pytest.raises(LabError):
        run_features(bundle, cfg, only=["nope"])


def test_no_positions_is_skipped_input(bundle, cfg):
    b = bundle.copy()
    b.positions = None
    assert run_features(b, cfg, only=["portfolio-health"])["portfolio-health"].status == "skipped_input"


def test_feature_crash_is_isolated(bundle, cfg, monkeypatch):
    spec = FEATURES["holdfold"]
    monkeypatch.setitem(FEATURES, "holdfold", dataclasses.replace(spec, fn=lambda *a: 1 / 0))
    r = run_features(bundle, cfg, only=["holdfold", "signals-top"])
    assert r["holdfold"].status == "error" and r["signals-top"].status == "ok"
    assert exit_code(r) == 1


def test_finnhub_candles_is_loud_gap():
    p = FinnhubProvider("k", ResponseCache(":memory:"))
    with pytest.raises(VendorGapError, match="stock/candle"):
        p.daily_bars(["AAPL"], 30)


def test_finnhub_403_maps_to_gap_and_token_in_header(monkeypatch):
    import httpx

    seen = {}

    def handler(request):
        seen["headers"], seen["url"] = request.headers, str(request.url)
        return httpx.Response(403)

    monkeypatch.setattr("nwf_lab.data.finnhub.FINNHUB_MIN_INTERVAL_S", 0)
    p = FinnhubProvider("SECRET", ResponseCache(":memory:"), httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(VendorGapError):
        p.profile("AAPL")
    assert seen["headers"]["x-finnhub-token"] == "SECRET" and "SECRET" not in seen["url"]


def test_finnhub_cache_avoids_second_call(monkeypatch):
    import httpx

    calls = []
    monkeypatch.setattr("nwf_lab.data.finnhub.FINNHUB_MIN_INTERVAL_S", 0)
    client = httpx.Client(transport=httpx.MockTransport(lambda r: calls.append(1) or httpx.Response(200, json={"name": "X"})))
    p = FinnhubProvider("k", ResponseCache(":memory:"), client)
    p.profile("AAPL"); p.profile("AAPL")
    assert len(calls) == 1


def test_symbology():
    assert to_alpaca("BRK-B") == "BRK.B" and to_yahoo("BRK.B") == "BRK-B"


def test_backtest_no_overlap_and_bounds(bundle, cfg):
    d = run_features(bundle, cfg, only=["backtest"])["backtest"]
    for t, stats in d.data.items():
        assert stats["max_drawdown"] <= 0
        tdf = d.frames[t]
        if len(tdf) > 1:
            assert (tdf["entry_date"].iloc[1:].values > tdf["exit_date"].iloc[:-1].values).all() or \
                   (tdf["entry_date"].iloc[1:].values >= tdf["exit_date"].iloc[:-1].values).all()


def test_paper_engine_nav_never_negative(bundle, cfg):
    r = run_features(bundle, cfg, only=["paper-engine"])["paper-engine"]
    assert (r.frames["nav"]["nav"] > 0).all()
    assert isinstance(r.frames["orders"], pd.DataFrame)
