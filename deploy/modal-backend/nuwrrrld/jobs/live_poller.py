"""AWS-Modal live-price poller: Alpaca snapshots every minute 09:30-16:00 ET -> DynamoDB -> portal live_prices."""
from __future__ import annotations

import datetime as dt
import logging
import os

import httpx

from nuwrrrld import dynamo
from nuwrrrld.calendar import ET, TradingCalendar
from nuwrrrld.providers.alpaca import latest_prices

log = logging.getLogger(__name__)
MARKET_OPEN, MARKET_CLOSE = dt.time(9, 30), dt.time(16, 0)
PUSH_TIMEOUT_SECONDS = 15.0


def in_market_hours(now: dt.datetime, cal: TradingCalendar) -> bool:
    et = now.astimezone(ET)
    return cal.is_session(et.date()) and MARKET_OPEN <= et.time() <= MARKET_CLOSE


def poll_once(provider, tickers: list[str], ddb: dynamo.Dynamo | None = None, last: dict | None = None,
              now: dt.datetime | None = None, cal: TradingCalendar | None = None) -> dict:
    """Write only CHANGED tickers. `last` is the previous poll's {ticker: price} (modal.Dict-backed)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    if not in_market_hours(now, cal or TradingCalendar()):
        return {"status": "closed"}
    ddb = ddb or dynamo.default()
    prices = latest_prices(provider, tickers)
    previous = last if last is not None else {}
    changed = {t: p for t, p in prices.items() if previous.get(t) != str(p["price"])}
    written = ddb.put_live_prices({t: {**p, "polled_at": now.isoformat()} for t, p in changed.items()})
    for t, p in prices.items():
        previous[t] = str(p["price"])
    pushed = push_to_portal(changed)
    return {"status": "polled", "seen": len(prices), "changed": len(changed), "dynamo_written": written, "pushed": pushed}


def push_to_portal(changed: dict[str, dict]) -> int:
    """Bearer push to the portal's live_prices feed. Skipped (not an error) when unconfigured."""
    url, secret = os.environ.get("PORTAL_PUSH_URL"), os.environ.get("PORTAL_PUSH_SECRET")
    if not url or not secret or not changed:
        return 0
    body = [{"ticker": t, "price": str(p["price"]), "source": "alpaca", "feed": p["feed"], "ts": p.get("ts")}
            for t, p in changed.items()]
    try:
        r = httpx.post(url, json={"prices": body}, headers={"Authorization": f"Bearer {secret}"}, timeout=PUSH_TIMEOUT_SECONDS)
        r.raise_for_status()
        return len(body)
    except httpx.HTTPError as exc:
        log.warning("portal live_prices push failed: %s", exc)
        return 0
