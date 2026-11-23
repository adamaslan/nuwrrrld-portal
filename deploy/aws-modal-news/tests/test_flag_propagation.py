"""tick is the only dispatch decision point; dispatch_status only reports the deployed flag."""
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
    reads = [n for n in ast.walk(tree) if isinstance(n, ast.Call)
             and isinstance(n.func, ast.Attribute) and n.func.attr == "get"
             and isinstance(n.func.value, ast.Attribute) and n.func.value.attr == "environ"
             and n.args and isinstance(n.args[0], ast.Constant) and n.args[0].value == "NEWS_BATCH_SCORING"]
    assert len(reads) == 2  # one dispatch read and one read-only status report
    tick = next(f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == "tick")
    status = next(f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == "dispatch_status")
    assert sum(any(n is read for n in ast.walk(function)) for read in reads for function in (tick, status)) == 2


def test_dispatch_defaults_off_and_requires_explicit_deploy_opt_in():
    disabled = modal_app._dispatch_env({})
    enabled = modal_app._dispatch_env({"NWF5_DISPATCH_ENABLED": "1", "NEWS_BATCH_SCORING": "1"})
    assert disabled == {"NWF5_DISPATCH_ENABLED": "0", "NEWS_BATCH_SCORING": "0"}
    assert enabled == {"NWF5_DISPATCH_ENABLED": "1", "NEWS_BATCH_SCORING": "1"}
    assert modal_app._dispatch_schedule(disabled) is None
    assert modal_app._dispatch_schedule(enabled) is not None


def test_deploy_opt_in_sets_image_environment_and_single_minute_schedule():
    tree = ast.parse(SRC)
    tick = next(f for f in ast.walk(tree) if isinstance(f, ast.FunctionDef) and f.name == "tick")
    decorator = tick.decorator_list[0]
    schedule = next(k.value for k in decorator.keywords if k.arg == "schedule")
    assert isinstance(schedule, ast.Name) and schedule.id == "DISPATCH_SCHEDULE"
    schedule_assignment = next(n for n in tree.body if isinstance(n, ast.Assign)
                               and any(isinstance(t, ast.Name) and t.id == "DISPATCH_SCHEDULE" for t in n.targets))
    assert isinstance(schedule_assignment.value, ast.Call)
    assert isinstance(schedule_assignment.value.func, ast.Name)
    assert schedule_assignment.value.func.id == "_dispatch_schedule"
    image = next(n for n in tree.body if isinstance(n, ast.Assign)
                 and any(isinstance(t, ast.Name) and t.id == "image" for t in n.targets))
    assert any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "env"
               and isinstance(n.args[0], ast.Name) and n.args[0].id == "DISPATCH_ENV"
               for n in ast.walk(image.value))


def _run_tick(monkeypatch, env, when):
    calls = []
    rec = lambda name: types.SimpleNamespace(spawn=lambda *a, **k: calls.append((name, a)))
    for n in ("news_ingest", "news_corroborate", "news_aggregate", "news_label_outcomes", "news_accuracy_eval",
              "alpaca_live_poller", "news_score_articles"):
        monkeypatch.setattr(modal_app, n, rec(n))
    monkeypatch.setattr(modal_app, "_utcnow", lambda: when)
    monkeypatch.setenv("NWF5_DISPATCH_ENABLED", "1")
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


def test_batch_flag_adds_score_job_and_passes_batch_args(monkeypatch):
    from zoneinfo import ZoneInfo
    when = datetime(2026, 11, 16, 9, 15, tzinfo=ZoneInfo("America/New_York"))
    due, calls = _run_tick(monkeypatch, "1", when)
    assert nc.JOB_SCORE_BACKLOG in due
    assert ("news_score_articles", (None, True)) in calls
