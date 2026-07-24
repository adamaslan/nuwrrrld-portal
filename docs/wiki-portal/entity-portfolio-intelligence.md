---
date: 2026-07-24
type: entity
tags: [portfolio, watchlist, health-score, optimizer, disclaimer, shared-types]
sources: [../../lib/portfolio.ts, ../../lib/watchlist-store.ts, ../../app/api/portfolio, ../../app/dashboard/portfolio]
---

# Entity — Portfolio Intelligence

## What it is

The portfolio-analysis surface: a health score, optimizer suggestions, and a
watchlist. `lib/portfolio.ts` is the **single-sourced type contract** shared by
app and web (`PortfolioHealth` with a 0–100 `score` + letter `grade`,
`HealthFactor[]`, `OptimizerSuggestion[]`, `WatchlistItem`), plus the pure
`gradeFromScore` mapper and a mandatory `PORTFOLIO_DISCLAIMER`
("informational only… not personalised financial advice").

Routes under `app/api/portfolio/`:

- `health` / `health-ai` — deterministic score vs. an LLM-narrated variant.
- `suggestions` — optimizer suggestions (priority-ranked, each carrying its own
  disclaimer).
- `watchlist` — CRUD over [[entity-holdfold-cache]]'s `watchlist-store`.

Rendered by `app/dashboard/portfolio/PortfolioClient.tsx`.

## Where used

- `app/dashboard/portfolio/*` — the health card, suggestion list, watchlist UI.
- The watchlist is the join point to the rest of the app: a saved ticker is what
  a "cheaply add a stock, then cache and run signals for it" flow would key on
  (see the app-robustness suggestions).

## Known failures

1. ~~Watchlist is not yet a signal trigger.~~ **Closed 2026-07-24.** Adding a
   ticker now enqueues a `pending_signals` row
   ([[decision-pending-signals-queue]]) via `lib/signal-queue.ts`
   (`enqueueSignalRefresh`) alongside the `watchlist_items` insert. An external
   scheduled job drains it through `POST /api/signals/drain`, which upserts a
   fresh per-ticker entry into the new `signal_cache` table
   (`lib/shared/signal-lookup.ts` `saveTickerEntry`). The drain step itself is
   deferred (see decision page) — the portal side of the loop is done.
2. **`health-ai` inherits Council fragility.** The AI-narrated health path
   depends on the free-model chain; when it degrades it should fall back to the
   deterministic `health` score, not error — verify this holds
   ([[concept-graceful-degradation]]).

## Open questions

- ❓ What actually calls `POST /api/signals/drain` on a schedule? Deferred to a
  Modal or Zo cron in `homebase/` (a separate repo) — see
  [[decision-pending-signals-queue]].
- ❓ `alertThreshold` exists on `WatchlistItem` (priceAbove/priceBelow/
  signalFired) but there is no evaluator or notification path wired to it yet.
- ❓ Is the health score computed from real holdings, or from the watchlist as a
  proxy? The type contract is silent on where quantities/cost-basis come from.

## See also

- [[entity-holdfold-cache]] — the Neon store behind the watchlist
- [[entity-signal-data-plane]] — `signal_cache`/`saveTickerEntry` is the drain write path
- [[decision-pending-signals-queue]] — why enqueue-then-drain instead of a synchronous call
- [[entity-backtest-engine]] — the track record a saved ticker could accrue
- [[concept-graceful-degradation]] — the health-ai fallback obligation
- `gcp3-mobile/docs/wiki-mobile/` — the app that shares `lib/portfolio.ts` types
