"""backtest: replay the vote rule over each ticker's history; enter on BUY, hold N bars, no overlap."""
from __future__ import annotations

import numpy as np
import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import VendorGapError
from nwf_lab.features.indicators import indicator_frame, score_series
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok


def backtest_symbol(df: pd.DataFrame, cfg: LabConfig) -> tuple[dict, pd.DataFrame]:
    frame = indicator_frame(df, cfg)
    score = score_series(frame, cfg)
    close = df["close"].to_numpy()
    n, hold = len(df), cfg.backtest_hold_days
    trades, i = [], max(cfg.backtest_min_bars, cfg.sma_slow)
    while i < n - hold:
        if score.iloc[i] >= cfg.buy_score:
            entry, exit_ = close[i], close[i + hold]
            trades.append({"entry_date": df.index[i], "exit_date": df.index[i + hold],
                           "entry": entry, "exit": exit_, "ret": exit_ / entry - 1})
            i += hold
        else:
            i += 1
    tdf = pd.DataFrame(trades, columns=["entry_date", "exit_date", "entry", "exit", "ret"])
    if tdf.empty:
        return {"trades": 0, "hit_rate": None, "avg_return": None, "total_return": 0.0,
                "max_drawdown": 0.0, "bars_scanned": n}, tdf
    equity = (1 + tdf["ret"]).cumprod()
    peak = np.maximum.accumulate(equity.to_numpy())
    tdf["equity"] = equity
    return {
        "trades": len(tdf), "hit_rate": round(float((tdf["ret"] > 0).mean()), 3),
        "avg_return": round(float(tdf["ret"].mean()), 4),
        "total_return": round(float(equity.iloc[-1] - 1), 4),
        "max_drawdown": round(float((equity.to_numpy() / peak - 1).min()), 4),
        "bars_scanned": n,
    }, tdf


@feature("backtest", needs=("bars",))
def backtest(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    data, frames, sources = {}, {}, set()
    for sym, df in bundle.bars.items():
        if len(df) < cfg.backtest_min_bars + cfg.backtest_hold_days:
            continue
        data[sym], frames[sym] = backtest_symbol(df, cfg)
        sources.add(f"{df.attrs.get('source', '?')}:{df.attrs.get('feed', '?')}")
    if not data:
        raise VendorGapError("bars", "daily (not enough history)", None)
    return ok("backtest", data, frames, sorted(sources))
