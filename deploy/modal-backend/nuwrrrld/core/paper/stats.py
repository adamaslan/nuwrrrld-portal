"""Reported performance stats per portfolio (Section 11.6). Every view carries PAPER_DISCLAIMER."""
from __future__ import annotations

import math
from decimal import Decimal

TRADING_DAYS = 252


def equity_stats(equities: list[float], benchmark: list[float] | None = None, rf_annual: float = 0.0) -> dict:
    if len(equities) < 2:
        return {"sessions": len(equities)}
    rets = [equities[i] / equities[i - 1] - 1 for i in range(1, len(equities)) if equities[i - 1]]
    n = len(rets)
    total = equities[-1] / equities[0] - 1
    mean = sum(rets) / n
    var = sum((r - mean) ** 2 for r in rets) / (n - 1) if n > 1 else 0.0
    vol = math.sqrt(var) * math.sqrt(TRADING_DAYS)
    ann = (1 + total) ** (TRADING_DAYS / n) - 1 if total > -1 else -1.0
    sharpe = ((mean - rf_annual / TRADING_DAYS) * TRADING_DAYS / vol) if vol else None
    peak, mdd = equities[0], 0.0
    for e in equities:
        peak = max(peak, e)
        mdd = min(mdd, e / peak - 1)
    out = {"sessions": len(equities), "total_return": total, "annualized_return": ann,
           "annualized_vol": vol, "sharpe": sharpe, "max_drawdown": mdd}
    if benchmark and len(benchmark) == len(equities) and benchmark[0]:
        out["benchmark_return"] = benchmark[-1] / benchmark[0] - 1
        out["excess_return"] = total - out["benchmark_return"]
    return out


def trade_stats(fills: list[dict], starting_equity: float) -> dict:
    """Closed-trade stats via average-cost accounting over chronological fills."""
    book: dict[str, list[Decimal]] = {}
    wins: list[float] = []
    losses: list[float] = []
    turnover = Decimal(0)
    for f in fills:
        q, price = Decimal(f["quantity"]), Decimal(f["fill_price"])
        signed = q if f["side"] in ("buy", "buy_to_cover") else -q
        turnover += q * price
        pos, avg = book.get(f["ticker"], [Decimal(0), Decimal(0)])
        if pos != 0 and (pos > 0) != (signed > 0):
            closed = min(abs(signed), abs(pos))
            pnl = float(closed * (price - avg) * (1 if pos > 0 else -1))
            (wins if pnl > 0 else losses).append(pnl)
        new = pos + signed
        if new == 0:
            book.pop(f["ticker"], None)
        elif pos == 0 or (pos > 0) == (signed > 0):
            book[f["ticker"]] = [new, (abs(pos) * avg + abs(signed) * price) / abs(new)]
        elif (new > 0) == (pos > 0):
            book[f["ticker"]] = [new, avg]
        else:
            book[f["ticker"]] = [new, price]
    closed_n = len(wins) + len(losses)
    return {"closed_trades": closed_n, "hit_rate": (len(wins) / closed_n) if closed_n else None,
            "avg_win": (sum(wins) / len(wins)) if wins else None,
            "avg_loss": (sum(losses) / len(losses)) if losses else None,
            "turnover_x_start": float(turnover) / starting_equity if starting_equity else None}
