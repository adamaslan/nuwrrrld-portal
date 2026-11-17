"""NEWS_BATCH_SCORING is read in exactly one place: tick. tick passes the value to news_ingest and news_aggregate as an
argument, so the three cannot disagree whatever Secret or image environment each container has (Secret versus image
precedence is not established offline and is not relied on). Offline fake-boundary tests only."""
import ast
import sys
import types
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import modal_app  # noqa: E402
import news_core as nc  # noqa: E402

SRC = (Path(__file__).resolve().parents[1] / "modal_app.py").read_text()
INGEST = datetime(2026, 11, 18, 14, 36, tzinfo=timezone.utc)      # 09:36 ET
PREVIEW = datetime(2026, 11, 18, 14, 20, tzinfo=timezone.utc)     # 09:20 ET
FINAL = datetime(2026, 11, 18, 21, 5, tzinfo=timezone.utc)        # 16:05 ET


def test_environment_is_read_only_in_tick():
    tree = ast.parse(SRC)
    reads = [n for n in ast.walk(tree)
             if isinstance(n, ast.Constant) and n.value == "NEWS_BATCH_SCORING"]
    assert len(reads) == 1
    tick = next(f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == "tick")
    assert any(n is reads[0] for n in ast.walk(tick))


def _run_tick(monkeypatch, env, when):
    calls = []
    rec = lambda name: types.SimpleNamespace(spawn=lambda *a, **k: calls.append((name, a)))
    for n in ("news_ingest", "news_corroborate", "news_aggregate", "news_label_outcomes", "news_accuracy_eval",
              "alpaca_live_poller", "news_score_articles"):
        monkeypatch.setattr(modal_app, n, rec(n))
    monkeypatch.setattr(modal_app, "_utcnow", lambda: when)
    if env is None:
        monkeypatch.delenv("NEWS_BATCH_SCORING", raising=False)
    else:
        monkeypatch.setenv("NEWS_BATCH_SCORING", env)
    return modal_app.tick.local(), calls


def test_tick_hands_the_same_flag_to_ingest_and_aggregate(monkeypatch):
    for env, expect in (("1", True), ("0", False), ("", False), (None, False)):
        _, calls = _run_tick(monkeypatch, env, INGEST)
        ing = [a for n, a in calls if n == "news_ingest"]
        assert ing == [(expect,)], (env, ing)
        for when in (PREVIEW, FINAL):
            _, calls = _run_tick(monkeypatch, env, when)
            agg = [a for n, a in calls if n == "news_aggregate"]
            assert len(agg) == 1 and agg[0][-1] is expect and len(agg[0]) == 4, (env, when, agg)


def test_default_off_dispatch_matches_default_due_jobs(monkeypatch):
    for when in (INGEST, PREVIEW, FINAL):
        due, _ = _run_tick(monkeypatch, None, when)
        assert due == nc.due_jobs(when)
