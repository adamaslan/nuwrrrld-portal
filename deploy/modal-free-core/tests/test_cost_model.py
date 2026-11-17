import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cost_model as cm  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
START = datetime(2026, 11, 1, tzinfo=timezone.utc)


def test_job_cost_arithmetic_and_min_core():
    assert abs(cm.job_cost(1000, 1.0, 1.0) - 1000 * (0.0000131 + 0.00000222)) < 1e-12
    assert cm.job_cost(10, 0.01, 0) == cm.job_cost(10, 0.125, 0)   # 0.125-core floor


def test_cron_counts():
    assert cm.cron_runs("0 9 * * 1", START) == 5          # Mondays Nov 2, 9, 16, 23, 30
    assert cm.cron_runs("0 9 * * *", START) == 30
    assert cm.cron_runs("*/30 * * * *", START) == 30 * 48


def test_workflow_model_flags_unbounded_and_ignores_step_timeouts(tmp_path):
    (tmp_path / "a.yml").write_text(
        "on:\n  schedule:\n    - cron: '0 9 * * *'\njobs:\n  one:\n    runs-on: x\n    steps:\n"
        "      - run: y\n        timeout-minutes: 1\n")           # step timeout only: job is UNBOUNDED, not 1 min
    (tmp_path / "b.yaml").write_text(
        "on:\n  schedule:\n    - cron: '0 9 * * *'\njobs:\n  m:\n    timeout-minutes: 5\n    strategy:\n"
        "      matrix:\n        v: [1, 2, 3, 4]\n    steps:\n      - run: y\n")
    rows = {r["name"]: r for r in cm.monthly_report(tmp_path, START)}
    assert rows["a"]["unbounded_jobs"] == ["one"] and rows["a"]["timeout_min"] == 0   # not priced as 1 or 10 min
    assert rows["b"]["timeout_min"] == 5 and "matrix" in rows["b"]["flags"]           # .yaml read; matrix flagged, not x4


def test_repo_workflows_report_has_unpriced_jobs_listed():
    rows = cm.monthly_report(ROOT / ".github" / "workflows", START)
    assert rows
    names_unpriced = {r["name"] for r in rows if r["unbounded_jobs"]}
    assert {"precompute-ai", "sync-corpus"} <= names_unpriced   # no job-level timeout: listed, never priced


def test_nwf4_scoring_dominates_and_batching_cuts_it():
    counts = cm.nwf4_job_counts(START)
    assert counts["tick"] == 43200
    now = cm.nwf4_monthly(counts, score_typical_s=30, typical_frac=0.1)
    # batching: scoring starts only from the half-hourly slots, not from every ingest run
    import news_core as nc
    from datetime import timedelta
    t, n = datetime(2026, 11, 1, 5, tzinfo=timezone.utc), 0
    while t < datetime(2026, 12, 1, 5, tzinfo=timezone.utc):
        n += nc.JOB_SCORE_BACKLOG in nc.due_jobs(t, batch_scoring=True)
        t += timedelta(minutes=1)
    batched = dict(counts, news_score_articles=n)
    after = cm.nwf4_monthly(batched, score_typical_s=30, typical_frac=0.1, score_per_ingest=False)
    assert n < counts["news_ingest"] / 10
    assert after < now


def test_four_space_indent_is_parsed_and_unsupported_structure_fails_closed(tmp_path):
    (tmp_path / "wide.yml").write_text(
        "on:\n    schedule:\n        - cron: '0 9 * * *'\njobs:\n    big:\n        runs-on: x\n        timeout-minutes: 20\n"
        "        steps:\n            - run: y\n")
    (tmp_path / "flow.yml").write_text(
        "on:\n  schedule:\n    - cron: '0 9 * * *'\njobs: {big: {timeout-minutes: 20}}\n")
    rows = {r["name"]: r for r in cm.monthly_report(tmp_path, START)}
    assert rows["wide"]["timeout_min"] == 20 and rows["wide"]["unbounded_jobs"] == []
    assert rows["flow"]["timeout_min"] == 0 and rows["flow"]["unbounded_jobs"] == ["<UNPARSED: jobs section not understood>"]


def test_partial_parse_is_rejected_not_half_priced(tmp_path):
    (tmp_path / "mix.yml").write_text(
        "on:\n  schedule:\n    - cron: '0 9 * * *'\njobs:\n  a:\n    timeout-minutes: 1\n    steps: []\n"
        "  b: {runs-on: x, timeout-minutes: 20}\n")
    r = {x["name"]: x for x in cm.monthly_report(tmp_path, START)}["mix"]
    assert r["timeout_min"] == 0 and r["unbounded_jobs"] == ["<UNPARSED: jobs section not understood>"]


def test_cron_comments_unquoted_and_named_fields(tmp_path):
    job = "jobs:\n  one:\n    runs-on: x\n    timeout-minutes: 10\n    steps:\n      - run: x\n"
    (tmp_path / "a.yml").write_text("on:\n  schedule:\n    # - cron: '* * * * *'\n    - cron: '0 9 * * *'\n" + job)
    (tmp_path / "b.yml").write_text("on:\n  schedule:\n    - cron: 0 9 * * *  # daily\n" + job)
    (tmp_path / "c.yml").write_text("on:\n  schedule:\n    - cron: '0 9 * * MON-FRI'\n" + job)
    rows = {r["name"]: r for r in cm.monthly_report(tmp_path, START)}
    assert rows["a"]["runs_30d"] == 30 and rows["a"]["crons"] == ["0 9 * * *"]
    assert rows["b"]["runs_30d"] == 30
    assert rows["c"]["scenario_usd"] == 0 and rows["c"]["unbounded_jobs"] == ["<UNSUPPORTED cron: 0 9 * * MON-FRI>"]
