"""I/O for the 4th pipeline (nwf4): Alpaca, Finnhub, DynamoDB, Neon.

Every function that talks to a vendor or a store lives here so news_core.py
stays pure. Nothing in this module prints or returns a secret value.

Vendor policy (~/.claude/rules/market-data-fallback.md): Alpaca is the primary
source and shares one rate budget across all pipelines. When the budget is
spent the caller waits for the next minute; it never falls through to another
vendor. Finnhub is corroboration only, paced at 1 request a second or less.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional, Sequence

import httpx

logger = logging.getLogger("nwf4")

ALPACA_DATA_URL = "https://data.alpaca.markets"
FINNHUB_URL = "https://finnhub.io/api/v1"

ALPACA_CALLS_PER_MINUTE = 190  # ~200 published; 10 kept as headroom
BUDGET_TABLE = "nwf_rate_budget"
BUDGET_TTL_SECONDS = 120
SEEN_TTL_SECONDS = 14 * 86400
LOCK_TABLE = "nwf_job_locks"
SEEN_TABLE = "nwf_seen"
CURSOR_TABLE = "nwf_news_cursor"
LIVE_TABLE = "nwf_live_prices"

HTTP_TIMEOUT_SECONDS = 15.0
NEWS_PAGE_LIMIT = 50
SNAPSHOT_BATCH = 150
DYNAMO_WRITES_PER_SECOND = 4  # table is provisioned at 5 WCU
FINNHUB_MIN_INTERVAL_SECONDS = 1.1


class AlpacaBudgetExhausted(Exception):
    """This minute's shared Alpaca budget is spent; wait for the next minute."""


class VendorUnavailable(Exception):
    """A vendor answered with an auth/limit error. Reported loudly; never papered over."""


def alpaca_headers() -> dict[str, str]:
    return {
        "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY"],
        "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET"],
    }


def normalize_to_alpaca(ticker: str) -> str:
    """Yahoo-style hyphen (BRK-B) to Alpaca's dot (BRK.B)."""
    return ticker.replace("-", ".")


def normalize_from_alpaca(symbol: str) -> str:
    return symbol.replace(".", "-")


def iso_utc(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


# ── DynamoDB ─────────────────────────────────────────────────────────────────


class DynamoStore:
    """The six nwf_* tables. Credentials are the purpose-scoped nuwrrrld-aws secret."""

    def __init__(self, client: Any = None):
        if client is None:
            import boto3

            client = boto3.client("dynamodb", region_name=os.environ["AWS_REGION"])
        self._client = client

    def take_alpaca_tokens(self, n: int = 1) -> None:
        """Atomically reserve n Alpaca calls in the current UTC minute, or raise."""
        from botocore.exceptions import ClientError

        minute = time.strftime("%Y-%m-%dT%H:%M", time.gmtime())
        try:
            self._client.update_item(
                TableName=BUDGET_TABLE,
                Key={"bucket": {"S": f"alpaca#{minute}"}},
                UpdateExpression="ADD calls :n SET expires_at = if_not_exists(expires_at, :ttl)",
                ConditionExpression="attribute_not_exists(calls) OR calls <= :cap",
                ExpressionAttributeValues={
                    ":n": {"N": str(n)},
                    ":cap": {"N": str(ALPACA_CALLS_PER_MINUTE - n)},
                    ":ttl": {"N": str(int(time.time()) + BUDGET_TTL_SECONDS)},
                },
            )
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise AlpacaBudgetExhausted(minute) from error
            raise

    def get_cursor(self, stream: str) -> Optional[datetime]:
        item = self._client.get_item(TableName=CURSOR_TABLE, Key={"stream": {"S": stream}}).get("Item")
        return parse_iso(item["created_at"]["S"]) if item else None

    def set_cursor(self, stream: str, created_at: datetime) -> None:
        self._client.put_item(
            TableName=CURSOR_TABLE,
            Item={"stream": {"S": stream}, "created_at": {"S": iso_utc(created_at)}},
        )

    def seen_many(self, keys: Sequence[str]) -> set[str]:
        """Which of `keys` are already recorded. BatchGetItem takes at most 100 keys."""
        found: set[str] = set()
        for start in range(0, len(keys), 100):
            chunk = list(dict.fromkeys(keys[start : start + 100]))
            if not chunk:
                continue
            request = {SEEN_TABLE: {"Keys": [{"key": {"S": k}} for k in chunk], "ProjectionExpression": "#k",
                                    "ExpressionAttributeNames": {"#k": "key"}}}
            for _ in range(5):
                response = self._client.batch_get_item(RequestItems=request)
                found.update(item["key"]["S"] for item in response["Responses"].get(SEEN_TABLE, []))
                request = response.get("UnprocessedKeys") or {}
                if not request:
                    break
                time.sleep(0.5)
        return found

    def mark_seen(self, keys: Iterable[str]) -> None:
        expires = str(int(time.time()) + SEEN_TTL_SECONDS)
        for key in keys:
            self._client.put_item(
                TableName=SEEN_TABLE, Item={"key": {"S": key}, "expires_at": {"N": expires}}
            )

    def acquire_lock(self, name: str, ttl_seconds: int) -> Optional[str]:
        """Single-run lock. Returns an owner token, or None if another run holds it.

        DynamoDB TTL deletion lags by up to two days, so expiry is also checked here.
        """
        from botocore.exceptions import ClientError

        now = int(time.time())
        owner = uuid.uuid4().hex
        try:
            self._client.put_item(
                TableName=LOCK_TABLE,
                Item={"lock_key": {"S": name}, "owner": {"S": owner}, "expires_at": {"N": str(now + ttl_seconds)}},
                ConditionExpression="attribute_not_exists(lock_key) OR expires_at < :now",
                ExpressionAttributeValues={":now": {"N": str(now)}},
            )
        except ClientError as error:
            if error.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return None
            raise
        return owner

    def release_lock(self, name: str, owner: str) -> None:
        """Expire our lock. The scoped IAM user has no DeleteItem (design §5.5), so mark it expired instead."""
        from botocore.exceptions import ClientError

        try:
            self._client.update_item(
                TableName=LOCK_TABLE,
                Key={"lock_key": {"S": name}},
                UpdateExpression="SET expires_at = :zero",
                ConditionExpression="#o = :o",
                ExpressionAttributeNames={"#o": "owner"},
                ExpressionAttributeValues={":o": {"S": owner}, ":zero": {"N": "0"}},
            )
        except ClientError as error:
            if error.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise  # someone else holds it now; nothing of ours to release

    def put_live_prices(self, rows: Mapping[str, tuple[float, str]], deadline_seconds: float) -> tuple[int, int]:
        """Write changed prices, paced under the table's 5 WCU. Returns (written, deferred)."""
        started = time.monotonic()
        written = 0
        items = list(rows.items())
        for ticker, (price, traded_at) in items:
            if time.monotonic() - started > deadline_seconds:
                break
            self._client.put_item(
                TableName=LIVE_TABLE,
                Item={"ticker": {"S": ticker}, "price": {"N": repr(price)}, "traded_at": {"S": traded_at}},
            )
            written += 1
            time.sleep(1.0 / DYNAMO_WRITES_PER_SECOND)
        return written, len(items) - written


# ── Alpaca ───────────────────────────────────────────────────────────────────


def _alpaca_get(store: DynamoStore, path: str, params: Mapping[str, Any]) -> dict:
    store.take_alpaca_tokens(1)
    response = httpx.get(f"{ALPACA_DATA_URL}{path}", params=params, headers=alpaca_headers(), timeout=HTTP_TIMEOUT_SECONDS)
    if response.status_code in (401, 403):
        raise VendorUnavailable(f"alpaca {path} auth {response.status_code}")
    if response.status_code == 429:
        raise AlpacaBudgetExhausted("alpaca 429")
    response.raise_for_status()
    return response.json()


def fetch_news_page(
    store: DynamoStore, start: datetime, page_token: Optional[str] = None, symbols: Optional[Sequence[str]] = None
) -> tuple[list[dict], Optional[str]]:
    """One page of /v1beta1/news, oldest first, no bodies (summaries only)."""
    params: dict[str, Any] = {
        "start": iso_utc(start),
        "sort": "asc",
        "limit": NEWS_PAGE_LIMIT,
        "include_content": "false",
    }
    if symbols:
        params["symbols"] = ",".join(symbols)
    if page_token:
        params["page_token"] = page_token
    payload = _alpaca_get(store, "/v1beta1/news", params)
    return payload.get("news", []), payload.get("next_page_token")


def is_trading_day(store: DynamoStore, day) -> bool:
    """Broker calendar lookup (one budgeted call). Resolves exchange holidays the weekday rule can't."""
    store.take_alpaca_tokens(1)
    response = httpx.get(
        "https://paper-api.alpaca.markets/v2/calendar",
        params={"start": day.isoformat(), "end": day.isoformat()},
        headers=alpaca_headers(),
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return any(entry["date"] == day.isoformat() for entry in response.json())


def fetch_snapshots(store: DynamoStore, tickers: Sequence[str]) -> dict[str, dict]:
    """Latest trade + daily bar for up to SNAPSHOT_BATCH tickers (IEX feed, real-time quotes)."""
    symbols = [normalize_to_alpaca(t) for t in tickers]
    payload = _alpaca_get(store, "/v2/stocks/snapshots", {"symbols": ",".join(symbols), "feed": "iex"})
    return {normalize_from_alpaca(symbol): snap for symbol, snap in payload.items() if snap}


# ── Finnhub (corroboration only) ─────────────────────────────────────────────


def fetch_finnhub_company_news(symbol: str, from_date: str, to_date: str) -> list[dict]:
    """Free /company-news. 401/403 means the key or plan changed: raise, don't fall back."""
    response = httpx.get(
        f"{FINNHUB_URL}/company-news",
        params={"symbol": symbol, "from": from_date, "to": to_date},
        headers={"X-Finnhub-Token": os.environ["FINNHUB_API_KEY"]},
        timeout=HTTP_TIMEOUT_SECONDS,
    )
    if response.status_code in (401, 403):
        raise VendorUnavailable(f"finnhub company-news {response.status_code}")
    if response.status_code == 429:
        raise VendorUnavailable("finnhub 429")
    response.raise_for_status()
    return response.json()


# ── Neon ─────────────────────────────────────────────────────────────────────


async def connect():
    import asyncpg

    return await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)


async def load_universe(conn) -> dict[str, dict]:
    """Active universe: ticker -> {name, universe}."""
    rows = await conn.fetch("SELECT ticker, name, universe FROM ticker_universe WHERE active")
    return {r["ticker"]: {"name": r["name"], "universe": r["universe"]} for r in rows}


async def log_run(
    conn,
    pipeline: str,
    status: str,
    summary: Mapping[str, Any],
    items_total: int = 0,
    coverage: Optional[Mapping[str, Any]] = None,
    session: Optional[str] = None,
) -> None:
    """One pipeline_run_log row so nulogdash shows this run and any gap it reports."""
    await conn.execute(
        """INSERT INTO pipeline_run_log (pipeline, dry_run, session, items_total, summary, host, status, coverage)
           VALUES ($1, false, $2, $3, $4::jsonb, 'modal', $5, $6::jsonb)""",
        pipeline,
        session,
        items_total,
        json.dumps(summary, default=str),
        status,
        json.dumps(coverage or {}, default=str),
    )


def chunked(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for start in range(0, len(items), size):
        yield items[start : start + size]


def minute_floor(now: datetime) -> datetime:
    return now.replace(second=0, microsecond=0)


def hours_ago(now: datetime, hours: float) -> datetime:
    return now - timedelta(hours=hours)
