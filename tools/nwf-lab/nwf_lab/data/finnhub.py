"""Finnhub client: paced (<=1 req/s), cached, token in a header so it never lands in a logged URL."""
from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from nwf_lab.data.cache import ResponseCache
from nwf_lab.errors import RateBudgetExceeded, VendorGapError
from nwf_lab.symbols import canonical

logger = logging.getLogger(__name__)

FINNHUB_BASE_URL = "https://finnhub.io/api/v1"
FINNHUB_MIN_INTERVAL_S = 1.0
DEFAULT_TTL_S = 3600
CACHE_TTL_S = {
    "quote": 60,
    "stock/profile2": 7 * 86400,
    "stock/metric": 86400,
    "stock/recommendation": 86400,
    "company-news": 3600,
    "stock/earnings": 86400,
    "calendar/earnings": 21600,
    "stock/insider-transactions": 86400,
    "stock/peers": 7 * 86400,
}


class FinnhubProvider:
    name = "finnhub"

    def __init__(self, api_key: str, cache: ResponseCache, client: httpx.Client | None = None):
        self._key = api_key
        self._cache = cache
        self._client = client or httpx.Client(timeout=15.0)
        self._last_call = 0.0
        self.api_calls = 0

    def _pace(self) -> None:
        wait = FINNHUB_MIN_INTERVAL_S - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def _get(self, path: str, **params: Any) -> Any:
        cached = self._cache.get(path, params)
        if cached is not None:
            return cached
        self._pace()
        resp = self._client.get(
            f"{FINNHUB_BASE_URL}/{path}", params=params, headers={"X-Finnhub-Token": self._key}
        )
        self.api_calls += 1
        if resp.status_code in (401, 403):
            raise VendorGapError("finnhub", path, resp.status_code)
        if resp.status_code == 429:
            raise RateBudgetExceeded("finnhub")
        resp.raise_for_status()
        data = resp.json()
        self._cache.put(path, params, data, ttl=CACHE_TTL_S.get(path, DEFAULT_TTL_S))
        return data

    # --- QuoteProvider -------------------------------------------------
    def quotes(self, symbols: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for sym in symbols:
            q = self._get("quote", symbol=canonical(sym))
            if not q or not q.get("c"):
                continue
            out[sym] = {
                "price": q["c"], "prev_close": q.get("pc"), "change_pct": q.get("dp"),
                "high": q.get("h"), "low": q.get("l"), "open": q.get("o"),
                "source": "finnhub", "as_of": q.get("t"),
            }
        return out

    # --- BarsProvider (premium endpoint: always a loud gap) ---------------
    def daily_bars(self, symbols: list[str], days: int):  # noqa: ARG002
        raise VendorGapError("finnhub", "stock/candle", 403)

    # --- FundamentalsProvider ----------------------------------------------
    def profile(self, symbol: str) -> dict:
        return self._get("stock/profile2", symbol=canonical(symbol)) or {}

    def metrics(self, symbol: str) -> dict:
        return (self._get("stock/metric", symbol=canonical(symbol), metric="all") or {}).get(
            "metric", {}
        )

    def recommendations(self, symbol: str) -> list[dict]:
        return self._get("stock/recommendation", symbol=canonical(symbol)) or []

    def earnings(self, symbol: str) -> list[dict]:
        return self._get("stock/earnings", symbol=canonical(symbol)) or []

    def earnings_calendar(self, start: str, end: str) -> list[dict]:
        return (self._get("calendar/earnings", **{"from": start, "to": end}) or {}).get(
            "earningsCalendar", []
        )

    def insider_transactions(self, symbol: str) -> list[dict]:
        return (self._get("stock/insider-transactions", symbol=canonical(symbol)) or {}).get(
            "data", []
        )

    def peers(self, symbol: str) -> list[str]:
        return self._get("stock/peers", symbol=canonical(symbol)) or []

    def company_news(self, symbol: str, start: str, end: str) -> list[dict]:
        return self._get("company-news", symbol=canonical(symbol), **{"from": start, "to": end}) or []
