---
date: 2026-08-30
type: concept
tags: [automation, signals, ai-council, backtest, cron, tracking]
sources: [../tickers-followed.md, ../../.github/workflows/select-followed-tickers.yml, ../../.github/workflows/track-followed-tickers.yml, ../../app/api/signals/top/route.ts, ./decision-afternoon-pipeline-cron-split.md, ./entity-ai-council.md, ./entity-backtest-engine.md]
---

# Concept: Followed-Tickers Tracking (the monthly bear/bull cohort)

A standing, self-selecting list of the 20 tickers the app feels most strongly
about — **10 most bearish, 10 most bullish** — refreshed monthly from the
product's own signal ranking and scored every trading day through the three
analysis features it already has: [[entity-backtest-engine]] hit-rates, the
live signal card, and an [[entity-ai-council]] verdict.

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

The two workflows copy [[decision-afternoon-pipeline-cron-split]] wholesale:
market-hours gate on the real NY wall clock, `workflow_dispatch` with
`dry_run`, secret verification before any call, `concurrency` guard, step
summary, artifact upload, failure-issue notification. They are **orchestration
shipped ahead of their routes** — `/api/pipeline/followed-tickers-select` and
`/api/pipeline/followed-tickers` do not exist yet; the jobs pass their gate
and secret check, then 404. Two bugs from that decision doc are pre-empted:
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
- Future: `/api/pipeline/followed-tickers-select` and
  `/api/pipeline/followed-tickers` (follow-up PR).
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
