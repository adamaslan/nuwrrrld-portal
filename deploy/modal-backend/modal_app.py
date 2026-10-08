"""
Modal App for NuWrrrld Financial (Modal-side components; the web stays on Vercel).

Deploy:  DEPLOY_ENV=staging modal deploy deploy/modal-backend/modal_app.py --env staging
Dev:     modal serve  deploy/modal-backend/modal_app.py --env staging   (schedules do not fire under `serve`)
Run one: modal run deploy/modal-backend/modal_app.py::signals_pipeline --env staging

Everything here is a thin wrapper over nuwrrrld.jobs.entrypoints (plain Python, unit-tested).
Run these from deploy/modal-backend/ so `nuwrrrld` and council_members.yaml resolve.
"""
import os

import modal

APP_NAME = "nuwrrrld"
ET = "America/New_York"        # every Cron is in market time; Modal handles DST
DEPLOY_ENV = os.environ.get("DEPLOY_ENV", "staging")
API_DOMAINS = {"prod": ["api.financial.nuwrrrld.com"], "staging": []}.get(DEPLOY_ENV, [])
CONSOLIDATE_CRONS = os.environ.get("CRON_CONSOLIDATE", "0") == "1"   # fold the evening stages into one dispatcher

app = modal.App(APP_NAME)

# --- Secrets (must exist in the target Modal environment) ---------------------------------------------
db_secret = modal.Secret.from_name("nuwrrrld-db")
clerk_secret = modal.Secret.from_name("nuwrrrld-clerk")
stripe_secret = modal.Secret.from_name("nuwrrrld-stripe")
market_secret = modal.Secret.from_name("nuwrrrld-market")
llm_secret = modal.Secret.from_name("nuwrrrld-llm")
obs_secret = modal.Secret.from_name("nuwrrrld-observability")
aws_secret = modal.Secret.from_name("nuwrrrld-aws")        # DynamoDB only (IAM scoped to table/nwf_*)

API_SECRETS = [db_secret, clerk_secret, stripe_secret, llm_secret, obs_secret, aws_secret]
JOB_SECRETS = [db_secret, market_secret, llm_secret, obs_secret, aws_secret]
BILLING_SECRETS = [db_secret, stripe_secret, obs_secret, aws_secret]

# --- Shared state primitives ---------------------------------------------------------------------------
market_cache = modal.Volume.from_name("nuwrrrld-market-cache", create_if_missing=True)   # parquet + raw dumps
hot_cache = modal.Dict.from_name("nuwrrrld-hot-cache", create_if_missing=True)           # NOT authoritative
council_events = modal.Queue.from_name("nuwrrrld-council-events", create_if_missing=True)
live_last = modal.Dict.from_name("nuwrrrld-live-last", create_if_missing=True)

# --- Image ------------------------------------------------------------------------------------------------
py_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install(
        "fastapi[standard]~=0.115", "asyncpg~=0.30", "psycopg[binary]~=3.2", "pydantic-settings~=2.6", "httpx~=0.28",
        "PyJWT[crypto]~=2.10", "svix~=1.40", "stripe~=11.0", "pandas~=2.2", "numpy~=2.1", "pyarrow~=18.0",
        "exchange_calendars~=4.5", "tenacity~=9.0", "sentry-sdk[fastapi]~=2.18", "pyyaml~=6.0", "boto3~=1.35",
    )
    .env({"PYTHONUNBUFFERED": "1"})
    .add_local_file("council_members.yaml", "/root/council_members.yaml")
    .add_local_python_source("nuwrrrld")          # keep last: code-only edits don't rebuild layers
)

JOB_RETRIES = modal.Retries(max_retries=3, initial_delay=10.0, backoff_coefficient=2.0, max_delay=60.0)


def et_cron(expr: str) -> modal.Cron:
    return modal.Cron(expr, timezone=ET)


def evening(expr: str):
    """Schedule an evening stage unless crons are consolidated into evening_dispatcher."""
    return None if CONSOLIDATE_CRONS else et_cron(expr)


def _ep():
    from nuwrrrld.jobs import entrypoints
    return entrypoints


def _init_obs():
    import sentry_sdk
    if os.environ.get("SENTRY_DSN"):
        sentry_sdk.init(dsn=os.environ["SENTRY_DSN"], environment=os.environ.get("MODAL_ENVIRONMENT", "prod"))
    from nuwrrrld import logging_utils
    logging_utils.configure()


# =====================================================================================
# API (FastAPI)
# =====================================================================================
@app.function(image=py_image, secrets=API_SECRETS, min_containers=1, scaledown_window=600, timeout=300, cpu=1.0, memory=1024)
@modal.concurrent(max_inputs=50)
@modal.asgi_app(custom_domains=API_DOMAINS)
def api():
    from nuwrrrld.api.main import create_app
    return create_app()


# =====================================================================================
# Market-close pipeline
# =====================================================================================
@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("30 16 * * 1-5"), timeout=1800, retries=JOB_RETRIES)
def paper_fill_close(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().paper_fill("market_on_close", run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, volumes={"/cache": market_cache}, schedule=evening("30 17 * * 1-5"),
              timeout=3600, retries=JOB_RETRIES)
def ingest_eod_bars(run_key: str | None = None, force: bool = False):
    _init_obs()
    out = _ep().ingest_eod("/cache", run_key, force)
    market_cache.commit()                       # make Parquet writes visible to other containers
    return out


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=evening("50 17 * * 1-5"), timeout=3600, retries=JOB_RETRIES)
def equity_snapshots(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().equity_snapshots(run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, volumes={"/cache": market_cache}, schedule=evening("0 18 * * 1-5"),
              timeout=1800, retries=JOB_RETRIES)
def signals_pipeline(run_key: str | None = None, force: bool = False):
    """indicators -> signals -> hold/fold -> sector rotation -> alerts -> spawn explanations."""
    _init_obs()
    market_cache.reload()                       # see bars committed by ingest
    return _ep().signals_pipeline(lambda run_id, ids: explain_digest.spawn(run_id, ids), run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=1800, retries=JOB_RETRIES)
def explain_digest(run_id: str, signal_ids: list[str]):
    _init_obs()
    return _ep().explain_digest(lambda ids: list(explain_one_signal.map(ids, return_exceptions=True)), run_id, signal_ids)


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=300, retries=JOB_RETRIES, max_containers=10)
def explain_one_signal(signal_id: str) -> str:
    return _ep().explain_one(signal_id)         # no-op when an explanation exists for this prompt_version


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("0 7 * * 1-5"), timeout=600, retries=JOB_RETRIES)
def digest_publish(run_key: str | None = None, force: bool = False):
    _init_obs()

    def set_cache(payload: dict):
        hot_cache[f"digest:{payload['as_of']}"] = payload
        hot_cache["digest:latest"] = payload
    return _ep().digest_publish(set_cache, run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=evening("20 18 * * 1-5"), timeout=1800, retries=JOB_RETRIES)
def followed_score(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().followed_score(lambda cid, gt, hz: followed_grade.spawn(cid, gt, hz), run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("0 7 1-7 * *"), timeout=1800, retries=JOB_RETRIES)
def followed_freeze(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().followed_freeze(lambda cid, gt, hz: followed_grade.spawn(cid, gt, hz), run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=300, retries=JOB_RETRIES, max_containers=10)
def followed_grade(call_id: str, grade_type: str, horizon: str = "none") -> str:
    return _ep().followed_grade(call_id, grade_type, horizon)


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("30 20 * * 1-5"), timeout=1800, retries=JOB_RETRIES)
def factor_refresh(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().factor_refresh(run_key, force)


# =====================================================================================
# Council + paper trading
# =====================================================================================
def _map_sessions(ids: list[str]) -> None:
    list(run_council_session.map(ids, return_exceptions=True))


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=evening("45 18 * * 1-5"), timeout=3600, retries=JOB_RETRIES)
def council_daily(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().council_cycle("daily", _map_sessions, run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=evening("0 19 * * 4,5"), timeout=3600, retries=JOB_RETRIES)
def council_weekly(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().council_cycle("weekly", _map_sessions, run_key, force)   # acts only on the week's last session


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=1800, retries=JOB_RETRIES, max_containers=10)
def run_council_session(session_id: str) -> str:
    """One debate. Spawned for on-demand sessions, mapped for scheduled ones."""
    from nuwrrrld.jobs.council import ModalQueueEvents
    return _ep().run_session(session_id, ModalQueueEvents(council_events))


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("40 9 * * 1-5"), timeout=4200, retries=JOB_RETRIES)
def paper_fill_open(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().paper_fill("market_on_open", run_key, force)   # polls for the official open until 10:40 ET


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("0 8 * * 6"), timeout=1800, retries=JOB_RETRIES)
def health_checks_weekly(run_key: str | None = None, force: bool = False):
    _init_obs()
    return _ep().health_checks_weekly(lambda cid: run_health_check.spawn(cid), run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=600, retries=JOB_RETRIES, max_containers=10)
def run_health_check(check_id: str) -> str:
    return _ep().run_health_check(check_id)


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=300)
def summarize_thread(thread_id: str) -> bool:
    return _ep().summarize_thread(thread_id)


# =====================================================================================
# Billing / ops
# =====================================================================================
@app.function(image=py_image, secrets=BILLING_SECRETS, schedule=modal.Cron("0 * * * *", timezone=ET), timeout=600, retries=JOB_RETRIES)
def trial_sweeper(run_key: str | None = None, force: bool = False):
    return _ep().trial_sweeper(run_key, force)


@app.function(image=py_image, secrets=BILLING_SECRETS, schedule=et_cron("15 4 * * *"), timeout=1800, retries=JOB_RETRIES)
def billing_reconcile(run_key: str | None = None, force: bool = False):
    return _ep().billing_reconcile(run_key, force)


@app.function(image=py_image, secrets=BILLING_SECRETS, schedule=et_cron("30 4 * * *"), timeout=1800, retries=JOB_RETRIES)
def referral_qualifier(run_key: str | None = None, force: bool = False):
    return _ep().referral_qualifier(run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, volumes={"/cache": market_cache}, schedule=et_cron("0 5 * * 1-6"),
              timeout=3600, retries=JOB_RETRIES)
def backfill_gaps(run_key: str | None = None, force: bool = False):
    """Detect gaps over the last 10 sessions and re-run the idempotent stage."""
    _init_obs()

    def repair(gaps: dict) -> None:
        for day in gaps["bars"]:
            for t in _ep().universe.tracked_tickers(_ep().db.sync_connect()):
                backfill_bars_for_ticker.spawn(t, day, day)
        for day in gaps["signals"] + gaps["explanations"]:
            backfill_signals_for_date.spawn(day)
        for cid in gaps["grades"]:
            followed_grade.spawn(cid, "ex_ante", "none")
        for line in gaps["rebuild"]:
            _ep().maintenance.post_alerts([f"paper rebuild mismatch: {line}"])
    return _ep().backfill_gaps(repair, run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("0 3 1 * *"), timeout=600, retries=JOB_RETRIES)
def calendar_refresh(run_key: str | None = None, force: bool = False):
    return _ep().calendar_refresh(run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, volumes={"/cache": market_cache}, schedule=et_cron("0 3 * * 0"),
              timeout=1800, retries=JOB_RETRIES)
def maintenance(run_key: str | None = None, force: bool = False):
    return _ep().maintenance_job("/cache", run_key, force)


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=modal.Period(minutes=15), timeout=300)
def watchdog():
    _init_obs()
    return _ep().watchdog(lambda tripped: hot_cache.__setitem__("llm_breaker", tripped))


# =====================================================================================
# AWS-Modal pipeline pieces: live prices (Alpaca -> DynamoDB -> portal)
# =====================================================================================
@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("* 9-16 * * 1-5"), timeout=120)
def alpaca_live_poller():
    """Every minute during market hours; poll_once() itself enforces 09:30-16:00 ET."""
    from nuwrrrld import db
    from nuwrrrld.jobs import live_poller, universe
    from nuwrrrld.providers import get_provider
    conn = db.sync_connect()
    try:
        tickers = universe.tracked_tickers(conn) + universe.benchmark_tickers(conn)
    finally:
        conn.close()
    last = dict(live_last.items()) if hasattr(live_last, "items") else {}
    result = live_poller.poll_once(get_provider("alpaca"), sorted(set(tickers)), last=last)
    for t, px in last.items():
        live_last[t] = px
    return result


# =====================================================================================
# Backfills
# =====================================================================================
@app.function(image=py_image, secrets=JOB_SECRETS, volumes={"/cache": market_cache}, timeout=3600)
def backfill_bars_for_ticker(ticker: str, start: str, end: str) -> int:
    from nuwrrrld import db
    from nuwrrrld.jobs import ingest
    from nuwrrrld.providers import get_fallback, get_provider
    conn = db.sync_connect()
    try:
        n = ingest.backfill_ticker(conn, get_provider(), get_fallback(), ticker, start, end, cache_dir="/cache")
    finally:
        conn.close()
    market_cache.commit()
    return n


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=3600)
def backfill_signals_for_date(as_of: str) -> str:
    from nuwrrrld import db
    from nuwrrrld.jobs import signals
    conn = db.sync_connect()
    try:
        return signals.generate_backfill(conn, as_of)   # is_backfill=True: no alerts, no council, no orders
    finally:
        conn.close()


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=3600)
def backfill_job(start: str, end: str, stage: str = "all") -> dict:
    """Server-side backfill used by POST /admin/backfill."""
    from nuwrrrld import db
    from nuwrrrld.jobs import universe
    conn = db.sync_connect()
    try:
        tickers, days = universe.tracked_tickers(conn) + universe.benchmark_tickers(conn), universe.trading_days(start, end, conn)
    finally:
        conn.close()
    out = {}
    if stage in ("all", "bars"):
        out["bars"] = sum(backfill_bars_for_ticker.starmap([(t, start, end) for t in sorted(set(tickers))]))
    if stage in ("all", "signals"):
        out["signals"] = len(list(backfill_signals_for_date.map(days, return_exceptions=True)))
    return out


@app.function(image=py_image, secrets=JOB_SECRETS, schedule=et_cron("30 17 * * 1-5") if CONSOLIDATE_CRONS else None, timeout=7200)
def evening_dispatcher():
    """Used only with CRON_CONSOLIDATE=1 (when the plan's cron cap is hit). Idempotency keys make this safe."""
    ingest_eod_bars.remote()
    equity_snapshots.remote()
    signals_pipeline.remote()
    followed_score.remote()
    council_daily.remote()
    council_weekly.remote()


# =====================================================================================
# Staging smoke test + operator entrypoints
# =====================================================================================
@app.function(image=py_image, secrets=JOB_SECRETS)
def provider_healthcheck() -> bool:
    from nuwrrrld.providers import get_provider
    return get_provider().healthcheck()


@app.function(image=py_image, secrets=[db_secret])
def db_ping() -> bool:
    import asyncio
    import asyncpg

    async def go():
        conn = await asyncpg.connect(os.environ["DATABASE_URL"], statement_cache_size=0)
        try:
            return (await conn.fetchval("SELECT 1")) == 1
        finally:
            await conn.close()
    return asyncio.run(go())


@app.function(image=py_image, secrets=[aws_secret])
def dynamo_ping() -> bool:
    from nuwrrrld import dynamo
    return len(dynamo.Dynamo().table(dynamo.TABLE_PIPELINE).table_status or "") > 0


@app.function(image=py_image.add_local_dir("migrations", "/root/migrations"), secrets=[db_secret], timeout=900)
def migrate() -> list[str]:
    from pathlib import Path
    import psycopg
    applied = []
    with psycopg.connect(os.environ["DATABASE_URL_DIRECT"], autocommit=True) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        for path in sorted(Path("/root/migrations").glob("*.sql")):
            if conn.execute("SELECT 1 FROM schema_migrations WHERE name=%s", (path.name,)).fetchone():
                continue
            with conn.transaction():
                conn.execute(path.read_text())
                conn.execute("INSERT INTO schema_migrations (name) VALUES (%s)", (path.name,))
            applied.append(path.name)
    return applied


@app.function(image=py_image, secrets=JOB_SECRETS, timeout=900)
def seed(instruments_json: str = "[]") -> dict:
    """Idempotent seeds: council seats + paper portfolios (+ instruments when provided). Calendar via calendar_refresh."""
    import json
    from nuwrrrld import db
    from nuwrrrld.jobs import council as council_jobs, maintenance
    conn = db.sync_connect()
    try:
        rows = json.loads(instruments_json)
        n = council_jobs.seed_instruments(conn, rows) if rows else 0
        cal = maintenance.calendar_refresh(conn)
        return {"instruments": n, "calendar_rows": cal, **council_jobs.seed_council(conn, council_jobs.load_yaml())}
    finally:
        conn.close()


@app.function(image=py_image, secrets=[aws_secret], timeout=300)
def provision_dynamo() -> list[str]:
    """Create the nwf_* tables if missing (free tier: provisioned <= 25 RCU / 25 WCU in total)."""
    from nuwrrrld import dynamo
    return dynamo.Dynamo().ensure_tables()


@app.local_entrypoint()
def smoke():
    """modal run deploy/modal-backend/modal_app.py::smoke --env staging"""
    print("api url:", api.get_web_url())
    assert db_ping.remote(), "DB unreachable"
    assert provider_healthcheck.remote(), "market data provider unhealthy"
    print("smoke OK")


@app.local_entrypoint()
def backfill(start: str, end: str, stage: str = "all"):
    """modal run deploy/modal-backend/modal_app.py::backfill --start 2024-01-01 --end 2026-10-06 --stage all --env staging"""
    print(backfill_job.remote(start, end, stage))
