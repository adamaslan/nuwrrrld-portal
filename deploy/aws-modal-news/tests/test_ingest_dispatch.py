"""Regression for the news_ingest -> news_score_articles dispatch.

The _ingest tests run the real modal_app._ingest with a fake news_io and a REPLACED
news_score_articles (a stand-in whose spawn.aio is a stub); they do not exercise the Modal SDK.
Only test_real_sdk_* touches the real SDK Function object, and a fixture blocks all sockets
so no test can reach the network, Modal API, DB or Dynamo.
"""

import asyncio
import sys
import types
import warnings
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import modal  # noqa: E402  - required, never skipped: missing SDK must fail, not silently drop tests
import modal_app  # noqa: E402

TESTED_MODAL_SDK = "1.6.4"  # the version these assertions were verified against


def test_sdk_version_matches_tested_environment():
    assert modal.__version__ == TESTED_MODAL_SDK, f"re-verify SDK tests on modal {modal.__version__}"

CREATED = "2026-11-16T15:00:00Z"
NETWORK_ATTEMPTS = []


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """In-process guard, active only after imports; it does not cover native/grpc sockets.
    Process-level evidence (network namespace + strace) is separate and run-specific."""
    import socket
    monkeypatch.delenv("NEWS_BATCH_SCORING", raising=False)   # tests start in dispatch mode whatever the shell has

    def deny(*a, **k):
        NETWORK_ATTEMPTS.append(1)
        raise AssertionError("network access attempted in an offline test")
    NETWORK_ATTEMPTS.clear()
    monkeypatch.setattr(socket.socket, "connect", deny)
    monkeypatch.setattr(socket.socket, "connect_ex", deny)
    monkeypatch.setattr(socket, "getaddrinfo", deny)
    monkeypatch.setattr(socket, "create_connection", deny)


class FakeConn:
    closed = False

    def transaction(self):
        class _T:
            async def __aenter__(s): return s
            async def __aexit__(s, *a): return False
        return _T()
    async def executemany(self, *a, **k): pass
    async def fetch(self, *a, **k): return []
    async def close(self): self.closed = True


def make_io(events, articles):
    io = types.ModuleType("news_io")
    class Budget(Exception): pass
    io.AlpacaBudgetExhausted = Budget
    class Store:
        def acquire_lock(self, *a): events.append("lock"); return "owner"
        def release_lock(self, *a): events.append("unlock")
        def get_cursor(self, *a): return datetime(2026, 11, 16, tzinfo=timezone.utc)
        def seen_many(self, keys): return set()
        def mark_seen(self, keys): list(keys); events.append("seen")
        def set_cursor(self, *a): events.append("cursor")
    io.DynamoStore = Store
    async def connect():
        io.conn = FakeConn()
        return io.conn
    async def load_universe(conn): return {"AAPL": {"name": "Apple"}}
    async def log_run(conn, name, status, summary, items_total=0): events.append(("log", status, dict(summary)))
    io.connect, io.load_universe, io.log_run = connect, load_universe, log_run
    io.normalize_from_alpaca = lambda s: s
    io.fetch_news_page = lambda store, cursor, token: (articles, None)
    io.parse_iso = lambda v: datetime.fromisoformat(v.replace("Z", "+00:00"))
    return io


def run_ingest(monkeypatch, spawn_aio, articles=None):
    events = []
    arts = [{"id": 1, "symbols": ["AAPL"], "headline": "Apple up", "created_at": CREATED}] if articles is None else articles
    monkeypatch.setitem(sys.modules, "news_io", make_io(events, arts))
    calls = []
    async def aio(ids):
        calls.append(ids); events.append("dispatch")
        return await spawn_aio(ids)
    fake = types.SimpleNamespace(spawn=types.SimpleNamespace(aio=aio))
    monkeypatch.setattr(modal_app, "news_score_articles", fake)
    return asyncio.run(modal_app._ingest()), events, calls


async def _ok(ids): return None
async def _boom(ids): raise RuntimeError("modal unavailable")


def test_dispatch_awaited_once_with_exact_ids(monkeypatch):
    summary, events, calls = run_ingest(monkeypatch, _ok)
    assert calls == [[1]]
    assert events[-1] == "unlock" and events[-2][1] == "ok"


def test_no_dispatch_for_empty_batch(monkeypatch):
    summary, events, calls = run_ingest(monkeypatch, _ok, articles=[])
    assert calls == [] and summary["new"] == 0


def test_dispatch_failure_propagates_and_lock_is_released(monkeypatch):
    """Original error behavior: a failed dispatch still fails the run (no swallowing)."""
    with pytest.raises(RuntimeError, match="modal unavailable"):
        run_ingest(monkeypatch, _boom)


def test_failed_dispatch_state_and_cleanup(monkeypatch):
    events = []
    arts = [{"id": 1, "symbols": ["AAPL"], "headline": "Apple up", "created_at": CREATED}]
    fio = make_io(events, arts)
    monkeypatch.setitem(sys.modules, "news_io", fio)
    async def aio(ids): events.append("dispatch"); raise RuntimeError("modal unavailable")
    monkeypatch.setattr(modal_app, "news_score_articles", types.SimpleNamespace(spawn=types.SimpleNamespace(aio=aio)))
    with pytest.raises(RuntimeError):
        asyncio.run(modal_app._ingest())
    # unchanged semantics: seen/cursor committed before dispatch, run not logged, lock released
    assert events.index("seen") < events.index("cursor") < events.index("dispatch")
    assert not any(isinstance(e, tuple) for e in events) and events[-1] == "unlock"
    assert fio.conn.closed is True


def test_real_sdk_blocking_spawn_in_async_warns_but_aio_does_not():
    """SDK-only check (no _ingest): the old call shape warns, the new one does not.
    Sockets are blocked by the autouse fixture; the app is unbound so the call fails locally."""
    async def old():
        modal_app.news_score_articles.spawn([1])
    async def new():
        await modal_app.news_score_articles.spawn.aio([1])
    def run(coro):
        from modal.exception import ExecutionError
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            with pytest.raises(ExecutionError):  # expected local failure: app is unbound
                asyncio.run(coro())
        return [x for x in w if "blocking Modal interface" in str(x.message)]
    assert run(old) and not run(new)
    network_attempted = bool(NETWORK_ATTEMPTS)
    assert network_attempted is False


def test_ingest_does_not_dispatch_scoring_when_batch_mode_on(monkeypatch):
    monkeypatch.setenv("NEWS_BATCH_SCORING", "1")
    summary, events, calls = run_ingest(monkeypatch, _ok)
    assert calls == [] and summary["new"] == 1


def test_ingest_dispatches_when_batch_mode_off(monkeypatch):
    monkeypatch.delenv("NEWS_BATCH_SCORING", raising=False)
    summary, events, calls = run_ingest(monkeypatch, _ok)
    assert calls == [[1]]
