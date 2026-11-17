"""Runs the REAL modal_app._aggregate with a fake database boundary (no DB, no network, no Modal).

FakeDb models committed state (articles with a scored flag) plus a snapshot taken when a transaction opens.
Hooks mutate the committed state between the two scores-table reads to model a scorer commit or a late ingest.
Reads outside a transaction see the latest committed state; reads inside see the snapshot."""
import asyncio
import copy
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import modal_app  # noqa: E402

MON_1605 = datetime(2026, 11, 16, 21, 5, tzinfo=timezone.utc)   # 16:05 ET
MON_1625 = datetime(2026, 11, 16, 21, 25, tzinfo=timezone.utc)
T = datetime(2026, 11, 16, 20, tzinfo=timezone.utc)


def article(i, scored):
    return {"id": i, "scored": scored}


class FakeDb:
    def __init__(self, articles):
        self.live = {a["id"]: dict(a) for a in articles}
        self.final_exists = False
        self.writes = []
        self.reads = []                # (kind, frozenset(article ids visible), frozenset(scored ids visible))
        self.hooks = []                # callables run after each scores-table read
        self.snapshot = None

    def view(self):
        return self.snapshot if self.snapshot is not None else self.live

    def record(self, kind):
        v = self.view()
        self.reads.append((kind, frozenset(v), frozenset(k for k, a in v.items() if a["scored"])))
        if self.hooks:
            self.hooks.pop(0)(self)


class Txn:
    def __init__(self, db): self.db = db
    async def __aenter__(self): self.db.snapshot = copy.deepcopy(self.db.live)
    async def __aexit__(self, *a): self.db.snapshot = None; return False


class Conn:
    def __init__(self, db): self.db = db; self.closed = False
    def transaction(self, **kw):
        assert kw == {"isolation": "repeatable_read", "readonly": True}, kw   # production must request exactly this
        return Txn(self.db)
    async def fetchval(self, sql, *a):
        if "SELECT 1 FROM news_ticker_scores" in sql: return 1 if self.db.final_exists else None
        if "COUNT(*)" in sql:
            n = sum(1 for x in self.db.view().values() if not x["scored"])
            self.db.record("count"); return n
        return None
    async def fetch(self, sql, *a):
        if "news_article_scores e ON" in sql:
            rows = [{"ticker": "AAPL", "article_id": i, "created_at": T, "source": "x", "corroborated": False,
                     "relevance": 1.0, "novelty": 1.0, "story_id": i, "polarity": 0.5, "confidence": 0.9,
                     "event_type": "other"} for i, x in self.db.view().items() if x["scored"]]
            self.db.record("rows"); return rows
        return []
    async def executemany(self, sql, rows): self.db.writes.append(list(rows)); self.db.final_exists = True
    async def close(self): self.closed = True


def run(monkeypatch, db, now, batch):
    io = types.ModuleType("news_io")
    io.DynamoStore = type("S", (), {})
    async def connect(): return Conn(db)
    async def load_universe(c): return {"AAPL": {}}
    async def log_run(*a, **k): pass
    io.connect, io.load_universe, io.log_run = connect, load_universe, log_run
    io.is_trading_day = lambda store, session: True
    monkeypatch.setitem(sys.modules, "news_io", io)
    monkeypatch.setattr(modal_app, "_utcnow", lambda: now)
    monkeypatch.delenv("NEWS_BATCH_SCORING", raising=False)   # aggregate must not read the environment at all
    return asyncio.run(modal_app._aggregate(None, False, False, batch))


def score_all(db):
    for a in db.live.values(): a["scored"] = True


def ingest_late(db):
    db.live[99] = article(99, False)     # backfilled article, created_at <= cutoff, not yet scored


def _same_snapshot(db):
    counts = [r for r in db.reads if r[0] == "count"]
    rows = [r for r in db.reads if r[0] == "rows"]
    return counts and rows and counts[-1][1] == rows[-1][1] and counts[-1][2] == rows[-1][2]


def test_flag_off_is_archived_behavior_stale_final_is_permanent(monkeypatch):
    db = FakeDb([article(1, False)])
    r1 = run(monkeypatch, db, MON_1605, batch=False)
    assert r1["scored"] == 0 and len(db.writes) == 1          # final written with the article unscored
    score_all(db)
    assert "skipped" in run(monkeypatch, db, MON_1625, batch=False)   # retry skips: never repaired


def test_flag_on_defers_then_retry_writes_complete_final(monkeypatch):
    db = FakeDb([article(1, False)])
    assert "deferred" in run(monkeypatch, db, MON_1605, batch=True) and db.writes == []
    score_all(db)
    r = run(monkeypatch, db, MON_1625, batch=True)
    assert r["scored"] == 1 and r["unscored_articles_in_window"] == 0 and len(db.writes) == 1


def test_scorer_commit_between_reads_sees_one_snapshot(monkeypatch):
    db = FakeDb([article(1, False)]); db.hooks = [score_all]      # scorer commits after the first read
    r = run(monkeypatch, db, MON_1605, batch=True)
    assert "deferred" in r and db.writes == []                    # snapshot had 1 unscored: defer, retry later
    assert [k for k, _, _ in db.reads] == ["count"]               # the post-commit state was never mixed in
    # next slot: scores are committed, a fresh snapshot sees them and writes a complete final
    r2 = run(monkeypatch, db, MON_1625, batch=True)
    assert r2["scored"] == 1 and _same_snapshot(db) and len(db.writes) == 1


def test_late_ingest_between_reads_cannot_split_the_count_from_the_rows(monkeypatch):
    db = FakeDb([article(1, True)]); db.hooks = [ingest_late]     # backfill lands after the first read
    r = run(monkeypatch, db, MON_1605, batch=True)
    assert _same_snapshot(db)
    # this final reflects the snapshot only; article 99 arrived after it and is NOT in it (stated limitation)
    assert len(db.writes) == 1 and r["scored"] == 1 and r["unscored_articles_in_window"] == 0
    assert 99 in db.live and 99 not in db.reads[-1][1]


def test_if_still_unscored_at_last_slot_nothing_is_written(monkeypatch):
    db = FakeDb([article(1, False)])
    assert "deferred" in run(monkeypatch, db, MON_1605, batch=True)
    assert "deferred" in run(monkeypatch, db, MON_1625, batch=True)
    assert db.writes == []                                        # known tradeoff
