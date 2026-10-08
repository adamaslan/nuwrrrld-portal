"""Hold / Fold verdicts (Section 9.3). Everything here is code; an LLM may only phrase the rationale."""
from __future__ import annotations

from dataclasses import dataclass

ATR_CLAMP = (0.5, 4.0)
VOL_BOUNDS = ((0.25, "calm"), (0.75, "normal"), (0.95, "elevated"))


@dataclass(frozen=True)
class Verdict:
    ticker: str
    position_side: str
    verdict: str
    bias: str
    risk_level: str
    vol_regime: str
    readings: dict
    invalidation_price: float | None


def vol_regime(percentile: float | None) -> str:
    if percentile is None:
        return "normal"
    for bound, label in VOL_BOUNDS:
        if percentile < bound:
            return label
    return "extreme"


def bias_from(readings: dict) -> str:
    """Trend + momentum composite in [-1, 1]."""
    score = 0.0
    close, sma50, sma200 = readings.get("close"), readings.get("sma_50"), readings.get("sma_200")
    if close is not None and sma200 is not None:
        score += 0.4 if close > sma200 else -0.4
    if sma50 is not None and sma200 is not None:
        score += 0.2 if sma50 > sma200 else -0.2
    hist = readings.get("macd_hist")
    if hist is not None:
        score += 0.2 if hist > 0 else -0.2
    rsi = readings.get("rsi_14")
    if rsi is not None:
        score += 0.2 if rsi > 55 else -0.2 if rsi < 45 else 0.0
    return "bullish" if score > 0.25 else "bearish" if score < -0.25 else "neutral"


def invalidation(side: str, readings: dict, recent_low: float | None, recent_high: float | None) -> float | None:
    """Structure-based level (swing low for longs, swing high for shorts) clamped to [0.5, 4] x ATR14."""
    close, atr = readings.get("close"), readings.get("atr_14")
    if close is None or not atr:
        return None
    lo_k, hi_k = ATR_CLAMP
    if side == "long":
        raw = recent_low if recent_low is not None else close - 2 * atr
        dist = min(max(close - raw, lo_k * atr), hi_k * atr)
        return round(close - dist, 2)
    raw = recent_high if recent_high is not None else close + 2 * atr
    dist = min(max(raw - close, lo_k * atr), hi_k * atr)
    return round(close + dist, 2)


def risk_level(close: float | None, inval: float | None, atr: float | None, regime: str, drawdown: float | None) -> str:
    if close is None or inval is None or not atr:
        return "moderate"
    atr_units = abs(close - inval) / atr
    pts = (2 if atr_units < 1 else 1 if atr_units < 2 else 0)  # tight stop = easily tagged
    pts += {"calm": 0, "normal": 0, "elevated": 1, "extreme": 2}[regime]
    pts += 2 if (drawdown or 0) <= -0.20 else 1 if (drawdown or 0) <= -0.10 else 0
    return "low" if pts <= 1 else "moderate" if pts == 2 else "elevated" if pts <= 4 else "high"


def compute(ticker: str, side: str, readings: dict, recent_low: float | None,
            recent_high: float | None, drawdown: float | None = None) -> Verdict:
    """side is the position side being assessed: 'long' or 'short'."""
    bias = bias_from(readings)
    regime = vol_regime(readings.get("rvol_pct_252"))
    inval = invalidation(side, readings, recent_low, recent_high)
    close = readings.get("close")
    supports = (bias == "bullish") if side == "long" else (bias == "bearish")
    right_side = inval is not None and close is not None and (close > inval if side == "long" else close < inval)
    verdict = "hold" if supports and right_side else "fold"
    return Verdict(ticker, side, verdict, bias, risk_level(close, inval, readings.get("atr_14"), regime, drawdown),
                   regime, {k: readings.get(k) for k in
                            ("close", "sma_50", "sma_200", "macd_hist", "rsi_14", "atr_14", "rvol_pct_252")}, inval)


def personal_context(side: str, entry_price: float | None, close: float | None, inval: float | None) -> dict:
    out: dict = {"side": side}
    if entry_price and close:
        pnl = (close - entry_price) / entry_price * (1 if side == "long" else -1)
        out["unrealized_pnl_pct"] = round(pnl * 100, 2)
    if inval and close:
        out["distance_to_invalidation_pct"] = round(abs(close - inval) / close * 100, 2)
    return out
