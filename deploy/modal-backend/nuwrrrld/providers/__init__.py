"""Provider registry and the Alpaca-first fallback chain."""
from __future__ import annotations

import datetime as dt
import logging
import os
from typing import Sequence

from nuwrrrld.providers.alpaca import AlpacaProvider
from nuwrrrld.providers.base import Bar, MarketDataProvider, ProviderError
from nuwrrrld.providers.yfinance_fallback import YFinanceProvider, host_allows_yfinance

log = logging.getLogger(__name__)

_IMPLS: dict[str, type] = {"alpaca": AlpacaProvider, "yfinance": YFinanceProvider}


def get_provider(name: str | None = None, **kw) -> MarketDataProvider:
    return _IMPLS[name or os.environ.get("MARKET_DATA_PROVIDER", "alpaca")].from_env(**kw)


def get_fallback() -> MarketDataProvider | None:
    fb = os.environ.get("MARKET_DATA_FALLBACK")
    if not fb or fb not in _IMPLS:
        return None
    try:
        return _IMPLS[fb].from_env()
    except ProviderError as exc:
        log.info("fallback %s unavailable on this host: %s", fb, exc)
        return None


def daily_bars_with_fallback(primary: MarketDataProvider, tickers: Sequence[str], start: dt.date,
                             end: dt.date, fallback: MarketDataProvider | None = None
                             ) -> tuple[list[Bar], list[str]]:
    """Fetch from the primary; fetch ONLY missing tickers from the fallback; return (bars, missing).

    Never splices two vendors inside one ticker's window; a ticker comes wholly from one vendor.
    Host-aware: yfinance is skipped on datacenter hosts, so those tickers stay missing (fail closed).
    """
    bars = list(primary.daily_bars(tickers, start, end))
    have = {b.ticker for b in bars}
    missing = [t for t in tickers if t not in have]
    if missing and fallback is not None:
        if fallback.name == "yfinance" and not host_allows_yfinance():
            log.warning("fallback skipped: yfinance blocked on this host; missing=%s", missing)
        else:
            log.warning("primary %s missing %d tickers; falling back to %s: %s",
                        primary.name, len(missing), fallback.name, missing)
            extra = fallback.daily_bars(missing, start, end)
            bars.extend(extra)
            missing = [t for t in missing if t not in {b.ticker for b in extra}]
    return bars, missing
