# Tickers Followed — the monthly bear/bull tracking cohort

**Written:** 2026-08-30
**Scope:** `nuwrrrld-portal` — a standing list of the app's own strongest
directional signals, refreshed monthly and scored daily.

This file is the human-readable face of an automated process. It is **not**
hand-curated. Once a month a selection run reads the app's ranked signal
universe (`/api/signals/top`), takes the **10 most bearish** and **10 most
bullish** tickers, and writes them into the *Current cohort* table below as
that month's followed set. Every trading day after that, a tracking run puts
each of those 20 tickers through the three analysis features the product
already has — **backtest hit-rates, the live signal, and an AI-council
verdict** — and appends the day's readings.

The point is to watch the app's loudest calls play out in the open: if the
signal engine says NVDA is the strongest bull in the universe on the 1st, this
doc records what the backtest, the daily signal, and the council said about it
every day until the next monthly refresh — and whether the call held up.

---

## How the cohort is chosen (monthly)

| Step | Source | Rule |
|---|---|---|
| 1. Rank | `GET /api/signals/top?universe=all&horizon=t1&limit=200` | The ranked ticker-card universe — `topCards()` ordered by signal strength. |
| 2. Split by direction | each card's `category` / verdict sign | Bullish cards in one pile, bearish in the other. Neutral / absent-signal cards are ignored (see [[concept-three-state-signal]] — a measured-negative is a real bear signal, an *absent* one is not). |
| 3. Take the extremes | strength score | Top 10 by strength from each pile → 20 tickers. Ties broken by `bars_scanned` (more history first), then alphabetically. |
| 4. Freeze for the month | this file | The 20 are written to *Current cohort* with `added` = selection date. They do **not** change mid-month even if the ranking shifts — that is the whole experiment. |
| 5. Archive the prior month | *Cohort history* | The outgoing table is moved down with its final readings intact. |

A ticker can be dropped mid-month only if it is **delisted or halted** — noted
inline, not silently removed.

---

## What runs against them (daily)

For each of the 20 tickers, on every trading day:

| Feature | Endpoint | What it contributes |
|---|---|---|
| **Backtest** | `GET /api/backtest/{symbol}` | Historical hit-rate for the signal category currently firing — "when this setup appeared before, it resolved in the signal's direction X% of the time." Returns 204 when the engine is disabled; the row then reads `—`. |
| **Signal** | the ranked card from `/api/signals/top` (already in memory from the selection query, re-pulled daily) | Today's direction + strength for the ticker, and whether it is still on the same side it was picked on. A bull that has flipped bearish is the most interesting row in the table. |
| **AI council** | `POST /api/pipeline/followed-tickers` → one grounded council call per ticker (free-tier models only, see [[concept-free-tier-resilience]]) | A one-line verdict (`bullish` / `bearish` / `neutral` + confidence) and a short comment on what would invalidate the thesis. Grounded on the live signal + the backtest hit-rates, per [[entity-ai-council]]'s grounding contract. |

The daily run writes back into the *Current cohort* table: it updates
`latest signal`, `backtest`, `council`, and flips `thesis holding?` to **no**
the first day a ticker's live signal direction disagrees with its `direction`
column.

---

## Current cohort

**Selection run:** _not yet executed_ — this table is populated by the first
monthly run of `select-followed-tickers.yml` (see *Automation* below). Until
then the rows are the shape the run will fill, not real picks.

### Bulls (10)

| Ticker | Direction | Added | Latest signal | Backtest hit-rate | Council verdict | Council comment | Thesis holding? |
|---|---|---|---|---|---|---|---|
| _pending selection run_ | bull | — | — | — | — | — | — |

### Bears (10)

| Ticker | Direction | Added | Latest signal | Backtest hit-rate | Council verdict | Council comment | Thesis holding? |
|---|---|---|---|---|---|---|---|
| _pending selection run_ | bear | — | — | — | — | — | — |

---

## Cohort history

Prior months' cohorts, moved here on the next monthly refresh with their final
readings. Empty until the second monthly run.

_(none yet)_

---

## Automation

Two workflows, both following the pattern established by
[[decision-afternoon-pipeline-cron-split]] — a market-hours gate,
`workflow_dispatch` with a `dry_run` input, secret verification before any
call, `concurrency` guard, step summary, artifact upload, and a
failure-issue notification.

| Workflow | Schedule | Calls | Job |
|---|---|---|---|
| `.github/workflows/select-followed-tickers.yml` | `0 14 1 * *` — 1st of the month, ~10 AM ET | `POST /api/pipeline/followed-tickers-select` | Ranks the universe, picks 10+10, rewrites *Current cohort*, archives the prior table. |
| `.github/workflows/track-followed-tickers.yml` | `30 20 * * 1-5` — weekdays 3:30 PM ET (after the afternoon pipeline has refreshed signals) | `POST /api/pipeline/followed-tickers` | Runs the 20 through backtest + signal + council, appends the day's readings. |

### Route status — shipped ahead of its endpoints

Exactly as `afternoon-pipeline.yml` was merged before its `/api/pipeline/*`
routes existed ([[decision-afternoon-pipeline-cron-split]]): **the two
workflows in this PR are orchestration only.** The routes they call —
`/api/pipeline/followed-tickers-select` and `/api/pipeline/followed-tickers` —
**do not exist yet.** Both workflows will pass their gate and secret-check
steps and then 404 on the trigger call until a follow-up PR lands the
handlers. This is deliberate: the route work is a separate unit (it touches
`lib/backtest.ts`, the signal-lookup layer, the council-grounding path, and
needs its own route tests), and holding the scheduler infra hostage to it is
the anti-pattern that decision doc calls out.

The route paths are **namespaced under `/api/pipeline/`** — a prefix with no
existing occupant — so a misconfiguration 404s loudly against a route that
isn't built rather than silently 401ing against a working endpoint that does
something else (the `/api/signals/refresh` reuse bug from
[[decision-afternoon-pipeline-cron-split]]).

### Secrets required (already used by `afternoon-pipeline.yml`)

- `PORTAL_URL` — base URL of the deployed portal.
- `CRON_SECRET` — bearer token the scheduled call sends; the future route must
  gate on it, not on `PORTAL_PUSH_SECRET`.

---

## Follow-up work (not in this PR)

1. **`POST /api/pipeline/followed-tickers-select`** — reads `/api/signals/top`,
   splits by direction, takes the extremes, edits this file's *Current cohort*
   section in place (committed by the workflow), moves the old table to
   *Cohort history*.
2. **`POST /api/pipeline/followed-tickers`** — the daily scorer: for each
   ticker in *Current cohort*, `fetchBacktest()`, re-read the ranked card, run
   one grounded council seat, write the four columns back.
3. **Distribution guard** — the same forced-distribution check
   `afternoon-pipeline.yml` runs, so a month of uniform `neutral` council
   verdicts fails loudly (issue #12 regression class).
4. **Mobile parity** — decide whether `gcp3-mobile` surfaces this cohort too
   ([[concept-mobile-web-parity]] / [[concept-sync-requirements]]).

---

## Verification

| Check | Result |
|---|---|
| `select-followed-tickers.yml` YAML parse | _validate before commit_ |
| `track-followed-tickers.yml` YAML parse | _validate before commit_ |
| Routes called exist | **no** — documented above, follow-up PR |
| Ran against live data | **no** — no selection run has executed |

---

## Cross-references

- `docs/wiki-portal/concept-followed-tickers-tracking.md` — the wiki page for
  this process and why it is a monthly-cohort design, not a rolling watchlist.
- `docs/wiki-portal/decision-afternoon-pipeline-cron-split.md` — the workflow
  pattern these two jobs copy, and the two bugs (route reuse, DST double-fire)
  they were written to avoid.
- `docs/wiki-portal/entity-ai-council.md` — the council's grounding contract
  and free-tier model chain.
- `docs/wiki-portal/entity-backtest-engine.md` — the separate signals-app
  backtest backend and its `SIGNALS_ENGINE_URL` disable-by-default posture.
- `app/api/signals/top/route.ts` — the ranked universe the monthly selection
  reads.
- `docs/ship-to-clients-top-25.md` — item #14 (explain-quality gate) is the
  same council output this cohort exercises daily.
