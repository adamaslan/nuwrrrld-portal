"""Provider interfaces. Every vendor sits behind one of these."""
from __future__ import annotations

from typing import Protocol

import pandas as pd


class BarsProvider(Protocol):
    name: str

    def daily_bars(self, symbols: list[str], days: int) -> dict[str, pd.DataFrame]:
        """Return {symbol: DataFrame[open, high, low, close, volume]} indexed by date."""
        ...


class QuoteProvider(Protocol):
    name: str

    def quotes(self, symbols: list[str]) -> dict[str, dict]:
        """Return {symbol: {price, prev_close, change_pct, source, ...}}."""
        ...


class FundamentalsProvider(Protocol):
    name: str

    def profile(self, symbol: str) -> dict: ...
    def metrics(self, symbol: str) -> dict: ...
    def recommendations(self, symbol: str) -> list[dict]: ...
    def earnings(self, symbol: str) -> list[dict]: ...
    def earnings_calendar(self, start: str, end: str) -> list[dict]: ...
    def insider_transactions(self, symbol: str) -> list[dict]: ...
    def peers(self, symbol: str) -> list[str]: ...
    def company_news(self, symbol: str, start: str, end: str) -> list[dict]: ...


BAR_COLUMNS = ["open", "high", "low", "close", "volume"]
