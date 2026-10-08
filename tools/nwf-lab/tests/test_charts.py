import time

import pandas as pd
import pytest

from nwf_lab import charts
from nwf_lab.config import LabConfig
from nwf_lab.features.registry import run_features
from nwf_lab.pipeline import fetch_fixture

BIG = 1000


@pytest.fixture(scope="module")
def big():
    cfg = LabConfig()
    bundle = fetch_fixture([f"T{i:04d}" for i in range(BIG)], 400, cfg, None)
    results = run_features(bundle, cfg, only=["analyze", "backtest", "signals-top"])
    return bundle, results


def test_period_returns_cover_every_ticker_and_period(big):
    bundle, _ = big
    returns = charts.period_returns(charts.close_panel(bundle))
    assert returns.shape == (BIG, len(charts.RETURN_PERIODS))
    assert returns.notna().all().all()


def test_period_returns_match_a_hand_computed_value(bundle):
    panel = charts.close_panel(bundle)
    sym = panel.columns[0]
    expected = (panel[sym].iloc[-1] / panel[sym].iloc[-2] - 1) * 100
    assert charts.period_returns(panel).loc[sym, "1D"] == pytest.approx(expected)


def test_short_history_gives_nan_not_a_wrong_number(bundle):
    panel = charts.close_panel(bundle).iloc[-10:]
    returns = charts.period_returns(panel)
    assert returns["1Y"].isna().all() and returns["1D"].notna().all()


def test_heatmap_caps_rows_at_a_thousand_tickers(big):
    bundle, _ = big
    returns = charts.period_returns(charts.close_panel(bundle))
    fig = charts.returns_heatmap(returns, "1M", max_rows=60)
    assert len(fig.data[0].y) == 60
    best, worst = fig.data[0].y[0], fig.data[0].y[-1]
    assert returns.loc[best, "1M"] >= returns.loc[worst, "1M"]
    assert len(charts.returns_heatmap(returns, "1M", max_rows=None).data[0].y) == BIG


def test_fan_chart_trace_count_is_independent_of_ticker_count(big):
    bundle, results = big
    fan = charts.compare_rebased(charts.close_panel(bundle), "6M", highlight=5)
    assert len(fan.data) <= 4 + 1 + 2 * 5
    equity = charts.backtest_equity(results["backtest"], period="All")
    assert len(equity.data) <= 4 + 1 + 2 * 5


def test_few_tickers_still_get_one_line_each(bundle):
    fig = charts.compare_rebased(charts.close_panel(bundle), "3M")
    assert [t.name for t in fig.data] == list(bundle.bars)


def test_rebased_panel_starts_at_base(big):
    bundle, _ = big
    reb = charts.rebased_panel(charts.close_panel(bundle), "3M")
    assert (reb.iloc[0].round(6) == 100.0).all()


@pytest.mark.parametrize("period", charts.CHART_PERIODS)
@pytest.mark.parametrize("freq", list(charts.FREQUENCIES))
def test_candles_every_period_and_frequency(bundle, cfg, period, freq):
    results = run_features(bundle, cfg, only=["analyze"])
    fig = charts.candles_with_bands(bundle, results, "AAPL", period, freq)
    candle = fig.data[0]
    assert len(candle.x) > 0
    if period != "All":
        start = charts.period_start(bundle.bars["AAPL"].index[-1], period)
        assert pd.Timestamp(candle.x[0]) >= start - pd.Timedelta(days=7 if freq == "Weekly" else 31)


def test_weekly_has_fewer_bars_than_daily(bundle, cfg):
    results = run_features(bundle, cfg, only=["analyze"])
    daily = charts.candles_with_bands(bundle, results, "AAPL", "1Y", "Daily").data[0]
    weekly = charts.candles_with_bands(bundle, results, "AAPL", "1Y", "Weekly").data[0]
    assert len(weekly.x) < len(daily.x) / 3


def test_empty_inputs_render_a_message_not_a_crash():
    assert charts.compare_rebased(pd.DataFrame()).layout.annotations
    assert charts.returns_heatmap(pd.DataFrame(columns=charts.RETURN_PERIODS)).layout.annotations


def test_leaderboard_switches_to_horizontal_for_long_lists(big):
    _, results = big
    cfg = LabConfig(top_n=80)
    bundle_results = run_features(big[0], cfg, only=["signals-top"])
    assert bundle_results["signals-top"].frames["ranked"].shape[0] == 80
    assert charts.leaderboard(bundle_results["signals-top"]).data[0].orientation == "h"


def test_thousand_ticker_charts_build_quickly(big):
    bundle, results = big
    t0 = time.perf_counter()
    panel = charts.close_panel(bundle)
    returns = charts.period_returns(panel)
    charts.returns_heatmap(returns)
    charts.movers(returns, "1M")
    charts.score_distribution(results["analyze"])
    charts.compare_rebased(panel, "1Y")
    charts.backtest_equity(results["backtest"])
    assert time.perf_counter() - t0 < 10
