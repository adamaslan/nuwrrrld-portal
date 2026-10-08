"""Database access. asyncpg pool for the API; psycopg (sync, autocommit) for jobs.

Both go through the pooled DATABASE_URL (PgBouncer transaction mode): no prepared statements.
Migrations use DATABASE_URL_DIRECT.
"""
from __future__ import annotations

import json
import os

import asyncpg

_pool: asyncpg.Pool | None = None


async def _init_conn(conn: asyncpg.Connection) -> None:
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


async def init_pool(min_size: int = 1, max_size: int = 5, dsn: str | None = None) -> None:
    global _pool
    _pool = await asyncpg.create_pool(
        dsn=dsn or os.environ["DATABASE_URL"],
        min_size=min_size,
        max_size=max_size,
        statement_cache_size=0,  # PgBouncer transaction-mode safe
        command_timeout=30,
        init=_init_conn,
    )
    # Pooler-safe: set the session timezone with a statement, not a startup parameter.
    async with _pool.acquire() as conn:
        await conn.execute("SET TIME ZONE 'UTC'")


def pool() -> asyncpg.Pool:
    assert _pool is not None, "init_pool() not called"
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def sync_connect(dsn: str | None = None):
    """Autocommit psycopg connection for job code (claims/heartbeats must be visible at once)."""
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(dsn or os.environ["DATABASE_URL"], autocommit=True,
                           prepare_threshold=None, row_factory=dict_row)
