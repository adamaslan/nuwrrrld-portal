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
2. ~~**`health-ai` inherits Council fragility.** …verify this holds.~~
   **Verified 2026-07-26 — it does not hold, in either direction.** `health-ai`
   does not fall back to the deterministic score when the model chain degrades;
   it surfaces *"Health check returned empty — try again."* And the score it
   would fall back **to** is itself broken (below). See
   [[incident-2026-07-26-portfolio-health-endpoint-missing]].
3. **The upstream health endpoint has never existed.** Both `health` and
   `health-ai` call `{MCP_BACKEND_URL}/api/portfolio/health`, which is not
   registered on gcp3 — the logic sits orphaned in `portfolio_analyzer.py`. The
   score panel shows *"Health score unavailable"*; the AI panel silently
   degrades to an **ungrounded** prompt ("Portfolio health data: unavailable")
   and has been narrating portfolios with no portfolio data behind it since it
   shipped. Mobile's Portfolio tab fails identically via the same route.
4. **The two sides share no field names.** gcp3 emits `ai_grade`/`ai_*`; the
   portal expects `score`/`factors[]`/`summary`. Because the portal coerces a
   missing score to `0`, a naive wiring would silently grade **every user F** —
   worse than the current error. `lib/portfolio.ts` is single-sourced across
   portal↔mobile but binds nothing on the gcp3 side of the wire.
5. **`health-ai` is unmetered.** Unlike `/api/nuai` it has no rate limit and no
   token accounting, so it bypasses `NU_AI_DAILY_TOKEN_BUDGET` entirely.

## Open questions

- ❓ What actually calls `POST /api/signals/drain` on a schedule? Deferred to a
  Modal or Zo cron in `homebase/` (a separate repo) — see
  [[decision-pending-signals-queue]].
- ❓ `alertThreshold` exists on `WatchlistItem` (priceAbove/priceBelow/
  signalFired) but there is no evaluator or notification path wired to it yet.
- ~~❓ Is the health score computed from real holdings, or from the watchlist as
  a proxy?~~ **Answered 2026-07-26: neither.** The portal sends no tickers at
  all, so gcp3's `get_portfolio_analysis()` would fall back to its hardcoded
  10-symbol `DEFAULT_PORTFOLIO`. Once the endpoint exists, users would see a
  stranger's portfolio graded as their own unless the watchlist is passed
  explicitly. Holdings/cost-basis remain unsourced — the analyzer is
  equal-weight and has no quantity concept at all.
- ✅ Both `/api/brief` and `/api/portfolio/health-ai` now have the `Accept`-based
  content negotiation that `interactivity-15.md` §3.1 specified for all three SSE
  routes — matching `/api/nuai`, which had it first.

## See also

- [[entity-holdfold-cache]] — the Neon store behind the watchlist
- [[entity-signal-data-plane]] — `signal_cache`/`saveTickerEntry` is the drain write path
- [[decision-pending-signals-queue]] — why enqueue-then-drain instead of a synchronous call
- [[entity-backtest-engine]] — the track record a saved ticker could accrue
- [[concept-graceful-degradation]] — the health-ai fallback obligation (unmet; see failure 2)
- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — the missing gcp3 route behind failures 2–4
- `docs/portfolio-health-ai-workflow.html` — full-stack trace + 11-defect catalogue
- `gcp3-mobile/docs/wiki-mobile/entity-portfolio.md` — the mobile half, broken by the same route
