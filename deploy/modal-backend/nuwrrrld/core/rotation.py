"""Relative-rotation quadrants (RS-ratio / RS-momentum vs. benchmark) for the tracked ETFs."""
from __future__ import annotations

import pandas as pd

RATIO_FAST, RATIO_SLOW, MOMENTUM_LAG = 10, 63, 10


def rs_ratio_momentum(close: pd.Series, bench: pd.Series) -> pd.DataFrame:
    rs = (close / bench).dropna()
    ratio = 100 * rs.rolling(RATIO_FAST).mean() / rs.rolling(RATIO_SLOW).mean()
    momentum = 100 * ratio / ratio.shift(MOMENTUM_LAG)
    return pd.DataFrame({"rs_ratio": ratio, "rs_momentum": momentum})


def quadrant(ratio: float, momentum: float) -> str:
    if ratio >= 100:
        return "leading" if momentum >= 100 else "weakening"
    return "improving" if momentum >= 100 else "lagging"


def snapshot(closes: dict[str, pd.Series], bench: pd.Series, as_of) -> list[dict]:
    rows = []
    for ticker, series in closes.items():
        frame = rs_ratio_momentum(series.loc[:as_of], bench.loc[:as_of]).dropna()
        if frame.empty or frame.index[-1] != pd.Timestamp(as_of) and frame.index[-1] != as_of:
            continue
        r, m = float(frame["rs_ratio"].iloc[-1]), float(frame["rs_momentum"].iloc[-1])
        rows.append({"ticker": ticker, "as_of_date": as_of, "rs_ratio": round(r, 6),
                     "rs_momentum": round(m, 6), "quadrant": quadrant(r, m)})
    rows.sort(key=lambda x: (-(x["rs_ratio"] + x["rs_momentum"]), x["ticker"]))
    for rank, row in enumerate(rows, 1):
        row["rank"] = rank
    return rows
