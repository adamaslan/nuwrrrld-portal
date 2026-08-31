---
date: 2026-08-30
type: concept
tags: [automation, signals, ai-council, backtest, cron, tracking, eval, benchmark, llm-as-judge]
sources: [../tickers-followed.md, ../../.github/workflows/select-followed-tickers.yml, ../../.github/workflows/track-followed-tickers.yml, ../../app/api/signals/top/route.ts, ../../lib/council-verdict.ts, ../../lib/council-validate.ts, ../../lib/track-record.ts, ../../lib/db/schema.sql, ./decision-afternoon-pipeline-cron-split.md, ./entity-ai-council.md, ./entity-backtest-engine.md]
---

# Concept: Followed-Tickers Tracking (the monthly bear/bull cohort as a benchmark)

A standing, self-selecting list of the 20 tickers the app feels most strongly
about — **10 most bearish, 10 most bullish** — refreshed monthly from the
product's own signal ranking and scored every trading day through the three
analysis features it already has: [[entity-backtest-engine]] hit-rates, the
live signal card, and an [[entity-ai-council]] verdict.

Because each pick is **frozen** at selection, the cohort doubles as the
product's own **benchmark and eval harness**: every pick is a scoreable
prediction resolved across seven horizons against realized prices, with the
council's reasoning graded separately by an outcome-blind LLM judge.

The human-readable face is `docs/tickers-followed.md`. This page is the *why*.

## The pattern

**Freeze the app's loudest calls, then check them against reality.**

Once a month a *selection* run reads `/api/signals/top?universe=all&limit=200`
(the same ranked universe the dashboard signal list is built from), splits the
cards by direction, takes the top 10 by strength from each side, and writes
those 20 tickers into `docs/tickers-followed.md` as that month's cohort. The
cohort is then **held for the month even if the ranking moves under it**.

Every trading day, a *tracking* run puts each of the 20 through three features
and appends the readings:

| Feature | Endpoint (route not built yet) | Contributes |
|---|---|---|
| Backtest | `GET /api/backtest/{symbol}` | historical hit-rate for the firing signal category; 204 → column reads `—` |
| Signal | the ranked card, re-pulled daily | today's direction + strength, and whether it still matches the pick |
| AI council | `POST /api/pipeline/followed-tickers` → one grounded seat/ticker | `bullish`/`bearish`/`neutral` + confidence + a one-line invalidation note |

The interesting question — *did the call play out?* — is only answerable if
the call stays fixed long enough to be wrong. A rolling watchlist that
re-picks daily hides every miss: the moment a ticker stops topping the
ranking it silently drops off. So a bull that flips bearish on day 9 stays in
the table, flagged `thesis holding? → no`, still accruing daily readings. That
row is the point, not an error to prune — the same reasoning as
[[concept-three-state-signal]], where a measured-negative outcome carries
information that collapsing or dropping it destroys.

## The cohort is a benchmark, not a watchlist

Freezing turns each pick into a **standing prediction** — timestamp,
direction, entry price, stated invalidation — which is the shape of a
benchmark item. That makes the cohort scoreable, and `docs/tickers-followed.md`
specifies the eval harness built on it.

**Seven horizons** resolve independently off the same frozen entry: `d1`,
`w1`, `m1`, `m3`, `m6`, `ytd`, `y1`. Early ones are readable within days; `y1`
is not meaningfully readable until ~2027-09. Each is scored with a
**horizon-scaled dead band** (0.5% at `d1` up to 8% at `y1`) into
`hit`/`miss`/`flat`/`void` — a fixed band would make long horizons look far
more accurate than they are, since any drift eventually clears a small
threshold. Rates under **n=30** are published as `n<30 — insufficient`, never
as a percentage.

**Two axes, never blended.** Outcome accuracy is arithmetic against realized
prices. Reasoning quality is graded separately by an **LLM judge** over a
five-criterion rubric (grounding, falsifiability, internal consistency,
specificity, calibration language). The judge is outcome-blind, runs a
different model than the seat that authored the verdict, and only ever sees
verdicts that the deterministic validators in `lib/council-validate.ts` have
already passed — an LLM asked to check arithmetic is slower, costlier, and
worse at it than the existing regex cross-check.

Blending the two would reward the harness's most dangerous quadrant: a call
that was **right for no articulable reason**. Over short horizons outcomes are
mostly noise, so an ungrounded verdict is right about half the time by
construction; a single blended score cannot distinguish that from a sound
process, and optimizing it selects for exactly the wrong thing.

Every rate is also reported against four baselines — coin flip, always-long,
buy-and-hold SPY, and the [[entity-backtest-engine]] prior. The last is the
most valuable: a large gap between the backtest's claimed hit-rate and the
live one means the backtest is overfit, which is a more actionable finding
than any hit-rate on its own.

Markdown is the *rendering*; three tables (`followed_ticker_picks`,
`followed_ticker_observations`, `followed_ticker_scores`) are the store. A
scoring run that had to parse markdown to find its previous state would
eventually corrupt it.

The workflows copy [[decision-afternoon-pipeline-cron-split]] wholesale:
market-hours gate on the real NY wall clock, `workflow_dispatch` with
`dry_run`, secret verification before any call, `concurrency` guard, step
summary, artifact upload, failure-issue notification. `select` and `track`
shipped **ahead of their routes**; as of PR #88 **all three routes exist** —
`/api/pipeline/followed-tickers-select` (monthly), `/api/pipeline/followed-tickers`
(daily observer + horizon resolution), and `/api/pipeline/followed-tickers-judge`
(weekly, gold-gated, `judge-followed-tickers.yml`). They gate on `CRON_SECRET`.
Until `db:migrate` runs against prod the routes degrade to empty results rather
than erroring. The outcome math (`lib/eval-scoring.ts`) and judge rubric
(`lib/eval-judge.ts`) are pure and unit-tested; the doc's marker-delimited
sections are rewritten by `lib/followed-tickers-render.ts`. Two bugs from that
decision doc are pre-empted:
route paths namespaced under `/api/pipeline/` (no existing occupant, so a
misconfig 404s loudly instead of silently 401ing against a working endpoint),
and the daily job's EST+EDT cron pair gated on NY wall-clock hour so the
off-season entry is a no-op, not a duplicate live run an hour apart.

## Where it appears

- `docs/tickers-followed.md` — the tracked cohort, its history, and the
  maintenance contract.
- `.github/workflows/select-followed-tickers.yml` — monthly cohort selection
  (`0 14 1 * *`).
- `.github/workflows/track-followed-tickers.yml` — daily scoring
  (`30 20 * * 1-5` EST / `30 19 * * 1-5` EDT, 15 min after
  `afternoon-pipeline.yml`).
- `app/api/signals/top/route.ts` — the ranked universe the selection reads;
  `topCards()` in `lib/ticker-cards-db.ts` behind it.
- `lib/council-verdict.ts` / `lib/council-validate.ts` — the four-field
  structured verdict the judge grades, and the deterministic pre-filter that
  runs before it.
- `lib/track-record.ts` — the existing *backward*-looking aggregate over
  `backtest_hit_rates`; the scoreboard is its forward-looking counterpart.
- `app/api/pipeline/followed-tickers-select/route.ts`,
  `app/api/pipeline/followed-tickers/route.ts`,
  `app/api/pipeline/followed-tickers-judge/route.ts` — the three routes (PR #88).
- `lib/eval-scoring.ts` — pure outcome math (dead-band, n<30 suppression,
  baselines, `daysHeld`); `lib/eval-judge.ts` — rubric + gold-set gate;
  `lib/followed-tickers-db.ts` / `lib/followed-tickers-render.ts` — store access
  and the doc-section rewriter; `lib/shared/followed-tickers-policy.ts` — pure
  cohort selection.
- `__tests__/fixtures/followed-tickers-gold-set.json` — the judge's anchor set.
- `docs/ship-to-clients-top-25.md` item #14 — the same council explain-quality
  output this cohort exercises daily.

## Contradictions / tensions

> ❓ Open question: the `select` workflow needs `contents: write` to commit the
> refreshed cohort table. Whether the route edits `docs/tickers-followed.md`
> in a repo checkout or returns the tables for the workflow to apply is
> unresolved until the route PR.

> ❓ Open question: `gcp3-mobile` has no equivalent of this cohort. Whether it
> should surface there is a [[concept-sync-requirements]] item, not decided —
> the doc and workflows are portal-only for now.

> ⚠️ Tension: the daily council call is free-tier only
> ([[concept-free-tier-resilience]]) and shares OpenRouter's account-wide
> quota with interactive Nu AI chat and the nightly precompute. A 20-ticker
> cohort adds 20 grounded calls to that bucket every trading day; if the
> quota is already tight this run will degrade to uniform `neutral` verdicts.
> The `track` workflow warns loudly when every verdict comes back `neutral`
> (issue #12's uniform-output class) but does not fail — the backtest and
> signal columns are still real. A dedicated forced-distribution guard, like
> `afternoon-pipeline.yml`'s `council-validate-distribution` step, belongs in
> the route PR.

> ⚠️ Tension: `live_prices` stores **one row per ticker**, overwritten on every
> refresh — there is no price history in the portal DB. Every horizon longer
> than `d1` therefore depends on `followed_ticker_observations` being appended
> without gaps, and a missed tracking run leaves a hole that cannot be
> backfilled from `live_prices`. The daily observation write is the single
> most failure-sensitive step in the harness, and it needs its own
> missed-run alarm rather than relying on the workflow's failure-issue path.

> ⚠️ Tension: the judge's gold set (~20 hand-scored verdicts) is irreducibly
> manual — it cannot be generated by the model under evaluation without
> defeating its purpose. Until it exists, judge-integrity rule 5 (abort below
> 80% agreement) is unenforceable, which means the judge column would be
> unfalsifiable if published early. The free-tier model chain
> ([[concept-free-tier-resilience]]) swaps models without notice, so this is
> not a hypothetical drift risk.

> ❓ Open question: whether any of the scoreboard becomes user-facing. The
> `n<30` suppression and baseline-relative reporting exist so that it *could*
> be, but a published hit-rate carries compliance weight
> ([[entity-disclaimer-system]]) and that is a product decision, not a default.

## See also

- [[decision-afternoon-pipeline-cron-split]] — the workflow pattern these two
  jobs copy and the bugs they avoid
- [[entity-ai-council]] — the grounded per-ticker verdict call
- [[entity-backtest-engine]] — the separate signals-app backtest backend,
  disabled by default (`SIGNALS_ENGINE_URL`)
- [[entity-ticker-universe-pipeline]] — how `/api/signals/top`'s ranking is
  built
- [[concept-three-state-signal]] — why a flipped thesis is kept, not pruned
- [[concept-graceful-degradation]] — every dependency degrades to honest-lesser
- [[concept-global-automation-layer]] — the broader scheduler posture
