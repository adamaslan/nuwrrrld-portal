"""Deterministic technical indicators. All functions are causal: value at row t uses rows <= t only."""
from __future__ import annotations

import numpy as np
import pandas as pd

ENGINE_PARAMS = {"rsi": 14, "adx": 14, "atr": 14, "sma": (20, 50, 200), "bb": (20, 2.0), "rs_lookback": 63}


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(~((loss == 0) & gain.notna()), 100.0)


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    line = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
    sig = line.ewm(span=signal, adjust=False).mean()
    return pd.DataFrame({"macd": line, "signal": sig, "hist": line - sig})


def true_range(df: pd.DataFrame) -> pd.Series:
    prev = df["close"].shift(1)
    return pd.concat([df["high"] - df["low"], (df["high"] - prev).abs(), (df["low"] - prev).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def adx(df: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    up, down = df["high"].diff(), -df["low"].diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    atr_n = atr(df, n)
    plus_di = 100 * plus_dm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr_n
    minus_di = 100 * minus_dm.ewm(alpha=1 / n, adjust=False, min_periods=n).mean() / atr_n
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return pd.DataFrame({"adx": dx.ewm(alpha=1 / n, adjust=False, min_periods=n).mean(),
                         "plus_di": plus_di, "minus_di": minus_di})


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    mid = close.rolling(n).mean()
    sd = close.rolling(n).std(ddof=0)
    upper, lower = mid + k * sd, mid - k * sd
    width = (upper - lower).replace(0, np.nan)
    return pd.DataFrame({"mid": mid, "upper": upper, "lower": lower,
                         "pct_b": (close - lower) / width, "bandwidth": width / mid})


def relative_strength(close: pd.Series, bench: pd.Series, lookback: int = 63) -> pd.Series:
    """Excess total return of `close` over `bench` across `lookback` sessions."""
    aligned = pd.concat([close, bench], axis=1, keys=["a", "b"]).dropna()
    return (aligned["a"].pct_change(lookback) - aligned["b"].pct_change(lookback)).reindex(close.index)


def realized_vol(close: pd.Series, n: int = 20) -> pd.Series:
    return close.pct_change().rolling(n).std(ddof=0) * np.sqrt(252)


def _num(x) -> float | None:
    return None if x is None or (isinstance(x, float) and np.isnan(x)) or pd.isna(x) else float(x)


def compute_indicator_frame(bars: pd.DataFrame, bench: pd.DataFrame | None = None) -> pd.DataFrame:
    """Per-row indicator columns for an OHLCV frame indexed by date with columns open/high/low/close/volume."""
    c = bars["close"]
    out = pd.DataFrame(index=bars.index)
    out["close"] = c
    out["rsi_14"] = rsi(c, 14)
    m = macd(c)
    out["macd"], out["macd_signal"], out["macd_hist"] = m["macd"], m["signal"], m["hist"]
    d = adx(bars, 14)
    out["adx_14"], out["plus_di"], out["minus_di"] = d["adx"], d["plus_di"], d["minus_di"]
    out["atr_14"] = atr(bars, 14)
    for n in ENGINE_PARAMS["sma"]:
        out[f"sma_{n}"] = c.rolling(n).mean()
    out["ema_20"] = c.ewm(span=20, adjust=False).mean()
    b = bollinger(c)
    out["bb_pct_b"], out["bb_bandwidth"] = b["pct_b"], b["bandwidth"]
    out["vol_ratio_20"] = bars["volume"] / bars["volume"].rolling(20).mean()
    out["dist_52w_high"] = c / c.rolling(252, min_periods=60).max() - 1
    out["dist_52w_low"] = c / c.rolling(252, min_periods=60).min() - 1
    out["rvol_20"] = realized_vol(c, 20)
    out["rvol_pct_252"] = out["rvol_20"].rolling(252, min_periods=60).apply(
        lambda w: float((w <= w.iloc[-1]).mean()), raw=False)
    if bench is not None and not bench.empty:
        out["rs_bench_63"] = relative_strength(c, bench["close"], ENGINE_PARAMS["rs_lookback"])
    return out


def latest_readings(frame: pd.DataFrame, as_of) -> tuple[dict[str, float | None], dict[str, float | None]]:
    """(latest, previous) readings at or before as_of - never looks past it."""
    sub = frame.loc[:as_of]
    if sub.empty:
        return {}, {}
    last = {k: _num(v) for k, v in sub.iloc[-1].items()}
    prev = {k: _num(v) for k, v in sub.iloc[-2].items()} if len(sub) > 1 else {}
    return last, prev


INDICATOR_ROWS = {  # indicator row name -> (primary column, component columns)
    "rsi_14": ("rsi_14", []),
    "macd_12_26_9": ("macd_hist", ["macd", "macd_signal", "macd_hist"]),
    "adx_14": ("adx_14", ["plus_di", "minus_di"]),
    "atr_14": ("atr_14", []),
    "sma_20": ("sma_20", []), "sma_50": ("sma_50", []), "sma_200": ("sma_200", []),
    "bb_20_2": ("bb_pct_b", ["bb_pct_b", "bb_bandwidth"]),
    "vol_ratio_20": ("vol_ratio_20", []),
    "dist_52w": ("dist_52w_high", ["dist_52w_high", "dist_52w_low"]),
    "rvol_20": ("rvol_20", ["rvol_pct_252"]),
    "rs_bench_63": ("rs_bench_63", []),
}


def to_indicator_rows(ticker: str, bar_date, latest: dict, engine_version: str) -> list[dict]:
    rows = []
    for name, (primary, comps) in INDICATOR_ROWS.items():
        value = latest.get(primary)
        if value is None:
            continue
        rows.append({"ticker": ticker, "bar_date": bar_date, "indicator": name, "value": value,
                     "components": {c: latest.get(c) for c in comps}, "engine_version": engine_version})
    return rows
