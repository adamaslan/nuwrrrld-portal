"""insider-flow: net open-market buying (P) vs selling (S) inside the lookback window."""
from __future__ import annotations

from datetime import date, timedelta

from nwf_lab.config import LabConfig
from nwf_lab.data.bundle import DataBundle
from nwf_lab.errors import MissingInputError
from nwf_lab.features.registry import FeatureResult, RunContext, feature, ok


@feature("insider-flow", needs=("insiders",))
def insider_flow(bundle: DataBundle, cfg: LabConfig, ctx: RunContext) -> FeatureResult:
    if not bundle.insiders:
        raise MissingInputError("no insider data in bundle")
    ref = max((b.index[-1].date() for b in bundle.bars.values()), default=date.today())
    cutoff = (ref - timedelta(days=cfg.insider_lookback_days)).isoformat()
    data = {}
    for t in bundle.tickers:
        buys = sells = 0.0
        for tx in bundle.insiders.get(t, []):
            if (tx.get("transactionDate") or "") < cutoff:
                continue
            shares = abs(tx.get("change") or 0)
            price = tx.get("transactionPrice") or 0
            if tx.get("transactionCode") == "P":
                buys += shares * price
            elif tx.get("transactionCode") == "S":
                sells += shares * price
        net = buys - sells
        data[t] = {"buy_value": round(buys, 2), "sell_value": round(sells, 2), "net": round(net, 2),
                   "lean": "buying" if net > 0 else "selling" if net < 0 else "flat"}
    return ok("insider-flow", data, sources=["finnhub"])
