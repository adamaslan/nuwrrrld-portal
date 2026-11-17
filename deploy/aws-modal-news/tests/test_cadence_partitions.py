"""Proposed replacement for tick's '* * * * *' cron: 4 ET-timezone crons (the weekly refresh is the 5th
on Starter). Offline model, from the exact news_core.due_jobs source and a local cron matcher (NOT Modal's
scheduler): over 2026, incl. both DST changes, every due job minute is covered, no minute is
matched by two crons (no duplicate firing), and per-job counts equal the per-minute tick's.
PROPOSAL ONLY: nothing here declares a Modal schedule, proves Starter quota use, or deploys."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import news_core as nc  # noqa: E402

NY = ZoneInfo("America/New_York")
PARTITION_CRONS = (
    "* 9-16 * * 1-5",              # market hours (incl. 16:xx close/final-aggregate retries): every minute
    "*/2 7-8,17-19 * * 1-5",       # ingest window outside market hours: every 2 min
    "0,30 0-6,20-23 * * 1-5",      # weekday overnight: every 30 min
    "0,30 * * * 0,6",              # weekends: every 30 min (eval slots 10:00/10:30 Sat)
)


def _field(spec, lo, hi):
    out = set()
    for part in spec.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/"); step = int(s)
        if part == "*":
            a, b = lo, hi
        elif "-" in part:
            a, b = map(int, part.split("-"))
        else:
            a = int(part); b = hi if step > 1 else a
        out.update(range(a, b + 1, step))
    return out


def cron_matches(expr, local):
    m, h, dom, mon, dow = expr.split()
    cron_dow = (local.weekday() + 1) % 7  # Mon=1 ... Sun=0
    return (local.minute in _field(m, 0, 59) and local.hour in _field(h, 0, 23) and
            local.day in _field(dom, 1, 31) and local.month in _field(mon, 1, 12) and
            cron_dow in _field(dow, 0, 6))


def _year():
    t = datetime(2026, 1, 1, 5, 0, tzinfo=timezone.utc)
    end = datetime(2027, 1, 1, 5, 0, tzinfo=timezone.utc)
    while t < end:
        yield t
        t += timedelta(minutes=1)


def test_coverage_no_duplicate_firing_and_per_job_parity_over_2026():
    from collections import Counter
    total = fired = 0
    per_min, per_part = Counter(), Counter()
    for t in _year():
        local = t.astimezone(NY)
        matches = [c for c in PARTITION_CRONS if cron_matches(c, local)]
        assert len(matches) <= 1, (t, matches)          # no overlapping crons -> no double firing
        total += 1; fired += bool(matches)
        jobs = nc.due_jobs(t)
        per_min.update(jobs)
        if matches:
            per_part.update(jobs)                        # jobs the partitioned dispatcher would launch
        else:
            assert not jobs, (t, jobs)                   # a due job on an unfired minute = lost job
    assert per_part == per_min and sum(per_min.values()) > 0
    assert fired < total * 0.40


def test_partition_count_is_four_not_a_quota_inventory():
    # Says nothing about the account's total crons; that inventory is unverified.
    assert len(PARTITION_CRONS) == 4
