"""paper-engine: replay the 'quant' policy (lib/shared/paper-policy.ts v1) over the bundle's history.

Simplified port: signal-only entries/exits at the close, equal weight capped at the max position
weight, no sector caps, no turnover limit, no arbitration. It shows the shape of the NAV curve, not
the exact production fills."""
from __future__ import annotations

import pandas as pd

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import VendorGapError
from nwf_lab.features.indicators import indicator_frame, score_series
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok

WARMUP_BARS = 60


@feature("paper-engine", needs=("bars",))
def paper_engine(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    closes = pd.DataFrame({s: b["close"] for s, b in bundle.bars.items() if len(b) > WARMUP_BARS})
    if closes.empty:
        raise VendorGapError("bars", "daily (not enough history)", None)
    scores = pd.DataFrame({s: score_series(indicator_frame(bundle.bars[s], cfg), cfg) for s in closes})
    closes, scores = closes.ffill().iloc[WARMUP_BARS:], scores.reindex(closes.index).iloc[WARMUP_BARS:]

    cash, shares, orders, nav_rows = cfg.paper_start_cash, {s: 0.0 for s in closes}, [], []
    for day, px in closes.iterrows():
        nav = cash + sum(shares[s] * px[s] for s in shares)
        for s in closes:
            sc = scores.at[day, s]
            if shares[s] > 0 and sc < cfg.paper_sell_threshold:
                cash += shares[s] * px[s]
                orders.append({"date": day, "symbol": s, "side": "SELL", "shares": shares[s], "price": px[s]})
                shares[s] = 0.0
            elif shares[s] == 0 and sc >= cfg.paper_buy_threshold:
                budget = min(nav * cfg.paper_max_position_weight, cash - nav * cfg.paper_cash_floor)
                qty = int(budget // px[s]) if budget > 0 else 0
                if qty > 0:
                    cash -= qty * px[s]
                    shares[s] = float(qty)
                    orders.append({"date": day, "symbol": s, "side": "BUY", "shares": qty, "price": px[s]})
        nav_rows.append({"date": day, "nav": cash + sum(shares[s] * px[s] for s in shares), "cash": cash})
    nav = pd.DataFrame(nav_rows).set_index("date")
    peak = nav["nav"].cummax()
    return ok("paper-engine", {
        "start_nav": cfg.paper_start_cash, "end_nav": round(float(nav["nav"].iloc[-1]), 2),
        "total_return": round(float(nav["nav"].iloc[-1] / cfg.paper_start_cash - 1), 4),
        "max_drawdown": round(float((nav["nav"] / peak - 1).min()), 4),
        "orders": len(orders), "open_positions": {s: q for s, q in shares.items() if q > 0},
    }, {"nav": nav, "orders": pd.DataFrame(orders)})
