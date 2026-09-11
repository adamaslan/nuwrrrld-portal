---
date: 2026-07-24
type: entity
tags: [portfolio, watchlist, health-score, optimizer, disclaimer, shared-types]
sources: [../../lib/portfolio.ts, ../../lib/shared/portfolio-health-policy.ts, ../../lib/portfolio-health-local.ts, ../../lib/watchlist-store.ts, ../../app/api/portfolio, ../../app/dashboard/portfolio]
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
  Since 2026-09-11 `health` prefers gcp3 and falls back to
  `lib/shared/portfolio-health-policy.ts`, a pure scorer over `ticker_cards`
  (signal strength · directional risk · diversification, plus an unscored
  coverage factor). `lib/portfolio-health-local.ts` is the Neon read beside it.
  In practice the local path is the only one that ever runs.
- `suggestions` — optimizer suggestions (priority-ranked, each carrying its own
  disclaimer). Same upstream-then-local shape as `health`.
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
3. ~~**The upstream health endpoint has never existed.**~~ **Worked around
   2026-09-11** — the upstream is still missing and now no longer matters.
   Both `health` and `suggestions` compute from `ticker_cards`
   ([[entity-ticker-universe-pipeline]]) when gcp3 doesn't answer, which in
   practice is always. A 936-ticker watchlist scores live; a watchlist with no
   computed cards returns 503 with its own copy instead of a generic error.
   See [[decision-local-portfolio-scoring-over-upstream-wait]]. **`health-ai`
   is NOT fixed** — it still calls gcp3 directly and still narrates ungrounded
   (failure 2 remains open, and is now open *despite* a real score being
   available to it). Original text, for the record:

   **The upstream health endpoint has never existed.** Both `health` and
   `health-ai` call `{MCP_BACKEND_URL}/api/portfolio/health`, which is not
   registered on gcp3 — the logic sits orphaned in `portfolio_analyzer.py`. The
   score panel shows *"Health score unavailable"*; the AI panel silently
   degrades to an **ungrounded** prompt ("Portfolio health data: unavailable")
   and has been narrating portfolios with no portfolio data behind it since it
   shipped. Mobile's Portfolio tab fails identically via the same route.
   **Confirmed still live 2026-08-18** via direct `curl` against
   `{gcp3-backend-url}/api/portfolio/health?tickers=AAPL,MSFT` → `404`, and
   again through `e2e/frontend/portfolio-liveness.spec.ts` (new, see
   [[concept-live-backend-liveness-tests]]) → `502` from the portal's own
   proxy. `/api/portfolio/suggestions` on gcp3 is **also** 404 as of the same
   check — a second, previously-unconfirmed instance of the same "route never
   registered" pattern, not yet its own incident page since it's the identical
   root cause as this one. **Re-confirmed a fourth time 2026-09-11** against
   the backend's own OpenAPI: ~35 registered paths, no portfolio path among
   them. 47 days from first confirmation to workaround.
4. **The two sides share no field names.** gcp3 emits `ai_grade`/`ai_*`; the
   portal expects `score`/`factors[]`/`summary`. Because the portal coerced a
   missing score to `0`, a naive wiring would silently grade **every user F**
   — worse than an error. `lib/portfolio.ts` is single-sourced across
   portal↔mobile but binds nothing on the gcp3 side of the wire.
   **Client-side half fixed 2026-08-18:** `PortfolioClient.tsx`'s `runScoreCheck`
   previously did an unchecked `res.json() as PortfolioHealth` cast — a
   contract-drift payload (gcp3's `ai_grade`/`ai_insights` shape, no `score`)
   crashed the component outright (`score.factors.length` on `undefined`)
   rather than even reaching the silent-F case. Added `isPortfolioHealth()`
   (`lib/portfolio.ts`), a full-shape runtime validator mirroring
   `lib/backtest.ts`'s `isBacktestResult()` pattern; a payload that fails
   validation now routes to the existing `.port-health-error` state instead of
   crashing OR rendering a fake score. The server route's own defensive
   parsing (item above this one, `route.ts`'s `typeof data.score === 'number'
   ? ... : 0`) is unchanged and still the deeper fix gcp3-side wiring needs.
   **Server-side half closed 2026-09-11:** the route no longer coerces at all.
   A 200 without a finite numeric `score` is treated as a *miss* and falls
   through to the local scorer, so the drifted payload can no longer produce a
   number for the client to have to reject. The two halves now agree: an
   unrecognized shape yields no score from either side.
5. **A locally-computed score is unlabelled on mobile.** The route sets
   `X-Portfolio-Health-Source: upstream|local` and `PortfolioClient.tsx`
   renders the provenance line from it; `gcp3-mobile`'s `lib/usePortfolio.ts`
   does not read the header. Mobile therefore shows a portal-computed score as
   though it came from the documented backend — the honesty half of the
   2026-09-11 fix is web-only. See [[concept-mobile-web-parity]].
6. **Portfolio health now depends on the hydration pipeline, silently.**
   Scoring from `ticker_cards` trades one failure mode for another: a frozen
   universe degrades the score with no error and no age badge. The verified run
   scored a 2026-09-05 bar on 2026-09-11. This is not hypothetical —
   [[incident-2026-09-03-nightly-hydration-dead-15-days]] is exactly this
   pipeline going dark for 15 days. `barDate` reaches the summary text; nothing
   gates or flags on it.
7. **`health-ai` is unmetered.** Unlike `/api/nuai` it has no rate limit and no
   token accounting, so it bypasses `NU_AI_DAILY_TOKEN_BUDGET` entirely.
8. ~~**`.port-watch-empty` reused across three co-rendered empty-states.**~~ —
   **fixed 2026-08-18**, see [[entity-playwright-e2e]] known-failure #5 for
   the full writeup; split into `port-watch-empty` / `port-score-empty` /
   `port-suggestions-empty`.
9. **`health-ai`'s free-model chain can be fully exhausted** — confirmed live
   2026-08-18: `POST /api/portfolio/health-ai` returned `503 "AI unavailable"`
   twice consecutively via `page.request.post` with a real watchlist ticker,
   independent of the gcp3 outage above (this route degrades to an ungrounded
   prompt when gcp3 fails, it doesn't error — the 503 came from
   `fetchWithModelFallbackChecked` failing across every model in
   `FREE_MODEL_CHAIN`). See [[entity-openrouter-client]] for the chain and its
   known quota-exhaustion failure mode; this is that failure mode observed
   from the portfolio surface specifically, not a portfolio-side bug.

## Open questions

- ❓ What actually calls `POST /api/signals/drain` on a schedule? Deferred to a
  Modal or Zo cron in `homebase/` (a separate repo) — see
  [[decision-pending-signals-queue]].
- ❓ **The score's weights are unvalidated.** 0.45 signal / 0.30 direction /
  0.25 diversification, and a ten-name diversification target, are reasoned
  rather than fitted. Nothing checks whether a Grade-B watchlist subsequently
  behaves differently from a Grade-D one — [[entity-backtest-engine]] is where
  that would be measured and is not wired to it.
- ❓ **Diversification does not measure sector.** `ticker_universe` records only
  `etf`/`stock`, so thirty semiconductor names read as well-diversified. The
  factor's own description says so rather than pretending otherwise, which is a
  floor, not a fix.
- ❓ **A ~1000-ticker watchlist is now reachable** via
  `scripts/seed-watchlist-universe.mjs`, which is what surfaced that the panel
  rendered every row on mount (it now filters and windows at 50). Whether a
  full-universe watchlist is a *sensible* user state — as opposed to a
  different feature wearing the watchlist's clothes — is unresolved.
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

- [[decision-local-portfolio-scoring-over-upstream-wait]] — why the score is computed here now
- [[entity-ticker-universe-pipeline]] — `ticker_cards`, the data the local scorer reads
- [[entity-holdfold-cache]] — the Neon store behind the watchlist
- [[entity-signal-data-plane]] — `signal_cache`/`saveTickerEntry` is the drain write path
- [[decision-pending-signals-queue]] — why enqueue-then-drain instead of a synchronous call
- [[entity-backtest-engine]] — the track record a saved ticker could accrue
- [[concept-graceful-degradation]] — the health-ai fallback obligation (unmet; see failure 2)
- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — the missing gcp3 route behind failures 2–4
- [[entity-playwright-e2e]] — `e2e/frontend/portfolio-health.spec.ts` reproduces
  failures 2–4 deterministically via route mocking (contract-drift payload,
  ungrounded-narrative signal, generic-502 collapse), each test naming which
  layer broke instead of the ambiguous shared error string
- [[concept-live-backend-liveness-tests]] — `e2e/frontend/portfolio-liveness.spec.ts`
  (new 2026-08-18) is the unmocked counterpart: real calls confirming
  failures 3 and 7 above are live right now, not just reproducible via mock
- `docs/portfolio-health-ai-workflow.html` — full-stack trace + 11-defect catalogue
- `gcp3-mobile/docs/wiki-mobile/entity-portfolio.md` — the mobile half, broken by the same route
