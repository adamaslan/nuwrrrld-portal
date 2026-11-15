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

## Warning: the track cron does not mean what its comments say

GitHub Actions cron is UTC-only; the `timezone:` key on a schedule entry is
not a GitHub Actions feature and is ignored (the repo itself notes this in
`hydrate-universe.yml`: "GitHub cron is UTC-only with no timezone support").

So the track workflow's single cron `30 16 * * 1-5` fires at 16:30 UTC —
11:30 ET in winter, 12:30 ET in summer. The header comment says "4:30 PM New
York time — post-close backup" and the route header says "GitHub's cron fires
about 7:00 PM ET". Both assume a New York interpretation that does not exist.

Consequence: at 16:30 UTC the market-hours gate compares New York wall time
(11:30/12:30) against the confirmed session close (~16:00 ET) and **skips
every scheduled run**. Daily observations therefore only happen via
`workflow_dispatch` (after close, or with `skip_market_check`). Runtime
confirmation of actual fire behavior is the T-028/T-029 lane.

Fix options (separate change, not this doc): move the cron to a genuinely
post-close UTC hour (e.g. `30 21 * * 1-5` covers both DST halves) or drop the
gate's session-close check if an intraday run is actually desired. The gate
itself is working as designed.

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
