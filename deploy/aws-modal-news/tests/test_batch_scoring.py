"""batch_scoring is opt-in. Baselines compare against the ARCHIVED 355e58a news_core, not against itself."""
import importlib.util
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import news_core as nc  # noqa: E402

_spec = importlib.util.spec_from_file_location("news_core_355e58a", Path(__file__).parent / "archive" / "news_core_355e58a.py")
old = importlib.util.module_from_spec(_spec)
sys.modules["news_core_355e58a"] = old
_spec.loader.exec_module(old)


def _minutes(start, end):
    t = start
    while t < end:
        yield t
        t += timedelta(minutes=1)


def _year():
    return _minutes(datetime(2026, 1, 1, 5, tzinfo=timezone.utc), datetime(2027, 1, 1, 5, tzinfo=timezone.utc))


def test_archived_baseline_is_really_old_signature():
    import inspect
    assert "batch_scoring" not in inspect.signature(old.due_jobs).parameters


def test_default_equals_archived_old_function_all_2026():
    for t in _year():
        assert nc.due_jobs(t) == old.due_jobs(t)
        assert nc.due_jobs(t, batch_scoring=False) == old.due_jobs(t)


def test_batch_only_adds_score_backlog_vs_archived_old():
    added = 0
    for t in _year():
        base, batch = old.due_jobs(t), nc.due_jobs(t, batch_scoring=True)
        assert [j for j in batch if j != nc.JOB_SCORE_BACKLOG] == [j for j in base if j != nc.JOB_SCORE_BACKLOG]
        if batch != base:
            added += 1
            assert batch.count(nc.JOB_SCORE_BACKLOG) == 1 and nc.JOB_SCORE_BACKLOG not in base
    assert added > 0


def test_batch_slots_are_weekday_ingest_window_only():
    ny = nc.NEW_YORK
    assert nc.JOB_SCORE_BACKLOG not in nc.due_jobs(datetime(2026, 11, 14, 10, 5, tzinfo=ny), batch_scoring=True)
    assert nc.JOB_SCORE_BACKLOG not in nc.due_jobs(datetime(2026, 11, 16, 6, 35, tzinfo=ny), batch_scoring=True)
    assert nc.JOB_SCORE_BACKLOG in nc.due_jobs(datetime(2026, 11, 16, 10, 35, tzinfo=ny), batch_scoring=True)


def test_scoring_pass_before_preview_and_between_finals():
    ny = nc.NEW_YORK
    mon = lambda h, m: datetime(2026, 11, 16, h, m, tzinfo=ny)
    assert nc.JOB_SCORE_BACKLOG in nc.due_jobs(mon(9, 15), batch_scoring=True)   # before 09:20 preview
    assert nc.JOB_AGGREGATE_PREVIEW in nc.due_jobs(mon(9, 20), batch_scoring=True)
    assert nc.JOB_SCORE_BACKLOG in nc.due_jobs(mon(16, 15), batch_scoring=True)  # between 16:05 and 16:25 finals
    assert nc.JOB_AGGREGATE_FINAL in nc.due_jobs(mon(16, 5), batch_scoring=True)
    assert nc.JOB_AGGREGATE_FINAL in nc.due_jobs(mon(16, 25), batch_scoring=True)


def _old_final_writes(done, unscored):
    """Archived behavior in modal_app._aggregate: skip only if a final exists; otherwise write regardless of unscored."""
    return not done


def _new_final_writes(done, unscored, batch):
    if done:
        return False
    return not nc.final_deferred_for_unscored(unscored, preview=False, force=False, batch_scoring=batch)


def test_delayed_scoring_regression_16_05_then_16_25():
    # 16:05 final runs while the batch scoring dispatched in the same minute has not finished (unscored=40);
    # by 16:25 scoring is complete (unscored=0).
    # FAILURE BEFORE: with batching on and no guard, the 16:05 final is written with 40 unscored; the 16:25 retry then skips.
    done = False
    wrote_1605 = _old_final_writes(done, 40)
    done = done or wrote_1605
    assert wrote_1605 and not _old_final_writes(done, 0)          # stale final is permanent
    # FIX AFTER: 16:05 defers, 16:25 writes with full scores.
    done = False
    assert not _new_final_writes(done, 40, True)
    assert _new_final_writes(done, 0, True)


def test_guard_off_by_default_and_never_blocks_preview_or_force():
    assert not nc.final_deferred_for_unscored(40, False, False, False)
    assert not nc.final_deferred_for_unscored(40, True, False, True)
    assert not nc.final_deferred_for_unscored(40, False, True, True)
    assert not nc.final_deferred_for_unscored(0, False, False, True)
    assert nc.final_deferred_for_unscored(1, False, False, True)
