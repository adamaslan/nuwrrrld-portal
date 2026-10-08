"""What-if transforms: pure DataBundle -> DataBundle. The input bundle is never mutated."""
from __future__ import annotations

from collections.abc import Callable

from nwf_lab.data.bundle import DataBundle


def price_shock(bundle: DataBundle, pct: float = -0.10) -> DataBundle:
    """Scale the final bar's OHLC (and the quote) by (1 + pct)."""
    out = bundle.copy()
    for sym, df in out.bars.items():
        df = df.copy()
        cols = ["open", "high", "low", "close"]
        df.iloc[-1, [df.columns.get_loc(c) for c in cols]] *= 1 + pct
        df.attrs.update(bundle.bars[sym].attrs)
        out.bars[sym] = df
    for q in out.quotes.values():
        q["price"] = q["price"] * (1 + pct)
    out.manual_edits.append(f"scenario:price_shock({pct:+.0%})")
    return out


def volume_multiple(bundle: DataBundle, factor: float = 2.0) -> DataBundle:
    out = bundle.copy()
    for sym, df in out.bars.items():
        df = df.copy()
        df.iloc[-1, df.columns.get_loc("volume")] *= factor
        df.attrs.update(bundle.bars[sym].attrs)
        out.bars[sym] = df
    out.manual_edits.append(f"scenario:volume_x{factor:g}")
    return out


def drop_last_days(bundle: DataBundle, n: int = 5) -> DataBundle:
    out = bundle.copy()
    for sym, df in out.bars.items():
        trimmed = df.iloc[:-n].copy() if n > 0 else df.copy()
        trimmed.attrs.update(bundle.bars[sym].attrs)
        out.bars[sym] = trimmed
    out.quotes = {}  # a live quote no longer matches the trimmed history; analyze falls back to last close
    out.manual_edits.append(f"scenario:drop_last_{n}d")
    return out


def earnings_miss(bundle: DataBundle, pct: float = -15.0) -> DataBundle:
    out = bundle.copy()
    for rows in out.earnings.values():
        if rows:
            rows[0]["surprisePercent"] = pct
    out.manual_edits.append(f"scenario:earnings_miss({pct:g}%)")
    return out


SCENARIOS: dict[str, Callable[[DataBundle], DataBundle]] = {
    "price shock -10%": lambda b: price_shock(b, -0.10),
    "price shock +10%": lambda b: price_shock(b, 0.10),
    "volume x2": lambda b: volume_multiple(b, 2.0),
    "drop last 5 days": lambda b: drop_last_days(b, 5),
    "earnings miss": earnings_miss,
}
