"""Alpaca-first market data (daily bars, snapshots) with local request pacing.

Canonical copy of the NuWrrrld market-data client. Each repo vendors this file
unchanged; edit it in one place and re-copy. Policy: ~/.claude/rules/market-data-fallback.md.

* Paper key pair only. Never points at the live trading host.
* ``daily_bars`` returns yfinance-shaped DataFrames (Open/High/Low/Close/Volume,
  tz-naive DatetimeIndex) so existing indicator code needs no changes.
* Requests are paced locally (one per ``LOCAL_MIN_INTERVAL_SECONDS``). There is
  no shared AWS-backed rate budget; see docs/alpaca-budget-removed-2026-10-20.md
  for how to restore it.
* Missing tickers are returned as absent keys (fail closed). Callers decide
  whether a fallback vendor is allowed on their host.
"""
from __future__ import annotations

import datetime as dt
import logging
import os
import time
from typing import Iterable, Sequence

import requests

log = logging.getLogger(__name__)

DATA_URL = "https://data.alpaca.markets"
SYMBOLS_PER_REQUEST = 150
HTTP_TIMEOUT_SECONDS = 30
MAX_RETRIES = 4
RATE_LIMIT_STATUS_CODE = 429
LOCAL_MIN_INTERVAL_SECONDS = 0.35
SIP_DELAY_MINUTES = 20  # SIP is only served for bars older than ~15 min on the Basic plan

_last_request_at = 0.0


class AlpacaError(RuntimeError):
    """Alpaca request failed after retries (callers may fall back, and must log it)."""


def to_alpaca_symbol(ticker: str) -> str:
    """Yahoo BRK-B -> Alpaca BRK.B."""
    return ticker.strip().upper().replace("-", ".")


def from_alpaca_symbol(symbol: str) -> str:
    return symbol.strip().upper().replace(".", "-")


def _credentials() -> dict[str, str]:
    key, secret = os.environ.get("ALPACA_API_KEY"), os.environ.get("ALPACA_API_SECRET")
    if not key or not secret:
        raise AlpacaError("ALPACA_API_KEY / ALPACA_API_SECRET not set")
    if "//api.alpaca.markets" in os.environ.get("ALPACA_BASE_URL", ""):
        raise AlpacaError("refusing live Alpaca trading host; paper key pair only")
    return {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}


def is_configured() -> bool:
    return bool(os.environ.get("ALPACA_API_KEY") and os.environ.get("ALPACA_API_SECRET"))


# -- local pacing -------------------------------------------------------------------
def _pace() -> None:
    global _last_request_at
    wait = LOCAL_MIN_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


# -- http ----------------------------------------------------------------------------
def _get(path: str, params: dict) -> dict:
    headers = _credentials()
    last: Exception | None = None
    for attempt in range(MAX_RETRIES):
        _pace()
        try:
            resp = requests.get(DATA_URL + path, params=params, headers=headers,
                                timeout=HTTP_TIMEOUT_SECONDS)
        except requests.RequestException as exc:
            last = exc
        else:
            if resp.status_code == RATE_LIMIT_STATUS_CODE or resp.status_code >= 500:
                last = AlpacaError(f"alpaca {resp.status_code}")
                retry_after = float(resp.headers.get("Retry-After", 0) or 0)
                if retry_after:
                    time.sleep(min(retry_after, 60))
            elif resp.status_code >= 400:
                raise AlpacaError(f"alpaca {resp.status_code}: {resp.text[:200]}")
            else:
                try:
                    return resp.json()
                except ValueError as exc:  # 200 with a non-JSON body, e.g. a proxy or captive portal
                    raise AlpacaError(f"alpaca non-JSON response: {exc}") from exc
        time.sleep(min(2 ** attempt, 20))
    raise AlpacaError(f"alpaca request failed after {MAX_RETRIES} attempts: {last}")


def _chunks(items: Sequence[str], size: int) -> Iterable[list[str]]:
    for i in range(0, len(items), size):
        yield list(items[i:i + size])


# -- public API ----------------------------------------------------------------------
def daily_bars(symbols: Sequence[str], start: dt.date, end: dt.date | None = None, *,
               feed: str = "sip") -> dict[str, list[dict]]:
    """Raw split-adjusted daily bars keyed by the caller's (Yahoo-style) ticker."""
    wanted = {to_alpaca_symbol(s): s for s in dict.fromkeys(symbols)}
    end_ts = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=SIP_DELAY_MINUTES)
              if end is None else dt.datetime.combine(end + dt.timedelta(days=1), dt.time(),
                                                      dt.timezone.utc))
    out: dict[str, list[dict]] = {}
    for chunk in _chunks(list(wanted), SYMBOLS_PER_REQUEST):
        token: str | None = None
        while True:
            params = {"symbols": ",".join(chunk), "timeframe": "1Day", "start": start.isoformat(),
                      "end": end_ts.strftime("%Y-%m-%dT%H:%M:%SZ"), "adjustment": "split",
                      "feed": feed, "limit": 10000}
            if token:
                params["page_token"] = token
            data = _get("/v2/stocks/bars", params)
            for sym, rows in (data.get("bars") or {}).items():
                out.setdefault(wanted.get(sym, from_alpaca_symbol(sym)), []).extend(rows)
            token = data.get("next_page_token")
            if not token:
                break
    return out


def daily_bars_frames(symbols: Sequence[str], days: int = 120, *, feed: str = "sip") -> dict:
    """yfinance-shaped DataFrames per ticker; tickers Alpaca could not serve are absent."""
    import pandas as pd

    start = dt.datetime.now(dt.timezone.utc).date() - dt.timedelta(days=days)
    frames = {}
    for sym, rows in daily_bars(symbols, start, feed=feed).items():
        df = pd.DataFrame(rows)
        if df.empty:
            continue
        df.index = pd.to_datetime(df["t"]).dt.tz_localize(None).dt.normalize()
        frames[sym] = df.rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close",
                                         "v": "Volume"})[["Open", "High", "Low", "Close", "Volume"]]
    return frames


def latest_prices(symbols: Sequence[str], *, feed: str = "iex") -> dict[str, dict]:
    """Latest trade per ticker from snapshots (IEX). Absent keys = no price."""
    wanted = {to_alpaca_symbol(s): s for s in dict.fromkeys(symbols)}
    out: dict[str, dict] = {}
    for chunk in _chunks(list(wanted), SYMBOLS_PER_REQUEST):
        data = _get("/v2/stocks/snapshots", {"symbols": ",".join(chunk), "feed": feed})
        for sym, snap in data.items():
            trade = (snap or {}).get("latestTrade") or {}
            daily = (snap or {}).get("dailyBar") or {}
            prev = (snap or {}).get("prevDailyBar") or {}
            if trade.get("p"):
                price, prev_close = float(trade["p"]), prev.get("c")
                out[wanted.get(sym, from_alpaca_symbol(sym))] = {
                    "price": price, "prev_close": prev_close, "day_open": daily.get("o"),
                    "change_pct": ((price - prev_close) / prev_close * 100) if prev_close else None,
                    "ts": trade.get("t"), "source": "alpaca", "feed": feed}
    return out


def warn_fallback(what: str, symbols: Iterable[str], reason: object) -> None:
    """Log an Alpaca -> other-vendor fall-through at WARNING, per the policy."""
    missing = sorted(symbols)
    log.warning("market-data fallback: %s for %d symbols left Alpaca (%s): %s",
                what, len(missing), reason, ",".join(missing[:12]))
