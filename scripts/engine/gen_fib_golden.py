"""Generate the Fibonacci golden fixture from the canonical Python engine.

The TypeScript engine in lib/engine/ must reproduce signals-app's
indicators/pivots.py, indicators/fibonacci.py and detection/fibonacci.py
exactly. This script runs that Python code bar by bar (df.iloc[:i+1], the same
point-in-time slicing the detector sees in production) over deterministic
synthetic series plus a few real tickers, and writes everything the TS side
asserts against: the signals from both the default and experimental detector
on every bar, and (every STRUCTURE_EVERY bars) ATR, Volume_MA_20, legs and
confluence zones.

Run from the portal root (needs the signals-app mamba env and a signals-app
checkout that contains the fib detector — PR #38's worktree until it merges):

    SIGNALS_APP_SRC=~/code/signals-app-fib/src \
      mamba run -n signals-app python scripts/engine/gen_fib_golden.py

Real tickers need network (yfinance). Pass --synthetic-only to skip them.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.expanduser(os.environ.get("SIGNALS_APP_SRC", "~/code/signals-app-fib/src")))

from signals_app.detection.fibonacci import FibonacciDetector  # noqa: E402
from signals_app.indicators.compute import _atr_series, _volume_ma_series  # noqa: E402
from signals_app.indicators.fibonacci import confluence_zones, recent_legs  # noqa: E402

OUT_PATH = Path("__tests__/fixtures/fib-golden.json")
BARS_PER_SERIES = 260
REAL_TICKERS = ("AAPL", "AMD", "XLU", "SPY", "TSLA")
REAL_PERIOD = "2y"
STRUCTURE_EVERY = 5  # legs/zones sampled every Nth bar (and the last) to keep the fixture small
SYNTHETIC_SEEDS = {"synth-up": (11, 0.0012), "synth-down": (23, -0.0010), "synth-chop": (37, 0.0)}


def synthetic_series(seed: int, drift: float, n: int) -> pd.DataFrame:
    """Deterministic OHLCV random walk with swings big enough to form legs."""
    rng = np.random.default_rng(seed)
    close = [100.0]
    for t in range(1, n):
        cycle = 0.012 * np.sin(t / 9.0)
        close.append(close[-1] * (1 + drift + cycle + rng.normal(0, 0.014)))
    close_arr = np.round(np.array(close), 4)
    open_arr = np.round(np.concatenate([[close_arr[0]], close_arr[:-1]]) * (1 + rng.normal(0, 0.003, n)), 4)
    spread = np.abs(rng.normal(0, 0.012, n)) * close_arr
    high = np.round(np.maximum(open_arr, close_arr) + spread * rng.uniform(0.2, 1.0, n), 4)
    low = np.round(np.minimum(open_arr, close_arr) - spread * rng.uniform(0.2, 1.0, n), 4)
    volume = np.round(rng.lognormal(13, 0.5, n)).astype(float)
    return pd.DataFrame({"Open": open_arr, "High": high, "Low": low, "Close": close_arr, "Volume": volume})


def real_series(ticker: str) -> pd.DataFrame | None:
    import yfinance as yf

    df = yf.download(ticker, period=REAL_PERIOD, interval="1d", auto_adjust=False, progress=False)
    if df is None or df.empty:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df[["Open", "High", "Low", "Close", "Volume"]].dropna().tail(BARS_PER_SERIES)
    # Rounded before anything is computed, so the fixture stores exactly the
    # inputs the Python side saw, in a compact form.
    return df.reset_index(drop=True).astype(float).round({"Open": 4, "High": 4, "Low": 4, "Close": 4, "Volume": 0})


def with_indicators(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out["ATR"] = _atr_series(out["High"], out["Low"], out["Close"])["ATR"]
    out["Volume_MA_20"] = _volume_ma_series(out["Volume"])["Volume_MA_20"]
    return out


def num(value: float) -> float | None:
    v = float(value)
    return None if (np.isnan(v) or np.isinf(v)) else v


SIGNAL_FIELDS = ("signal", "description", "strength", "category")


def signal_dicts(signals: list) -> list[dict]:
    return [{k: s.to_dict()[k] for k in SIGNAL_FIELDS} for s in signals]


def bar_record(frame: pd.DataFrame, default: FibonacciDetector, experimental: FibonacciDetector,
               with_structure: bool) -> dict:
    """One bar's expected output. Empty signal lists are omitted to keep the file small."""
    record: dict = {}
    for key, detector in (("signals", default), ("experimentalSignals", experimental)):
        found = signal_dicts(detector.detect(frame))
        if found:
            record[key] = found
    if not with_structure:
        return record
    atr = num(frame["ATR"].iloc[-1])
    legs = recent_legs(frame, atr) if atr else []
    record.update({
        "atr": atr,
        "volumeMa20": num(frame["Volume_MA_20"].iloc[-1]),
        "legs": [
            {"low": leg.low, "high": leg.high, "isUp": leg.is_up, "endIndex": leg.end_index}
            for leg in legs
        ],
        "zones": [[price, n] for price, n in confluence_zones(legs, atr)] if atr else [],
    })
    return record


def series_record(name: str, raw: pd.DataFrame) -> dict:
    frame = with_indicators(raw)
    default, experimental = FibonacciDetector(), FibonacciDetector(experimental=True)
    last = len(frame) - 1
    bars = [
        bar_record(frame.iloc[: i + 1], default, experimental, i % STRUCTURE_EVERY == 0 or i == last)
        for i in range(len(frame))
    ]
    return {
        "name": name,
        "ohlcv": raw[["Open", "High", "Low", "Close", "Volume"]].values.tolist(),
        "bars": bars,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--synthetic-only", action="store_true")
    args = parser.parse_args()

    series = [series_record(name, synthetic_series(seed, drift, BARS_PER_SERIES))
              for name, (seed, drift) in SYNTHETIC_SEEDS.items()]
    if not args.synthetic_only:
        for ticker in REAL_TICKERS:
            raw = real_series(ticker)
            if raw is None:
                print(f"skip {ticker}: no data", file=sys.stderr)
                continue
            series.append(series_record(ticker, raw))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({"generatedFrom": "signals-app indicators/fibonacci.py + detection/fibonacci.py",
                                    "series": series}, separators=(",", ":")))
    n_signals = sum(len(b.get("signals", [])) for s in series for b in s["bars"])
    n_exp = sum(len(b.get("experimentalSignals", [])) for s in series for b in s["bars"])
    print(f"wrote {OUT_PATH}: {len(series)} series, {n_signals} default signals, {n_exp} experimental signals")


if __name__ == "__main__":
    main()
