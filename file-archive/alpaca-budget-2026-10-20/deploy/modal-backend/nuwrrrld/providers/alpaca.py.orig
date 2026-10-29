"""Alpaca market-data adapter - the PRIMARY provider on every pipeline.

Paper key pair only (never live endpoints). EOD history prefers feed=sip, quotes feed=iex.
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import logging
import os
from decimal import Decimal
from pathlib import Path
from typing import Callable, Sequence

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from nuwrrrld.calendar import ET
from nuwrrrld.providers.base import (Bar, CorporateAction, DataNotReady, OpenPrint, ProviderError,
                                     RateLimited, from_alpaca_symbol, to_alpaca_symbol)

log = logging.getLogger(__name__)

DATA_URL = "https://data.alpaca.markets"
SYMBOLS_PER_REQUEST = 150
HTTP_TIMEOUT_SECONDS = 30.0
BPS = Decimal(10_000)
SIX_PLACES = Decimal("0.000001")


def _d(value) -> Decimal:
    return Decimal(str(value)).quantize(SIX_PLACES)


class _Retryable(ProviderError):
    pass


class AlpacaProvider:
    name = "alpaca"

    def __init__(self, key_id: str, secret: str, *, feed_eod: str = "sip", feed_live: str = "iex",
                 client: httpx.Client | None = None, take_tokens: Callable[[int], None] | None = None,
                 raw_dir: str | None = None):
        if "//api.alpaca.markets" in os.environ.get("ALPACA_BASE_URL", ""):
            raise ProviderError("refusing live Alpaca trading host; paper key pair only")
        self._headers = {"APCA-API-KEY-ID": key_id, "APCA-API-SECRET-KEY": secret}
        self._feed_eod, self._feed_live = feed_eod, feed_live
        self._client = client or httpx.Client(base_url=DATA_URL, timeout=HTTP_TIMEOUT_SECONDS)
        self._take_tokens = take_tokens or (lambda n: None)  # DynamoDB shared budget hook
        self._raw_dir = raw_dir

    @classmethod
    def from_env(cls, **kw) -> "AlpacaProvider":
        from nuwrrrld import dynamo
        return cls(os.environ["ALPACA_API_KEY"], os.environ["ALPACA_API_SECRET"],
                   feed_eod=os.environ.get("ALPACA_DATA_FEED_EOD", "sip"),
                   feed_live=os.environ.get("ALPACA_DATA_FEED_LIVE", "iex"),
                   take_tokens=kw.pop("take_tokens", dynamo.default().wait_for_alpaca_tokens), **kw)

    # -- http ----------------------------------------------------------------------
    @retry(retry=retry_if_exception_type((_Retryable, RateLimited, httpx.TransportError)),
           stop=stop_after_attempt(4), wait=wait_exponential_jitter(initial=1, max=20), reraise=True)
    def _get(self, path: str, params: dict) -> dict:
        self._take_tokens(1)
        resp = self._client.get(path, params=params, headers=self._headers)
        if resp.status_code == 429:
            raise RateLimited(float(resp.headers.get("Retry-After", 0)) or None)
        if resp.status_code >= 500:
            raise _Retryable(f"alpaca {resp.status_code}")
        if resp.status_code >= 400:
            raise ProviderError(f"alpaca {resp.status_code}: {resp.text[:200]}")
        data = resp.json()
        self._dump_raw(path, params, data)
        return data

    def _dump_raw(self, path: str, params: dict, data: dict) -> None:
        if not self._raw_dir:
            return
        try:
            day = dt.datetime.now(ET).date().isoformat()
            out = Path(self._raw_dir) / "alpaca" / day
            out.mkdir(parents=True, exist_ok=True)
            name = path.strip("/").replace("/", "_") + f"_{abs(hash(json.dumps(params, sort_keys=True)))}.json.gz"
            with gzip.open(out / name, "wt") as fh:
                json.dump(data, fh)
        except OSError as exc:
            log.warning("raw dump failed: %s", exc)

    # -- protocol ---------------------------------------------------------------------
    def daily_bars(self, tickers: Sequence[str], start: dt.date, end: dt.date) -> list[Bar]:
        out: list[Bar] = []
        for i in range(0, len(tickers), SYMBOLS_PER_REQUEST):
            chunk = [to_alpaca_symbol(t) for t in tickers[i:i + SYMBOLS_PER_REQUEST]]
            token: str | None = None
            while True:
                params = {"symbols": ",".join(chunk), "timeframe": "1Day", "start": start.isoformat(),
                          "end": (end + dt.timedelta(days=1)).isoformat(), "adjustment": "split",
                          "feed": self._feed_eod, "limit": 10000}
                if token:
                    params["page_token"] = token
                data = self._get("/v2/stocks/bars", params)
                for sym, bars in (data.get("bars") or {}).items():
                    out.extend(self._bar(from_alpaca_symbol(sym), b) for b in bars)
                token = data.get("next_page_token")
                if not token:
                    break
        return out

    def _bar(self, ticker: str, b: dict) -> Bar:
        day = dt.datetime.fromisoformat(b["t"].replace("Z", "+00:00")).astimezone(ET).date()
        close = _d(b["c"])
        # adjustment=split already folds splits into OHLC; dividends are not folded, so adj_close
        # equals close and adj_factor is 1 (documented limitation, same vendor throughout).
        return Bar(ticker, day, _d(b["o"]), _d(b["h"]), _d(b["l"]), close, int(b["v"]),
                   _d(b["vw"]) if b.get("vw") else None, close, Decimal(1), True, self.name, self._feed_eod)

    def session_open(self, tickers: Sequence[str], session_date: dt.date) -> list[OpenPrint]:
        bars = [b for b in self.daily_bars(list(tickers), session_date, session_date) if b.bar_date == session_date]
        if not bars:
            raise DataNotReady(f"no alpaca bars for {session_date}")
        return [OpenPrint(b.ticker, session_date, b.open, "daily_bar.open") for b in bars]

    def session_close(self, tickers: Sequence[str], session_date: dt.date) -> dict[str, Decimal]:
        bars = [b for b in self.daily_bars(list(tickers), session_date, session_date) if b.bar_date == session_date]
        if not bars:
            raise DataNotReady(f"no alpaca bars for {session_date}")
        return {b.ticker: b.close for b in bars}

    def spread_bps(self, ticker: str) -> Decimal | None:
        sym = to_alpaca_symbol(ticker)
        data = self._get("/v2/stocks/snapshots", {"symbols": sym, "feed": self._feed_live})
        quote = (data.get(sym) or {}).get("latestQuote") or {}
        ask, bid = quote.get("ap"), quote.get("bp")
        if not ask or not bid or ask <= 0 or bid <= 0 or ask < bid:
            return None
        mid = (Decimal(str(ask)) + Decimal(str(bid))) / 2
        return ((Decimal(str(ask)) - Decimal(str(bid))) / mid * BPS).quantize(Decimal("0.001"))

    def corporate_actions(self, tickers: Sequence[str], start: dt.date, end: dt.date) -> list[CorporateAction]:
        out: list[CorporateAction] = []
        for i in range(0, len(tickers), SYMBOLS_PER_REQUEST):
            syms = ",".join(to_alpaca_symbol(t) for t in tickers[i:i + SYMBOLS_PER_REQUEST])
            data = self._get("/v1/corporate-actions", {
                "symbols": syms, "types": "forward_split,reverse_split,cash_dividend",
                "start": start.isoformat(), "end": end.isoformat(), "limit": 1000})
            actions = data.get("corporate_actions") or {}
            for key in ("forward_splits", "reverse_splits"):
                for a in actions.get(key, []):
                    ratio = Decimal(str(a["new_rate"])) / Decimal(str(a["old_rate"]))
                    out.append(CorporateAction(from_alpaca_symbol(a["symbol"]),
                                               dt.date.fromisoformat(a["ex_date"]), "split", ratio, None))
            for a in actions.get("cash_dividends", []):
                out.append(CorporateAction(from_alpaca_symbol(a["symbol"]),
                                           dt.date.fromisoformat(a["ex_date"]), "dividend", None,
                                           Decimal(str(a["rate"]))))
        return out

    def healthcheck(self) -> bool:
        try:
            end = dt.datetime.now(ET).date()
            return bool(self.daily_bars(["SPY"], end - dt.timedelta(days=7), end))
        except ProviderError:
            return False


def _snapshot_price(snap: dict) -> tuple[Decimal | None, dict]:
    trade = snap.get("latestTrade") or {}
    quote = snap.get("latestQuote") or {}
    price = trade.get("p")
    return (_d(price) if price else None), {"bid": quote.get("bp"), "ask": quote.get("ap"), "ts": trade.get("t")}


def latest_prices(provider: "AlpacaProvider", tickers: Sequence[str]) -> dict[str, dict]:
    """Latest trade per ticker (IEX feed) for the live poller; one request per <=150 symbols."""
    out: dict[str, dict] = {}
    for i in range(0, len(tickers), SYMBOLS_PER_REQUEST):
        chunk = [to_alpaca_symbol(t) for t in tickers[i:i + SYMBOLS_PER_REQUEST]]
        data = provider._get("/v2/stocks/snapshots", {"symbols": ",".join(chunk), "feed": provider._feed_live})
        for sym, snap in data.items():
            price, extra = _snapshot_price(snap)
            if price is not None:
                out[from_alpaca_symbol(sym)] = {"ticker": from_alpaca_symbol(sym), "price": price,
                                                "feed": provider._feed_live, "source": "alpaca", **extra}
    return out
