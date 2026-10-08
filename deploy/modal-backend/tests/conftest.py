"""Shared fixtures. DB tests need a real Postgres (TEST_PG_ADMIN_URL) and are skipped when it is absent."""
from __future__ import annotations

import datetime as dt
import os
import uuid
from decimal import Decimal
from pathlib import Path

import numpy as np
import pytest

ADMIN_URL = os.environ.get("TEST_PG_ADMIN_URL", "postgresql://postgres@localhost:54329/postgres")
MIGRATIONS = sorted((Path(__file__).resolve().parents[1] / "migrations").glob("*.sql"))

os.environ.setdefault("DYNAMO_MIRROR", "off")           # opt in per-test (moto) so tests never touch AWS
os.environ.setdefault("AWS_ACCESS_KEY_ID", "test")
os.environ.setdefault("AWS_SECRET_ACCESS_KEY", "test")
os.environ.setdefault("AWS_REGION", "us-east-1")


def _pg_available() -> bool:
    try:
        import psycopg
        with psycopg.connect(ADMIN_URL, connect_timeout=2):
            return True
    except Exception:
        return False


@pytest.fixture(scope="session")
def test_dsn():
    if not _pg_available():
        pytest.skip("no local Postgres (set TEST_PG_ADMIN_URL)")
    import psycopg
    name = f"nwf_test_{uuid.uuid4().hex[:8]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    dsn = ADMIN_URL.rsplit("/", 1)[0] + f"/{name}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        for m in MIGRATIONS:
            conn.execute(m.read_text())
    yield dsn
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture()
def conn(test_dsn):
    import psycopg
    from psycopg.rows import dict_row
    c = psycopg.connect(test_dsn, autocommit=True, row_factory=dict_row, prepare_threshold=None)
    c.execute("""TRUNCATE users, instruments, trading_calendar, council_members, webhook_events, job_runs, audit_log,
                 corporate_actions, llm_usage, user_llm_budgets, followed_batches, signal_runs, rate_limits CASCADE""")
    yield c
    c.close()


TRACKED = ["XLE", "XLK", "XLF", "XLV"]


@pytest.fixture()
def universe_rows(conn):
    conn.execute("INSERT INTO instruments (ticker,name,asset_type,sector,is_tracked_etf) VALUES ('SPY','SPDR S&P 500','etf','Broad',false)")
    for t, sector in zip(TRACKED, ["Energy", "Technology", "Financials", "Health"]):
        conn.execute("INSERT INTO instruments (ticker,name,asset_type,sector,is_tracked_etf,benchmark) VALUES (%s,%s,'etf',%s,true,'SPY')",
                     (t, f"{t} fund", sector))
    return TRACKED


def seed_bars(conn, tickers, end: dt.date, n=330, seed=7, drift=None):
    """Synthetic but deterministic final bars for `n` sessions ending at `end` (weekday dates)."""
    rng = np.random.default_rng(seed)
    days, d = [], end
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d)
        d -= dt.timedelta(days=1)
    days.reverse()
    rows = []
    for k, t in enumerate(tickers):
        mu = (drift or {}).get(t, 0.0004 * (k - 1))
        close = 100 * np.cumprod(1 + mu + rng.normal(0, 0.008, n))
        rows.extend((t, day, round(c, 4), round(c * 1.004, 4), round(c * 0.996, 4), round(c, 4), 1_000_000, round(c, 4))
                    for day, c in zip(days, close))
    with conn.cursor() as cur:               # one batch instead of one round trip per bar
        cur.executemany(
            """INSERT INTO price_bars (ticker,timeframe,bar_date,open,high,low,close,volume,adj_close,adj_factor,provider)
               VALUES (%s,'1d',%s,%s,%s,%s,%s,%s,%s,1,'test') ON CONFLICT DO NOTHING""", rows)
    return days


@pytest.fixture()
def bars(conn, universe_rows):
    return seed_bars(conn, ["SPY", *universe_rows], dt.date(2026, 10, 6))


def make_user(conn, email="a@example.com", clerk="user_a"):
    from nuwrrrld.billing import users
    return users.get_or_create_by_clerk_id(conn, clerk, email)
