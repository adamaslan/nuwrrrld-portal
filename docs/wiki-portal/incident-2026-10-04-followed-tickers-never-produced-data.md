---
date: 2026-10-04
type: incident
tags: [followed-tickers, github-actions, secrets, cron, live-price, benchmark, silent-failure]
sources: [../../.github/workflows/select-followed-tickers.yml, ../../.github/workflows/track-followed-tickers.yml, ../../.github/workflows/judge-followed-tickers.yml, ../../.github/workflows/afternoon-pipeline.yml, ../../app/api/pipeline/followed-tickers/route.ts, ../../app/api/pipeline/followed-tickers-select/route.ts, ../../lib/followed-tickers-db.ts, ../../lib/live-price-db.ts]
---

# Incident — The Followed-Tickers Benchmark Never Produced Data

## Date & severity

**2026-10-04**, found by reading the production tables and workflow run logs
while preparing the first monthly cohort. Severity: **silent**. The feature was
deployed and every workflow reported green, but no row had ever been written
to the benchmark tables beyond manual test runs.

## What happened

The [[concept-followed-tickers-tracking]] pipeline has three layers: a monthly
selection, a daily observer, and a weekly judge. As of 2026-10-04 all three were
dead, for different reasons, and none of them failed loudly:

| Layer | Symptom | Cause |
|---|---|---|
| Monthly select (Sep 1, Oct 1) | Workflow failed; the route was never reached | The "verify secrets" step ran `gh secret list` with the default `GITHUB_TOKEN`, which can't read the secrets API (HTTP 403). The same precheck sat in the judge and track workflows |
| Daily track | Workflow green; the job was `skipped` | The gate only allowed NY hour 15. GitHub's cron fires late (about 19:00 ET), so the gate skipped every day and still reported success |
| Entry prices | Selection would have frozen about 3 picks, not 20 | Entry and daily close came only from `live_prices`, which holds about 176 paper-watchlist tickers. Unpriced picks were skipped silently |

Three latent defects would have corrupted the data once the pipeline ran:

- **Horizons exited on the latest close, not the due date.** After any missed
  day, a horizon resolved at a later price than its label said.
- **The thesis-flip count was always 0.** The workflow read a snake_case key;
  the route emits camelCase.
- **Resolved picks were re-judged daily.** The "still live" query never filtered
  out finished picks, so council calls would have grown by 20 each month.

Selection also never wrote a row to the pipeline run log, so the console could
not show failed or skipped selection attempts at all.

## Detection

Found by a read-only check, not by any alert: the production table counts were
zero, and the latest run log rows for the followed-tickers pipelines were from
manual runs weeks earlier. The workflows' green status was misleading in two
ways: a skipped job reports success, and a precheck that fails before the route
is called still fails the workflow, but only with a message the reader has to
decode.

## Resolution

Fixed in the unblock-and-correctness PR (branch `fix/followed-tickers-unblock`):

- Secret prechecks now test the values the job receives (`env:` plus `[ -n ... ]`),
  not the secrets API. The same fix applies to the judge and afternoon workflows.
- The track window accepts 15:00–23:59 ET. A second fire the same day is a no-op
  for council calls: the observer skips picks already observed on that NY date.
- The flip check reads `thesisHolding`.
- Entry and daily-close prices follow the fallback chain
  (`live_prices` → Alpaca latest trade → `daily_bars`), with a freshness bound
  and a `price_source` column on picks and observations. See
  [[decision-exact-offset-and-fresh-price-for-followed-tickers]].
- Horizons exit on their trading-day offset. A missing due close voids the
  horizon.
- Resolved picks (`y1` scored) drop out of the daily council loop.
- Selection writes to the pipeline run log, including dry runs and skips.

## Still open (human action, not code)

- The Alpaca rung needs `ALPACA_API_KEY` and `ALPACA_API_SECRET` in the
  production deployment environment. As of this writing they are present in
  `.env.local` but not in production, so on the deployed route the chain
  falls through to `daily_bars`. The fallback is recorded in `price_source`, so
  it is visible in the data.
- The first cohort freeze and first forced observation are one-way production
  writes. They wait on the owner's explicit go.

## Lessons

- A green workflow that skipped its only job is a failure. The gate and the
  status line need to agree.
- Checking a secret through an API that the default token can't read produces
  a false failure that looks like a missing secret. Check the value the job receives.
- A pipeline with no row in its run log is invisible. Log the attempt, including
  the skip.

## Related

- [[concept-followed-tickers-tracking]] — the design this incident broke
- [[entity-live-price-tier]] — the price source that had too little coverage
- [[decision-exact-offset-and-fresh-price-for-followed-tickers]]
