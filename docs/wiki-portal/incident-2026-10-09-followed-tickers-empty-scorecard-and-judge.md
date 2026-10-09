---
date: 2026-10-09
type: incident
tags: [followed-tickers, benchmark, price, council-grounding, llm-as-judge, silent-failure]
sources: [../../lib/followed-tickers-price.ts, ../../lib/alpaca-daily-bars.ts, ../../lib/council-grounding.ts, ../../lib/followed-tickers-run.ts, ../../scripts/backfill-followed-tickers.ts, ../../app/api/pipeline/followed-tickers/route.ts]
---

# Incident — Scorecard and Judge Tabs Stayed Empty After the Cohort Froze

## Date & severity

**2026-10-09**, five days after the first cohort froze (20 picks, 2026-10-04).
Severity: **silent**. Every daily track run reported success, but the benchmark
held one observation and one score, and the Judge tab had nothing to show.

## What happened

Two independent defects, one per empty tab.

| Tab | Symptom | Cause |
|---|---|---|
| Scoreboard | One observation in five days; most picks never scored | The observer runs about 19:00–20:30 ET. At that hour `live_prices` is stale, IEX prints almost nothing after 16:00 ET, and the nightly `daily_bars` hydration has not yet written the day. Every rung of the price chain missed, so the run recorded `missedObservations` and moved on. A missed day is gone for good, because the next run only looks at its own date |
| Judge | Nothing gradable; the first stored verdict read "no data available" | Council grounding came from the gcp3 `/signals` endpoint, which answers "not found" for every symbol, including large caps. The T1 seat was handed "no grounding data" and wrote a neutral verdict that said so. The judge correctly scores such a verdict near zero, and a score of 1.4/10 over seven of them says nothing about the council |

## Detection

Read-only queries against the production tables (row counts per date, then the
text of the stored verdicts), plus the track run log: every pick showed
`close: null`. The judge's gold-set gate passed at 100% agreement, which ruled
out judge drift and pointed at the inputs.

## Root cause

- **Timing.** The price chain was only correct for hours when some rung can have
  data. The evening run sits in a gap where none can: `live_prices` is stale,
  IEX has no post-close print, and `daily_bars` is written later that night.
- **Dead grounding source.** The council's only signal source was a backend
  endpoint that no longer returns data. The fallback text ("reason from general
  knowledge and say so") made the failure look like a valid, if unhelpful, answer.

## Resolution

- The price chain gained a rung between the Alpaca latest trade and
  `daily_bars`: the Alpaca SIP daily bar for the closed session. It is the
  official close, available right after 16:00 ET, and recorded as
  `alpaca_daily_bar` in `price_source`.
- Council grounding falls back to the stored `ticker_cards` row when the live
  payload is empty, so a seat is grounded on the same data the cohort was
  ranked from.
- The missed days were backfilled from SIP bars by a one-off script (dry run by
  default, additive only, never records an unfinished session), which also
  resolved the `d1` horizon for the cohort. Verdicts attached by the script are
  tagged `backfilled`, because they were generated after the fact and not on the day.

## Impact on design

- Each rung of a price chain needs a check that it can have data at the hour the
  job runs, not only that it is fresh.
- A judge score is only meaningful if the thing judged had inputs. Read a few
  stored verdicts before trusting an aggregate.
- Scores written from a degraded input should be cleared, not kept.

## Open items

- Judge grades written before the grounding fix rate "no data" verdicts and should
  be cleared so the next weekly judge run regrades them.
- The free-tier model chain returned an empty completion for a large share of
  council calls, so verdict coverage on any one run is partial.
- The gcp3 `/signals` endpoint returns "not found" for all symbols, which also
  affects interactive council grounding.

## See also

- [[concept-followed-tickers-tracking]]
- [[decision-exact-offset-and-fresh-price-for-followed-tickers]]
- [[incident-2026-10-04-followed-tickers-never-produced-data]]
