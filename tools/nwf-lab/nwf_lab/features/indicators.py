"""Shared indicator math. analyze (last row) and backtest/paper (every row) use the same code,
so the live signal and the replayed signal can never disagree."""
from __future__ import annotations

import numpy as np
import pandas as pd
import ta

from nwf_lab.config import LabConfig

MIN_BARS = 30


def indicator_frame(df: pd.DataFrame, cfg: LabConfig) -> pd.DataFrame:
    c, v = df["close"], df["volume"]
    macd = ta.trend.MACD(c, cfg.macd_slow, cfg.macd_fast, cfg.macd_signal)
    bb = ta.volatility.BollingerBands(c, cfg.bb_window, cfg.bb_std)
    out = pd.DataFrame(index=df.index)
    out["close"] = c
    out["rsi"] = ta.momentum.RSIIndicator(c, cfg.rsi_window).rsi()
    out["macd"], out["macd_signal"], out["macd_hist"] = (
        macd.macd(), macd.macd_signal(), macd.macd_diff(),
    )
    out["bb_upper"], out["bb_lower"], out["bb_mid"] = (
        bb.bollinger_hband(), bb.bollinger_lband(), bb.bollinger_mavg(),
    )
    out["sma_fast"] = c.rolling(cfg.sma_fast).mean()
    out["sma_slow"] = c.rolling(cfg.sma_slow).mean().fillna(out["sma_fast"])
    out["ema20"] = c.ewm(span=20).mean()
    avg_vol = v.rolling(cfg.vol_window).mean()
    out["vol_ratio"] = (v / avg_vol).where(avg_vol > 0, 1.0)
    out["price_vs_sma"] = (c - out["sma_fast"]) / out["sma_fast"]
    return out


def votes(frame: pd.DataFrame, cfg: LabConfig) -> tuple[pd.Series, pd.Series]:
    bull = (
        (frame["rsi"] > cfg.rsi_bull).astype(int) + (frame["macd_hist"] > 0).astype(int)
        + (frame["price_vs_sma"] > 0).astype(int) + (frame["vol_ratio"] > cfg.vol_surge).astype(int)
    )
    bear = (
        (frame["rsi"] < cfg.rsi_bear).astype(int) + (frame["macd_hist"] < 0).astype(int)
        + (frame["price_vs_sma"] < 0).astype(int) + (frame["vol_ratio"] < cfg.vol_dry).astype(int)
    )
    return bull, bear


def score_series(frame: pd.DataFrame, cfg: LabConfig) -> pd.Series:
    bull, bear = votes(frame, cfg)
    return (50 + (bull - bear) * 12.5).round()


def direction_of(bull: int, bear: int, cfg: LabConfig) -> str:
    """Same tiers as homebase/locrun.py:analyze (strong at 3 votes, weak at the configured threshold)."""
    t = cfg.bull_vote_threshold
    if bull >= 3:
        return "bullish"
    if bear >= 3:
        return "bearish"
    if bull >= t:
        return "bullish"
    if bear >= t:
        return "bearish"
    return "neutral"


def action_of(score: float, cfg: LabConfig) -> str:
    return "BUY" if score >= cfg.buy_score else "SELL" if score <= cfg.sell_score else "HOLD"


def finite(x) -> float | None:
    return None if x is None or not np.isfinite(x) else float(x)
