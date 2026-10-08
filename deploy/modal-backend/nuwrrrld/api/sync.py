"""Run synchronous psycopg business logic (billing, referrals) from async handlers."""
from __future__ import annotations

from typing import Callable, TypeVar

from starlette.concurrency import run_in_threadpool

from nuwrrrld import db

T = TypeVar("T")


async def with_conn(fn: Callable[..., T], *args, **kwargs) -> T:
    def _run() -> T:
        conn = db.sync_connect()
        try:
            return fn(conn, *args, **kwargs)
        finally:
            conn.close()
    return await run_in_threadpool(_run)
