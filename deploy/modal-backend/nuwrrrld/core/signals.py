"""Declarative rule engine: indicators -> signed strength, direction, timeframe, horizon, fired[]."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

NEUTRAL_BAND = 0.15
HORIZON_BY_TIMEFRAME = {"short_term": 5, "swing": 21, "position": 63}

Readings = dict[str, float | None]


@dataclass(frozen=True)
class Rule:
    rule_id: str
    indicator: str                                    # indicator row name reported in fired[]
    reading: str                                      # column in the readings dict
    sign: int                                         # +1 bullish, -1 bearish
    weight: float
    timeframe: str
    threshold: float | str
    test: Callable[[Readings, Readings], bool]
    lookback: int = 1


def _gt(a, b): return a is not None and b is not None and a > b
def _lt(a, b): return a is not None and b is not None and a < b


RULES: tuple[Rule, ...] = (
    Rule("rsi_cross_up_30", "rsi_14", "rsi_14", +1, 0.25, "short_term", 30,
         lambda r, p: p.get("rsi_14") is not None and r.get("rsi_14") is not None and p["rsi_14"] <= 30 < r["rsi_14"], 2),
    Rule("rsi_cross_down_70", "rsi_14", "rsi_14", -1, 0.25, "short_term", 70,
         lambda r, p: p.get("rsi_14") is not None and r.get("rsi_14") is not None and p["rsi_14"] >= 70 > r["rsi_14"], 2),
    Rule("rsi_oversold", "rsi_14", "rsi_14", +1, 0.10, "short_term", 30, lambda r, p: _lt(r.get("rsi_14"), 30)),
    Rule("rsi_overbought", "rsi_14", "rsi_14", -1, 0.10, "short_term", 70, lambda r, p: _gt(r.get("rsi_14"), 70)),
    Rule("macd_hist_pos_rising", "macd_12_26_9", "macd_hist", +1, 0.20, "swing", 0,
         lambda r, p: _gt(r.get("macd_hist"), 0) and _gt(r.get("macd_hist"), p.get("macd_hist")), 2),
    Rule("macd_hist_neg_falling", "macd_12_26_9", "macd_hist", -1, 0.20, "swing", 0,
         lambda r, p: _lt(r.get("macd_hist"), 0) and _lt(r.get("macd_hist"), p.get("macd_hist")), 2),
    Rule("close_above_sma200", "sma_200", "sma_200", +1, 0.20, "position", "close>sma_200",
         lambda r, p: _gt(r.get("close"), r.get("sma_200")), 200),
    Rule("close_below_sma200", "sma_200", "sma_200", -1, 0.20, "position", "close<sma_200",
         lambda r, p: _lt(r.get("close"), r.get("sma_200")), 200),
    Rule("sma50_above_sma200", "sma_50", "sma_50", +1, 0.15, "position", "sma_50>sma_200",
         lambda r, p: _gt(r.get("sma_50"), r.get("sma_200")), 200),
    Rule("sma50_below_sma200", "sma_50", "sma_50", -1, 0.15, "position", "sma_50<sma_200",
         lambda r, p: _lt(r.get("sma_50"), r.get("sma_200")), 200),
    Rule("adx_trend_up", "adx_14", "adx_14", +1, 0.20, "swing", 25,
         lambda r, p: _gt(r.get("adx_14"), 25) and _gt(r.get("plus_di"), r.get("minus_di")), 14),
    Rule("adx_trend_down", "adx_14", "adx_14", -1, 0.20, "swing", 25,
         lambda r, p: _gt(r.get("adx_14"), 25) and _gt(r.get("minus_di"), r.get("plus_di")), 14),
    Rule("bb_below_lower", "bb_20_2", "bb_pct_b", +1, 0.10, "short_term", 0, lambda r, p: _lt(r.get("bb_pct_b"), 0), 20),
    Rule("bb_above_upper", "bb_20_2", "bb_pct_b", -1, 0.10, "short_term", 1, lambda r, p: _gt(r.get("bb_pct_b"), 1), 20),
    Rule("rs_positive", "rs_bench_63", "rs_bench_63", +1, 0.15, "swing", 0, lambda r, p: _gt(r.get("rs_bench_63"), 0), 63),
    Rule("rs_negative", "rs_bench_63", "rs_bench_63", -1, 0.15, "swing", 0, lambda r, p: _lt(r.get("rs_bench_63"), 0), 63),
)


@dataclass(frozen=True)
class SignalResult:
    ticker: str
    direction: str
    strength: float
    timeframe: str
    horizon_days: int
    fired_indicators: list[dict]


def evaluate(ticker: str, latest: Readings, prev: Readings) -> SignalResult:
    fired, score = [], 0.0
    tf_weight = {"short_term": 0.0, "swing": 0.0, "position": 0.0}
    for rule in RULES:
        if not rule.test(latest, prev):
            continue
        score += rule.sign * rule.weight
        tf_weight[rule.timeframe] += rule.weight
        fired.append({"indicator": rule.indicator, "reading": latest.get(rule.reading), "threshold": rule.threshold,
                      "rule": rule.rule_id, "weight": rule.sign * rule.weight, "lookback": rule.lookback,
                      "timeframe": rule.timeframe})
    strength = max(-1.0, min(1.0, round(score, 3)))
    direction = "bullish" if strength > NEUTRAL_BAND else "bearish" if strength < -NEUTRAL_BAND else "neutral"
    # Dominant timeframe = largest summed weight; ties resolve deterministically toward the longer horizon.
    timeframe = max(("position", "swing", "short_term"), key=lambda t: (tf_weight[t], HORIZON_BY_TIMEFRAME[t]))
    return SignalResult(ticker, direction, strength, timeframe, HORIZON_BY_TIMEFRAME[timeframe], fired)
