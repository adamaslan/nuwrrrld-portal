"""Scenario-only Modal Starter credit model (NOT an upper bound, NOT accepted) for moving portal GitHub Actions cron jobs to Modal.

Offline arithmetic only. It reads .github/workflows/*.yml (cron lines + timeout-minutes), counts runs
over a 30-day window, and prices each job at its TIMEOUT (a job-level timeout is not a verified ceiling; jobs without one are UNPRICED; matrix expansion, retries and reusable workflows are not priced; real runs are
shorter) with explicit resources. It makes no Modal, GitHub or cloud call.

Prices: modal.com/pricing, read 2026-11-17: CPU $0.0000131 per core-second (min 0.125 core),
memory $0.00000222 per GiB-second, Starter = $30/month free credits. Re-check before relying.
"""
from __future__ import annotations

import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

CPU_PER_CORE_SEC = 0.0000131
MEM_PER_GIB_SEC = 0.00000222
STARTER_MONTHLY_CREDITS = 30.00
MIN_CORES = 0.125
DEFAULT_CORES, DEFAULT_GIB = 0.5, 1.0   # assumption for Node/Python HTTP-orchestration jobs


def _field(spec: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
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


def cron_runs(expr: str, start: datetime, days: int = 30) -> int:
    """Count UTC minutes in [start, start+days) matching a 5-field cron (GitHub cron is UTC)."""
    m, h, dom, mon, dow = expr.split()
    ms, hs, ds, mos, ws = _field(m, 0, 59), _field(h, 0, 23), _field(dom, 1, 31), _field(mon, 1, 12), _field(dow.replace("7", "0"), 0, 6)
    dom_star, dow_star = dom == "*", dow == "*"
    n, t, end = 0, start, start + timedelta(days=days)
    while t < end:
        if t.minute in ms and t.hour in hs and t.month in mos:
            wd = (t.weekday() + 1) % 7
            day_ok = (t.day in ds) if dow_star else ((wd in ws) if dom_star else (t.day in ds or wd in ws))
            n += day_ok
        t += timedelta(minutes=1)
    return n


def job_cost(seconds: float, cores: float = DEFAULT_CORES, gib: float = DEFAULT_GIB) -> float:
    return seconds * (max(cores, MIN_CORES) * CPU_PER_CORE_SEC + gib * MEM_PER_GIB_SEC)


def parse_workflow(path: Path) -> dict:
    """Indentation-based, no YAML library; indent widths are learned from the file (2, 4, 8 spaces all work).
    Per job: job-level timeout-minutes (a step-level one is NOT a job bound), matrix, reusable `uses:`.
    FAILS CLOSED: a file whose `jobs:` section yields no jobs (flow style, tabs, odd structure) is marked
    parse_ok=False and reported as unpriced, never as zero cost."""
    lines = path.read_text().splitlines()
    live = [l for l in lines if not l.lstrip().startswith("#")]   # commented-out schedules are not active
    crons = []
    for l in live:
        mc = re.match(r"\s*-?\s*cron:\s*(?:'([^']*)'|\"([^\"]*)\"|([^#'\"\s][^#]*?))\s*(?:#.*)?$", l)
        if mc:
            crons.append(next(g for g in mc.groups() if g is not None).strip())
        elif re.match(r"\s*-?\s*cron:", l):
            crons.append("<unreadable>")   # present but not understood: reported unsupported, never skipped
    jobs: dict[str, dict] = {}
    body = [(len(l) - len(l.lstrip(" ")), l) for l in lines if l.strip() and not l.lstrip().startswith("#")]
    start = next((i for i, (ind, l) in enumerate(body) if ind == 0 and l.startswith("jobs:")), None)
    parse_ok = start is not None
    if parse_ok:
        section = []
        for ind, l in body[start + 1:]:
            if ind == 0:
                break
            section.append((ind, l))
        if "\t" in "".join(l for _, l in section) or body[start][1].strip() != "jobs:" or not section:
            parse_ok = False
        else:
            job_ind = min(i for i, _ in section)
            # every entry at job level must be a plain block header `name:`; anything else (inline/flow job,
            # list item, anchor) is a structure we do not understand, so the WHOLE file is unparsed
            bad = [l for i, l in section if i == job_ind and not re.fullmatch(r"[A-Za-z0-9_-]+:", l.strip())]
            prop_ind = None
            cur = None
            for ind, l in section:
                if ind == job_ind and l.strip().endswith(":") and not l.strip().startswith("-"):
                    cur = l.strip()[:-1]
                    jobs[cur] = {"timeout_min": None, "matrix": False, "reusable": False, "retry": False}
                    prop_ind = None
                    continue
                if cur is None:
                    continue
                if prop_ind is None and ind > job_ind:
                    prop_ind = ind
                if ind == prop_ind:
                    mt = re.match(r"\s*timeout-minutes:\s*(\d+)\s*$", l)
                    if mt:
                        jobs[cur]["timeout_min"] = int(mt.group(1))
                    if re.match(r"\s*uses:", l):
                        jobs[cur]["reusable"] = True
                if re.search(r"\bmatrix:", l):
                    jobs[cur]["matrix"] = True
                if re.search(r"retry|attempt", l, re.I):
                    jobs[cur]["retry"] = True
            parse_ok = bool(jobs) and not bad
    return {"name": path.stem, "crons": crons, "jobs": jobs, "parse_ok": parse_ok}


def monthly_report(workflows_dir: Path, start: datetime | None = None) -> list[dict]:
    """Scenario only. Priced = scheduled runs x sum of JOB-level timeouts. Unpriced jobs (no job timeout, reusable)
    are listed in `unbounded_jobs`; `flags` lists matrix/retry presence that the arithmetic ignores."""
    start = start or datetime(2026, 11, 1, tzinfo=timezone.utc)
    rows = []
    paths = sorted(list(workflows_dir.glob("*.yml")) + list(workflows_dir.glob("*.yaml")))
    for p in paths:
        w = parse_workflow(p)
        if not w["crons"]:
            continue
        runs, bad_cron = 0, []
        for c in w["crons"]:
            try:
                runs += cron_runs(c, start)
            except (ValueError, IndexError):   # named days/months, malformed: unsupported, not a crash
                bad_cron.append(c)
        priced = [j["timeout_min"] for j in w["jobs"].values() if j["timeout_min"] is not None and not j["reusable"]]
        unb = [n for n, j in w["jobs"].items() if j["timeout_min"] is None or j["reusable"]]
        if not w["parse_ok"]:
            priced, unb = [], ["<UNPARSED: jobs section not understood>"]
        if bad_cron:
            priced, unb = [], [f"<UNSUPPORTED cron: {c}>" for c in bad_cron]
        flags = sorted({k for j in w["jobs"].values() for k in ("matrix", "retry") if j[k]})
        secs = sum(priced) * 60
        rows.append({"name": w["name"], "crons": w["crons"], "runs_30d": runs, "timeout_min": sum(priced),
                     "unbounded_jobs": unb, "flags": flags, "scenario_usd": round(runs * job_cost(secs), 4)})
    return rows


if __name__ == "__main__":
    wd = Path(sys.argv[1] if len(sys.argv) > 1 else ".github/workflows")
    rows = monthly_report(wd)
    for r in sorted(rows, key=lambda r: -r["scenario_usd"]):
        extra = (f" UNPRICED jobs (no job timeout or reusable): {','.join(r['unbounded_jobs'])}" if r["unbounded_jobs"] else "")
        extra += (f" NOT MODELLED: {','.join(r['flags'])}" if r["flags"] else "")
        print(f"{r['name']:28} runs/30d={r['runs_30d']:4} priced_job_timeout_sum={r['timeout_min']:3}m "
              f"scenario=${r['scenario_usd']:.2f}{extra}")
    total = sum(r["scenario_usd"] for r in rows)
    print(f"TOTAL of PRICED jobs only; unpriced jobs add unknown cost; scenario (unverified, not a bound) ${total:.2f} of ${STARTER_MONTHLY_CREDITS:.2f} Starter credits "
          f"({total / STARTER_MONTHLY_CREDITS * 100:.0f}%)")


# ── nwf4 (deploy/aws-modal-news) as currently written ───────────────────────
# 30-day job counts come from news_core.due_jobs over Nov 2026 (see nwf4_job_counts). Timeouts, cpu and
# memory are copied from modal_app.py @app.function decorators at 355e58a; lean jobs use Modal's default
# container (0.125 core, 128 MiB). Runtime per run is NOT known offline: report worst case (timeout)
# and a sensitivity at assumed typical seconds. news_score_articles also fires once per ingest run that
# finds new articles, on a 2 core / 3 GiB container that loads FinBERT.
NWF4_LEAN = {  # job: (timeout_s, cores, gib)
    "tick": (60, 0.125, 0.125), "news_ingest": (300, 0.125, 0.125), "news_corroborate": (300, 0.125, 0.125),
    "news_aggregate": (600, 0.125, 0.125), "news_label_outcomes": (900, 0.125, 0.125),
    "news_accuracy_eval": (900, 0.125, 0.125), "alpaca_live_poller": (90, 0.125, 0.125),
}
NWF4_SCORE = (900, 2.0, 3.0)


def nwf4_job_counts(start: datetime | None = None, days: int = 30) -> dict[str, int]:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "aws-modal-news"))
    import news_core as nc  # noqa: E402
    from collections import Counter
    start = start or datetime(2026, 11, 1, 5, tzinfo=timezone.utc)
    c: Counter = Counter(); t = start; end = start + timedelta(days=days)
    while t < end:
        c["tick"] += 1
        for j in nc.due_jobs(t):
            c[{"news_aggregate_preview": "news_aggregate", "news_aggregate_final": "news_aggregate",
               "news_score_backlog": "news_score_articles"}.get(j, j)] += 1
        t += timedelta(minutes=1)
    return dict(c)


def nwf4_monthly(counts: dict[str, int], score_typical_s: float | None = None, typical_frac: float | None = None,
                 score_per_ingest: bool = True) -> float:
    """typical_frac: fraction of timeout a lean run really uses (None = worst case). score_typical_s likewise."""
    total = 0.0
    for job, (to, cores, gib) in NWF4_LEAN.items():
        secs = to * (typical_frac if typical_frac is not None else 1.0)
        total += counts.get(job, 0) * job_cost(secs, cores, gib)
    # ingest-triggered scoring: assume every ingest run that can see news spawns one scoring run (scenario assumption)
    score_runs = (counts.get("news_ingest", 0) if score_per_ingest else 0) + counts.get("news_score_articles", 0)
    to, cores, gib = NWF4_SCORE
    total += score_runs * job_cost(score_typical_s if score_typical_s is not None else to, cores, gib)
    return total
