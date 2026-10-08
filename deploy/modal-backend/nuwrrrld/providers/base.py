"""Vendor-neutral market-data protocol (Section 12)."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol, Sequence


@dataclass(frozen=True)
class Bar:
    ticker: str
    bar_date: date                     # ET session date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    vwap: Decimal | None
    adj_close: Decimal | None
    adj_factor: Decimal
    is_final: bool = True
    provider: str = ""
    feed: str = ""


@dataclass(frozen=True)
class OpenPrint:
    ticker: str
    session_date: date
    open: Decimal
    source_field: str                  # e.g. "daily_bar.open"


@dataclass(frozen=True)
class CorporateAction:
    ticker: str
    ex_date: date
    kind: str                          # 'split' | 'dividend'
    ratio: Decimal | None
    amount: Decimal | None


class ProviderError(Exception): ...
class DataNotReady(ProviderError): ...        # latest session missing/provisional -> poll later
class RateLimited(ProviderError):
    def __init__(self, retry_after: float | None = None):
        super().__init__("rate limited")
        self.retry_after = retry_after


class MarketDataProvider(Protocol):
    name: str

    @classmethod
    def from_env(cls) -> "MarketDataProvider": ...
    def daily_bars(self, tickers: Sequence[str], start: date, end: date) -> list[Bar]: ...
    def session_open(self, tickers: Sequence[str], session_date: date) -> list[OpenPrint]: ...
    def session_close(self, tickers: Sequence[str], session_date: date) -> dict[str, Decimal]: ...
    def spread_bps(self, ticker: str) -> Decimal | None: ...
    def corporate_actions(self, tickers: Sequence[str], start: date, end: date) -> list[CorporateAction]: ...
    def healthcheck(self) -> bool: ...


def to_alpaca_symbol(ticker: str) -> str:
    """Internal/Yahoo form BRK-B -> Alpaca BRK.B (matches the portal's normalizeToAlpaca)."""
    return ticker.upper().replace("-", ".")


def from_alpaca_symbol(symbol: str) -> str:
    return symbol.upper().replace(".", "-")
