"""Alpaca daily bars (market data only; paper key; no order endpoints are imported anywhere)."""
from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta

import httpx
import pandas as pd

from nwf_lab.data.providers import BAR_COLUMNS
from nwf_lab.errors import RateBudgetExceeded, VendorGapError
from nwf_lab.symbols import to_alpaca

ALPACA_DATA_URL = "https://data.alpaca.markets"
BATCH_SIZE = 150
MIN_INTERVAL_S = 0.4          # ~150 req/min, under the shared 190/min cap
SIP_DELAY_MINUTES = 16        # SIP bars newer than 15 min are refused on the Basic plan
CALENDAR_DAYS_PER_TRADING_DAY = 1.5


class AlpacaBarsProvider:
    name = "alpaca"

    def __init__(self, key: str, secret: str, feed: str = "sip", client: httpx.Client | None = None):
        self._headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self._feed = feed
        self._client = client or httpx.Client(timeout=30.0)
        self._last_call = 0.0
        self.api_calls = 0

    def _pace(self) -> None:
        wait = MIN_INTERVAL_S - (time.monotonic() - self._last_call)
        if wait > 0:
            time.sleep(wait)
        self._last_call = time.monotonic()

    def daily_bars(self, symbols: list[str], days: int) -> dict[str, pd.DataFrame]:
        end = datetime.now(UTC) - timedelta(minutes=SIP_DELAY_MINUTES)
        start = end - timedelta(days=int(days * CALENDAR_DAYS_PER_TRADING_DAY) + 5)
        wanted = {to_alpaca(s): s for s in symbols}
        rows: dict[str, list[dict]] = {s: [] for s in symbols}
        batches = [list(wanted)[i : i + BATCH_SIZE] for i in range(0, len(wanted), BATCH_SIZE)]
        for batch in batches:
            token: str | None = None
            while True:
                params: dict[str, str | int] = {
                    "symbols": ",".join(batch), "timeframe": "1Day", "adjustment": "split",
                    "feed": self._feed, "limit": 10000,
                    "start": start.isoformat(), "end": end.isoformat(),
                }
                if token:
                    params["page_token"] = token
                self._pace()
                resp = self._client.get(
                    f"{ALPACA_DATA_URL}/v2/stocks/bars", params=params, headers=self._headers
                )
                self.api_calls += 1
                if resp.status_code in (401, 403):
                    raise VendorGapError("alpaca", "v2/stocks/bars", resp.status_code)
                if resp.status_code == 429:
                    raise RateBudgetExceeded("alpaca")
                resp.raise_for_status()
                body = resp.json()
                for sym, bars in (body.get("bars") or {}).items():
                    rows[wanted.get(sym, sym)].extend(bars)
                token = body.get("next_page_token")
                if not token:
                    break
        return {s: _to_frame(r, self._feed) for s, r in rows.items() if r}


def _to_frame(bars: list[dict], feed: str) -> pd.DataFrame:
    df = pd.DataFrame(bars).rename(
        columns={"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "t": "date"}
    )
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df = df.set_index("date")[BAR_COLUMNS].astype(float).sort_index()
    df.attrs.update({"source": "alpaca", "feed": feed})
    return df
