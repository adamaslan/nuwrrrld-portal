"""DynamoDB layer (free tier, provisioned <= 25 RCU / 25 WCU in total).

Role (owner decision 2026-10-07: "have Dynamo receive all the data"):
  * `nwf_pipeline_data`  - write-through MIRROR of every pipeline output (bars, indicators,
                           signals, hold/fold, rotation, council, paper, followed, billing
                           snapshots, job runs). Neon stays the system of record; a mirror
                           failure NEVER fails a job (logged at WARNING).
  * `nwf_live_prices`    - latest intraday price per ticker (Alpaca poller).
  * `nwf_rate_budget`    - shared Alpaca request budget, atomic per-minute counter.
  * `nwf_market_cache`   - short-TTL provider cache (native TTL attribute `expires_at`).
  * `nwf_locks`          - best-effort cross-pipeline locks.

Item layout of nwf_pipeline_data:  pk = "<kind>#<key>"   sk = "<sort>"
  e.g. pk="signals#XLE" sk="2026-10-06", pk="paper_equity#<portfolio>" sk="2026-10-06".
Every item carries `kind`, `mirrored_at`, and `data` (the row, JSON-safe).
"""
from __future__ import annotations

import datetime as dt
import json
import logging
import os
import time
import uuid
from decimal import Decimal
from typing import Any, Callable, Iterable, Mapping

log = logging.getLogger(__name__)

TABLE_PIPELINE = "nwf_pipeline_data"
TABLE_LIVE = "nwf_live_prices"
TABLE_BUDGET = "nwf_rate_budget"
TABLE_CACHE = "nwf_market_cache"
TABLE_LOCKS = "nwf_locks"

ALPACA_MAX_PER_MINUTE = 190  # Basic data plan is ~200/min across ALL pipelines
MAX_ITEM_BYTES = 350_000     # DynamoDB hard limit is 400 KB; leave headroom
BATCH_SIZE = 25

# Provisioned capacity (RCU, WCU) - sums to 25/25, the free-tier ceiling.
CAPACITY: dict[str, tuple[int, int]] = {
    TABLE_PIPELINE: (10, 12),
    TABLE_LIVE: (6, 5),
    TABLE_BUDGET: (3, 4),
    TABLE_CACHE: (4, 3),
    TABLE_LOCKS: (2, 1),
}


class AlpacaBudgetExhausted(Exception):
    pass


def to_ddb(value: Any) -> Any:
    """Convert a DB row value to something boto3 will accept (no floats, no empty sets)."""
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return Decimal(repr(value)) if value == value and value not in (float("inf"), float("-inf")) else None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex()
    if isinstance(value, Mapping):
        return {str(k): to_ddb(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_ddb(v) for v in value]
    return str(value)


def _enabled() -> bool:
    return os.environ.get("DYNAMO_MIRROR", "on").lower() not in ("off", "0", "false")


def _client_kwargs() -> dict:
    kw: dict = {"region_name": os.environ.get("AWS_REGION", "us-east-1")}
    if os.environ.get("DYNAMODB_ENDPOINT_URL"):  # local/test endpoint
        kw["endpoint_url"] = os.environ["DYNAMODB_ENDPOINT_URL"]
    return kw


class Dynamo:
    """Thin, failure-isolating wrapper. Construct once per container."""

    def __init__(self, resource=None):
        self._resource = resource
        self._tables: dict[str, Any] = {}

    # -- plumbing -------------------------------------------------------------
    @property
    def resource(self):
        if self._resource is None:
            import boto3
            from botocore.config import Config
            self._resource = boto3.resource(
                "dynamodb", config=Config(retries={"max_attempts": 8, "mode": "adaptive"}),
                **_client_kwargs())
        return self._resource

    def table(self, name: str):
        if name not in self._tables:
            self._tables[name] = self.resource.Table(name)
        return self._tables[name]

    def ensure_tables(self) -> list[str]:
        """Idempotently create all tables (used by `modal run ... ::provision_dynamo` and tests)."""
        created = []
        existing = {t.name for t in self.resource.tables.all()}
        specs = {
            TABLE_PIPELINE: ("pk", "sk"), TABLE_LIVE: ("ticker", None), TABLE_BUDGET: ("bucket", None),
            TABLE_CACHE: ("cache_key", None), TABLE_LOCKS: ("lock_key", None)}
        for name, (hash_key, range_key) in specs.items():
            if name in existing:
                continue
            attrs = [{"AttributeName": hash_key, "AttributeType": "S"}]
            schema = [{"AttributeName": hash_key, "KeyType": "HASH"}]
            if range_key:
                attrs.append({"AttributeName": range_key, "AttributeType": "S"})
                schema.append({"AttributeName": range_key, "KeyType": "RANGE"})
            rcu, wcu = CAPACITY[name]
            self.resource.create_table(
                TableName=name, AttributeDefinitions=attrs, KeySchema=schema,
                ProvisionedThroughput={"ReadCapacityUnits": rcu, "WriteCapacityUnits": wcu})
            created.append(name)
        for name in (TABLE_CACHE, TABLE_LOCKS):  # native TTL
            try:
                self.resource.meta.client.update_time_to_live(
                    TableName=name, TimeToLiveSpecification={"Enabled": True, "AttributeName": "expires_at"})
            except Exception as exc:  # TTL already enabled / unsupported by local endpoint
                log.debug("ttl setup skipped for %s: %s", name, exc)
        return created

    # -- mirror (the "receive all the data" path) -----------------------------
    def mirror(self, kind: str, rows: Iterable[Mapping[str, Any]], *,
               key: Callable[[Mapping[str, Any]], str],
               sort: Callable[[Mapping[str, Any]], str]) -> int:
        """Write rows to nwf_pipeline_data. Returns items written; never raises."""
        if not _enabled():
            return 0
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        items = []
        for row in rows:
            data = to_ddb(dict(row))
            item = {"pk": f"{kind}#{key(row)}", "sk": str(sort(row)), "kind": kind,
                    "mirrored_at": now, "data": data}
            if len(json.dumps(item, default=str)) > MAX_ITEM_BYTES:
                item["data"] = {"truncated": True, "keys": sorted(data)[:50]}
                log.warning("dynamo mirror: %s item over size budget, stored truncated marker", kind)
            items.append(item)
        if not items:
            return 0
        written = 0
        try:
            with self.table(TABLE_PIPELINE).batch_writer(overwrite_by_pkeys=["pk", "sk"]) as bw:
                for item in items:
                    bw.put_item(Item=item)
                    written += 1
        except Exception as exc:  # ClientError, BotoCoreError, missing creds ...
            log.warning("dynamo mirror failed kind=%s written=%d/%d err=%s", kind, written, len(items), exc)
        return written

    def query(self, kind: str, key: str, *, sk_prefix: str | None = None, limit: int = 100) -> list[dict]:
        from boto3.dynamodb.conditions import Key
        cond = Key("pk").eq(f"{kind}#{key}")
        if sk_prefix:
            cond = cond & Key("sk").begins_with(sk_prefix)
        return self.table(TABLE_PIPELINE).query(
            KeyConditionExpression=cond, Limit=limit, ScanIndexForward=False).get("Items", [])

    # -- live prices -----------------------------------------------------------
    def put_live_prices(self, prices: Mapping[str, Mapping[str, Any]]) -> int:
        n = 0
        try:
            with self.table(TABLE_LIVE).batch_writer() as bw:
                for ticker, p in prices.items():
                    bw.put_item(Item={"ticker": ticker, **to_ddb(dict(p))})
                    n += 1
        except Exception as exc:
            log.warning("dynamo live price write failed: %s", exc)
        return n

    # -- shared Alpaca rate budget ----------------------------------------------
    def take_alpaca_tokens(self, n: int, *, now: float | None = None) -> None:
        """Atomically reserve n requests in the current minute; raise if the cap would be exceeded."""
        from botocore.exceptions import ClientError
        bucket = f"alpaca#{int((now or time.time()) // 60)}"
        try:
            self.table(TABLE_BUDGET).update_item(
                Key={"bucket": bucket},
                UpdateExpression="ADD used :n SET expires_at = :exp",
                ConditionExpression="attribute_not_exists(used) OR used <= :room",
                ExpressionAttributeValues={":n": n, ":room": ALPACA_MAX_PER_MINUTE - n,
                                           ":exp": int((now or time.time())) + 3600})
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise AlpacaBudgetExhausted(bucket) from exc
            raise

    def wait_for_alpaca_tokens(self, n: int, *, sleep: Callable[[float], None] = time.sleep,
                               max_waits: int = 3) -> None:
        """Wait for the next minute boundary instead of falling through to another vendor."""
        for _ in range(max_waits):
            try:
                self.take_alpaca_tokens(n)
                return
            except AlpacaBudgetExhausted:
                sleep(60 - (time.time() % 60) + 1)
        raise AlpacaBudgetExhausted("budget still exhausted after waiting")

    # -- cache + locks -----------------------------------------------------------
    def cache_get(self, key: str) -> Any | None:
        item = self.table(TABLE_CACHE).get_item(Key={"cache_key": key}).get("Item")
        if not item or int(item.get("expires_at", 0)) < time.time():
            return None
        return json.loads(item["payload"])

    def cache_put(self, key: str, payload: Any, ttl_seconds: int) -> None:
        try:
            self.table(TABLE_CACHE).put_item(Item={
                "cache_key": key, "payload": json.dumps(payload, default=str),
                "expires_at": int(time.time()) + ttl_seconds})
        except Exception as exc:
            log.warning("dynamo cache write failed: %s", exc)

    def try_lock(self, name: str, ttl_seconds: int, owner: str) -> bool:
        from botocore.exceptions import ClientError
        now = int(time.time())
        try:
            self.table(TABLE_LOCKS).put_item(
                Item={"lock_key": name, "owner": owner, "expires_at": now + ttl_seconds},
                ConditionExpression="attribute_not_exists(lock_key) OR expires_at < :now",
                ExpressionAttributeValues={":now": now})
            return True
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise


_default: Dynamo | None = None


def default() -> Dynamo:
    global _default
    if _default is None:
        _default = Dynamo()
    return _default


# Convenience used by every job: mirror rows with a key/sort spec.
MIRROR_SPECS: dict[str, tuple[Callable, Callable]] = {
    "price_bars": (lambda r: r["ticker"], lambda r: r["bar_date"]),
    "indicator_values": (lambda r: r["ticker"], lambda r: f"{r['bar_date']}#{r['indicator']}"),
    "signals": (lambda r: r["ticker"], lambda r: r["as_of_date"]),
    "signal_runs": (lambda r: r["as_of_date"], lambda r: r.get("engine_version", "1")),
    "hold_fold": (lambda r: r["ticker"], lambda r: f"{r['as_of_date']}#{r.get('scope', 'global')}"),
    "sector_rotation": (lambda r: r["ticker"], lambda r: r["as_of_date"]),
    "council_sessions": (lambda r: r["subject_ticker"], lambda r: f"{r['as_of_date']}#{r['id']}"),
    "council_consensus": (lambda r: r["session_id"], lambda r: "consensus"),
    "paper_orders": (lambda r: r["portfolio_id"], lambda r: f"{r['decision_date']}#{r['id']}"),
    "paper_fills": (lambda r: r["portfolio_id"], lambda r: f"{r['session_date']}#{r['id']}"),
    "paper_equity": (lambda r: r["portfolio_id"], lambda r: r["session_date"]),
    "followed_calls": (lambda r: r["batch_id"], lambda r: f"{r['side']}#{int(r['rank']):02d}"),
    "followed_scores": (lambda r: r["call_id"], lambda r: r["horizon"]),
    "followed_grades": (lambda r: r["call_id"], lambda r: f"{r['grade_type']}#{r['horizon']}#{r['prompt_version']}"),
    "factor_exposures": (lambda r: r["ticker"], lambda r: f"{r['as_of_date']}#{r['factor']}"),
    "portfolio_health": (lambda r: r["user_id"], lambda r: f"{r['as_of_date']}#{r['holdings_hash']}"),
    "job_runs": (lambda r: r["job_name"], lambda r: r["run_key"]),
    "llm_usage_daily": (lambda r: r["feature"], lambda r: r["day"]),
}


def mirror_rows(kind: str, rows: Iterable[Mapping[str, Any]], dynamo: Dynamo | None = None) -> int:
    key, sort = MIRROR_SPECS[kind]
    return (dynamo or default()).mirror(kind, rows, key=key, sort=sort)
