import numpy as np
import pandas as pd

from nuwrrrld.core import holdfold, indicators, rotation, signals


def make_bars(n=320, drift=0.0006, seed=1, start=100.0):
    rng = np.random.default_rng(seed)
    close = start * np.cumprod(1 + drift + rng.normal(0, 0.01, n))
    idx = pd.bdate_range("2025-01-01", periods=n)
    high = close * (1 + rng.uniform(0, 0.01, n))
    low = close * (1 - rng.uniform(0, 0.01, n))
    return pd.DataFrame({"open": close, "high": high, "low": low, "close": close,
                         "volume": rng.integers(1_000_000, 2_000_000, n)}, index=idx)


def test_rsi_bounds_and_extremes():
    up = pd.Series(np.arange(1, 60, dtype=float))
    assert indicators.rsi(up).iloc[-1] == 100.0
    down = pd.Series(np.arange(60, 1, -1, dtype=float))
    assert indicators.rsi(down).iloc[-1] < 1.0
    r = indicators.rsi(make_bars()["close"]).dropna()
    assert ((r >= 0) & (r <= 100)).all()


def test_indicators_are_causal_no_lookahead():
    bars = make_bars()
    full = indicators.compute_indicator_frame(bars)
    cut = 250
    partial = indicators.compute_indicator_frame(bars.iloc[:cut])
    # mutate the future: results for the past must not change
    mutated = bars.copy()
    mutated.iloc[cut:, mutated.columns.get_loc("close")] *= 3
    after = indicators.compute_indicator_frame(mutated)
    cols = [c for c in full.columns if c != "rvol_pct_252"]
    pd.testing.assert_frame_equal(partial[cols].iloc[:cut], after[cols].iloc[:cut], check_exact=False, rtol=1e-9)


def test_latest_readings_never_looks_past_as_of():
    bars = make_bars()
    frame = indicators.compute_indicator_frame(bars)
    as_of = bars.index[200]
    latest, prev = indicators.latest_readings(frame, as_of)
    assert latest["close"] == frame.loc[as_of, "close"]
    assert prev["close"] == frame["close"].iloc[199]


def test_macd_hist_is_line_minus_signal():
    m = indicators.macd(make_bars()["close"])
    assert np.allclose(m["hist"], m["macd"] - m["signal"], equal_nan=True)


def test_signal_strength_clipped_direction_and_timeframe():
    latest = {"close": 110, "sma_200": 100, "sma_50": 105, "rsi_14": 35, "macd_hist": 1.0, "adx_14": 30,
              "plus_di": 30, "minus_di": 10, "bb_pct_b": -0.1, "rs_bench_63": 0.05}
    prev = {"rsi_14": 28, "macd_hist": 0.5}
    s = signals.evaluate("XLE", latest, prev)
    assert -1.0 <= s.strength <= 1.0
    assert s.direction == "bullish"
    assert {f["rule"] for f in s.fired_indicators} >= {"rsi_cross_up_30", "close_above_sma200", "adx_trend_up"}
    assert s.horizon_days == signals.HORIZON_BY_TIMEFRAME[s.timeframe]
    for f in s.fired_indicators:
        assert {"indicator", "reading", "threshold", "rule", "weight", "lookback", "timeframe"} <= set(f)


def test_signal_neutral_band_and_no_rules():
    s = signals.evaluate("XLE", {}, {})
    assert s.direction == "neutral" and s.strength == 0 and s.fired_indicators == []


def test_signal_bearish():
    latest = {"close": 90, "sma_200": 100, "sma_50": 95, "rsi_14": 75, "macd_hist": -1, "adx_14": 30,
              "plus_di": 10, "minus_di": 30, "bb_pct_b": 1.2, "rs_bench_63": -0.05}
    prev = {"rsi_14": 71, "macd_hist": -0.5}
    s = signals.evaluate("XLE", latest, prev)
    assert s.direction == "bearish" and s.strength < 0


def test_vol_regime_boundaries():
    assert holdfold.vol_regime(0.10) == "calm"
    assert holdfold.vol_regime(0.50) == "normal"
    assert holdfold.vol_regime(0.80) == "elevated"
    assert holdfold.vol_regime(0.99) == "extreme"
    assert holdfold.vol_regime(None) == "normal"


def test_holdfold_invalidation_clamped_to_atr_band():
    r = {"close": 100.0, "atr_14": 2.0}
    far = holdfold.invalidation("long", r, recent_low=50.0, recent_high=None)       # 50 away -> clamp to 4 ATR
    near = holdfold.invalidation("long", r, recent_low=99.9, recent_high=None)      # 0.1 away -> clamp to 0.5 ATR
    assert far == 92.0 and near == 99.0
    assert holdfold.invalidation("short", r, None, 150.0) == 108.0


def test_holdfold_verdict_hold_vs_fold():
    bull = {"close": 110, "sma_50": 105, "sma_200": 100, "macd_hist": 1, "rsi_14": 60, "atr_14": 2, "rvol_pct_252": 0.5}
    assert holdfold.compute("XLE", "long", bull, 105, None).verdict == "hold"
    assert holdfold.compute("XLE", "short", bull, None, 115).verdict == "fold"


def test_personal_context_signs_pnl_by_side():
    assert holdfold.personal_context("long", 100, 110, 95)["unrealized_pnl_pct"] == 10.0
    assert holdfold.personal_context("short", 100, 110, 115)["unrealized_pnl_pct"] == -10.0


def test_rotation_quadrants():
    assert rotation.quadrant(101, 101) == "leading"
    assert rotation.quadrant(101, 99) == "weakening"
    assert rotation.quadrant(99, 99) == "lagging"
    assert rotation.quadrant(99, 101) == "improving"


def test_rotation_snapshot_ranks_leaders_first():
    bench = make_bars(seed=3)["close"]
    strong = bench * np.linspace(1, 1.5, len(bench))
    weak = bench * np.linspace(1, 0.6, len(bench))
    snap = rotation.snapshot({"UP": strong, "DOWN": weak}, bench, bench.index[-1])
    assert [r["ticker"] for r in snap] == ["UP", "DOWN"]
    assert [r["rank"] for r in snap] == [1, 2]
    by = {r["ticker"]: r for r in snap}
    assert by["UP"]["rs_ratio"] > 100 > by["DOWN"]["rs_ratio"]
