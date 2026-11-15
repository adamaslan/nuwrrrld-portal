# Tracker workflow schedule map (T-142)

End-to-end map of which GitHub Actions workflow calls which pipeline route at
what time for the followed-tickers tracker. Source: workflow files and route
headers on `main` at `aedf972` (2026-11-14).

## The three tracker workflows

| Workflow | Declared schedule | Effective time | Gate | Calls | Route effect |
|---|---|---|---|---|---|
| `select-followed-tickers.yml` | `0 14 1 * *` (UTC) | 1st of month, 09:00 ET (EST) / 10:00 ET (EDT) | none (monthly pick "can slip an hour" per header comment) | `POST /api/pipeline/followed-tickers-select` | Freezes the month's 20-ticker cohort (strongest bulls and bears from the signal universe) |
| `track-followed-tickers.yml` | `30 16 * * 1-5` + `timezone: America/New_York` key | 16:30 UTC = **11:30 ET (EST) / 12:30 ET (EDT)** — see warning below | NYSE-calendar gate (Alpaca): New York weekday, confirmed trading day, NY wall time past confirmed session close | `POST /api/pipeline/followed-tickers` | Daily observer: appends one observation row per live pick (close price, signal direction, backtest hit-rate, grounded council verdict); resolves due horizons into scores; idempotent per day |
| `judge-followed-tickers.yml` | `0 16 * * 6` (UTC) | Saturday 11:00 ET (EST) / 12:00 ET (EDT) | none needed — off-market by day | `POST /api/pipeline/followed-tickers-judge` | Weekly LLM-as-judge: grades a sample of the week's council verdicts against the five-criterion rubric |

Ordering: **select** (monthly, 1st) → **track** (every trading day) → **judge**
(weekly, Saturday, consumes the week's verdicts). Track depends on the cohort
select froze; T-143 covers verifying select runs before tracking each trading
day.

## Warning: the track cron's timing is delay-dependent, not timezone-aware

GitHub Actions cron is UTC-only; the `timezone:` key on a schedule entry is
not a GitHub Actions feature and is ignored (the repo itself notes this in
`hydrate-universe.yml`: "GitHub cron is UTC-only with no timezone support").

Declared: `30 16 * * 1-5` = 16:30 UTC. The workflow comment says "4:30 PM New
York time" and the route header says "GitHub's cron fires about 7:00 PM ET" -
neither matches the declared cron, but the route header matches OBSERVED
behavior.

Observed (Actions run history, checked 2026-11-14): the last 12 scheduled
runs started between 23:5x and 03:4x UTC (18:30-22:30 ET), hours after the
declared 16:30 UTC cron, and ALL passed the market-hours gate and completed
the scoring job. The workflow at an actual run's commit (470bda6) is
identical to current main on the schedule and the gate literal, so the fires
came from this same configuration. Daily observations ARE landing every
trading day.

The mechanism of the hours-long gap between declared and actual start is NOT
proved: GitHub documents that scheduled deliveries can be delayed under load,
and the observed late evening starts are consistent with that, but this map
does not establish the cause. No cron guarantees a deterministic actual fire
time even with the intended hour corrected; the gate, not the cron, is the
correctness mechanism for pre-close fires.

Direct run evidence (all `schedule` events, scoring job `success`):
- 2026-11-14T01:35Z — https://github.com/adamaslan/nuwrrrld-portal/actions/runs/43541498880
- 2026-11-13T02:01Z — https://github.com/adamaslan/nuwrrrld-portal/actions/runs/43349161958
- 2026-11-12T02:23Z — https://github.com/adamaslan/nuwrrrld-portal/actions/runs/43141078652
- 2026-11-11T01:22Z — https://github.com/adamaslan/nuwrrrld-portal/actions/runs/42938463858
- 2026-11-10T03:42Z — https://github.com/adamaslan/nuwrrrld-portal/actions/runs/42751190057
- 2026-11-07T01:03Z — https://github.com/adamaslan/nuwrrrld-portal/actions/runs/42321891929

Full list: https://github.com/adamaslan/nuwrrrld-portal/actions/workflows/track-followed-tickers.yml

Fix (separate change): restore a genuinely post-close UTC cron, e.g.
`30 21 * * 1-5` = 16:30 EST / 17:30 EDT - post-close in both DST halves, and
delivery delays only push later into the evening, never before the close. The
gate's `FIRED_CRON` case literal must be updated in the same change, or it
will reject the new cron as "Unexpected cron entry".

## Related workflows (context, not tracker-owned)

- `afternoon-pipeline.yml` — scheduled execution is paused (`workflow_dispatch`
  only) until its four `/api/pipeline/*` routes ship; orchestrates
  signals-refresh → council-run → theses-score → council-validate-distribution.
- `paper-portfolios.yml` — uses the same inert `timezone:` key pattern with
  ET-labeled comments; its market-gate action decides actual windows.
- `signal-freshness-check.yml` — `0 13 * * 1-5` UTC (08:00–09:00 ET), runs
  `scripts/check-card-freshness.mjs` locally; does not call a pipeline route.

## Sources

- `.github/workflows/select-followed-tickers.yml`
- `.github/workflows/track-followed-tickers.yml`
- `.github/workflows/judge-followed-tickers.yml`
- `.github/workflows/afternoon-pipeline.yml`, `paper-portfolios.yml`,
  `signal-freshness-check.yml`, `hydrate-universe.yml`
- `app/api/pipeline/followed-tickers/route.ts`,
  `app/api/pipeline/followed-tickers-select/route.ts`,
  `app/api/pipeline/followed-tickers-judge/route.ts`
