"""fib: Fibonacci retracement/extension levels from the dominant swing in the lookback window."""
from __future__ import annotations

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import VendorGapError
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

RETRACEMENTS = (0.236, 0.382, 0.5, 0.618, 0.786)
EXTENSIONS = (1.272, 1.618)
SUPPORT_ZONE = (0.382, 0.5, 0.618)
MIN_BARS = 30


def fib_symbol(df: pd.DataFrame, cfg: LabConfig) -> dict:
    w = df.iloc[-cfg.fib_lookback:]
    hi, lo = float(w["high"].max()), float(w["low"].min())
    rng = hi - lo
    uptrend = w["high"].idxmax() > w["low"].idxmin()      # low came first, then the high
    price = float(df["close"].iloc[-1])

    def level(r: float) -> float:
        return hi - r * rng if uptrend else lo + r * rng

    def ext(r: float) -> float:
        return lo + r * rng if uptrend else hi - r * rng

    levels = {f"{r:g}": round(level(r), 2) for r in RETRACEMENTS}
    levels.update({f"{r:g}": round(ext(r), 2) for r in EXTENSIONS})
    nearest_key = min(levels, key=lambda k: abs(levels[k] - price))
    dist = (price - levels[nearest_key]) / price
    at_level = abs(dist) <= cfg.fib_tolerance

    deepest = level(RETRACEMENTS[-1])
    broke_deep = price < deepest if uptrend else price > deepest
    if rng <= 0:
        bias, why = "neutral", "flat range"
    elif broke_deep:
        bias = "bearish" if uptrend else "bullish"
        why = f"through the 0.786 level: the {'up' if uptrend else 'down'}swing is failing"
    elif at_level and nearest_key in {f"{r:g}" for r in SUPPORT_ZONE}:
        bias = "bullish" if uptrend else "bearish"
        why = f"at the {nearest_key} retracement: {'support in an uptrend' if uptrend else 'resistance in a downtrend'}"
    elif (price > hi if uptrend else price < lo):
        bias, why = ("bullish" if uptrend else "bearish"), "beyond the swing extreme: trend continuing"
    else:
        bias, why = "neutral", f"between levels; nearest is {nearest_key} ({dist:+.1%})"
    return {
        "bias": bias, "why": why, "trend": "up" if uptrend else "down",
        "swing_high": round(hi, 2), "swing_low": round(lo, 2), "price": round(price, 2),
        "levels": levels, "nearest_level": nearest_key, "distance_pct": round(dist * 100, 2),
        "at_level": at_level,
    }


@feature("fib", needs=("bars",))
def fib(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    data = {s: fib_symbol(df, cfg) for s, df in bundle.bars.items() if len(df) >= MIN_BARS}
    if not data:
        raise VendorGapError("bars", "daily", None)
    return ok("fib", data, sources=["bars"])
