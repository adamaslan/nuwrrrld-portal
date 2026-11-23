"""Batch scoring dispatches a final aggregate once its cutoff window is fully scored."""

import asyncio
import types
from datetime import datetime, timezone

import modal_app
import news_core


class FakeConn:
    def __init__(self, unscored):
        self.unscored = unscored
        self.queries = 0

    async def fetchval(self, sql, *args):
        self.queries += 1
        assert "news_article_scores" in sql
        return self.unscored


def _now(monkeypatch, value):
    monkeypatch.setattr(modal_app, "_utcnow", lambda: value)


def test_no_final_dispatch_before_final_cutoff(monkeypatch):
    _now(monkeypatch, datetime(2026, 11, 17, 20, 0, tzinfo=timezone.utc))  # 15:00 ET
    calls = []
    fake = types.SimpleNamespace(spawn=types.SimpleNamespace(aio=lambda *a: calls.append(a)))
    monkeypatch.setattr(modal_app, "news_aggregate", fake)
    assert asyncio.run(modal_app._maybe_finalize_batch_aggregate(FakeConn(0), news_core)) is False
    assert calls == []


def test_unscored_articles_defer_final_dispatch(monkeypatch):
    _now(monkeypatch, datetime(2026, 11, 17, 21, 35, tzinfo=timezone.utc))  # 16:35 ET
    calls = []
    fake = types.SimpleNamespace(spawn=types.SimpleNamespace(aio=lambda *a: calls.append(a)))
    monkeypatch.setattr(modal_app, "news_aggregate", fake)
    assert asyncio.run(modal_app._maybe_finalize_batch_aggregate(FakeConn(1), news_core)) is False
    assert calls == []


def test_all_scored_batch_dispatches_idempotent_final_retry(monkeypatch):
    _now(monkeypatch, datetime(2026, 11, 17, 21, 35, tzinfo=timezone.utc))  # 16:35 ET
    calls = []
    async def spawn(*args):
        calls.append(args)
    fake = types.SimpleNamespace(spawn=types.SimpleNamespace(aio=spawn))
    monkeypatch.setattr(modal_app, "news_aggregate", fake)
    assert asyncio.run(modal_app._maybe_finalize_batch_aggregate(FakeConn(0), news_core)) is True
    assert calls == [(None, False, False, True)]
