"""yfinance fallback. Laptop only: Yahoo blocks cloud IPs. Every use is logged at WARNING."""
from __future__ import annotations

import logging

import pandas as pd

from nwf_lab.data.providers import BAR_COLUMNS
from nwf_lab.symbols import to_yahoo

logger = logging.getLogger(__name__)


class YFinanceLocalProvider:
    name = "yfinance"

    def daily_bars(self, symbols: list[str], days: int) -> dict[str, pd.DataFrame]:
        import yfinance as yf

        logger.warning("fallback: using yfinance for %d symbols (laptop only)", len(symbols))
        out: dict[str, pd.DataFrame] = {}
        for sym in symbols:
            df = yf.Ticker(to_yahoo(sym)).history(period=f"{max(days, 30)}d", auto_adjust=False)
            if df is None or df.empty:
                continue
            df = df.rename(columns=str.lower)[BAR_COLUMNS]
            df.index = pd.to_datetime(df.index).tz_localize(None).normalize()
            df.index.name = "date"
            df.attrs.update({"source": "yfinance", "feed": "yahoo"})
            out[sym] = df
        return out
