---
date: 2026-07-24
type: decision
tags: [watchlist, queue, signals, cache, serverless-cron]
sources: [../../lib/signal-queue.ts, ../../app/api/signals/drain/route.ts, ../../app/api/portfolio/watchlist/route.ts, ../../lib/db/schema.sql]
---

# Decision — Enqueue-Then-Drain, Not a Synchronous Watchlist-Add Call

## Decision

`POST /api/portfolio/watchlist` does not call the gcp3 backend synchronously
to compute a fresh signal for the newly-added ticker. Instead it writes a row
to `pending_signals` (`lib/signal-queue.ts` `enqueueSignalRefresh`) and
returns immediately. A separate, secret-guarded `POST /api/signals/drain`
endpoint claims pending rows, fetches each via the existing
`fetchTickerEntry` ([[entity-signal-data-plane]]), and upserts into the new
`signal_cache` table. Nothing in this repo calls `/drain` on a schedule yet —
that's an external scheduled job (Modal or Zo cron, living in `homebase/`, a
separate repo) per the serverless-cron pattern discussed for real-time
yfinance/Finnhub ingestion.

## Date

2026-07-24

## Context

Suggestion from the robustness pass: closing the "add stock → cache → run
signals" loop so a freshly-watchlisted ticker gets a signal without the user
manually triggering one. The watchlist route is user-facing and must stay
fast; the gcp3 fetch has an 8 s timeout ([[entity-signal-data-plane]]) that
would make every watchlist-add feel slow if called inline.

## Alternatives considered

- **Synchronous fetch inside the watchlist POST.** Rejected — ties watchlist-add
  latency to gcp3 backend latency/availability, and a backend hiccup would turn
  a simple watchlist write into a 503 for what should be primary user data
  ([[entity-holdfold-cache]] draws the same cache-vs-user-data line).
- **Next.js background task / `waitUntil`.** Rejected for now — still runs
  inside the same serverless function instance and doesn't survive a cold
  start or crash between enqueue and fetch; a durable queue row does.
- **Vercel Cron calling `/drain` directly.** Considered, but the project
  already has a working serverless-cron pattern in `homebase/modal_locrun.py`
  (Modal) and a Zo daily-engine schedule; duplicating a scheduler in Vercel
  adds a third scheduling surface for no benefit. Deferred to whichever of
  Modal/Zo ends up owning it.

## Consequences

- Watchlist-add stays fast and only ever fails for watchlist-store reasons,
  not gcp3 reasons.
- The signal for a newly-added ticker is not instant — it appears whenever the
  next `/drain` call runs. Until an external cron is wired up, `/drain` must be
  triggered manually or via the local `locrun.py` pipeline.
- `signal_cache` becomes a second per-ticker cache alongside `holdfold_cache`
  and `signal_digest_cache` — three caches with overlapping purpose. Worth
  consolidating once the drain path is proven (tracked as an open question on
  [[entity-signal-data-plane]]).

### TODO2 hardening (2026-07-24, same day)

The first cut left several gaps; a follow-up pass closed them:

- **Retry, not permanent death.** A failed fetch used to mark a row `error`
  forever. Now `recordSignalFailure` increments an `attempts` column and
  requeues (`status='pending'`) until `MAX_ATTEMPTS` (3), so a transient gcp3
  blip recovers on the next drain (`shouldRetry`, pure/unit-tested).
- **Dedup.** `enqueueSignalRefresh` inserts `WHERE NOT EXISTS` a live pending
  row, backed by a partial `UNIQUE INDEX … WHERE status='pending'`. N rapid
  adds of the same ticker collapse to one fetch.
- **Hygiene.** `purgePendingSignals(7d)` deletes terminal rows, called
  best-effort at the end of each drain — the "rows accumulate forever" gap is
  closed.
- **Input validation.** `normalizeTicker` (in `lib/shared/signal-policy.ts`)
  guards enqueue, drain, and the watchlist POST — a garbage symbol never costs
  a backend call.
- **Time budget.** The drain loop stops claiming after `TIME_BUDGET_MS` (25 s)
  so 8 tickers × 8 s can't blow the serverless wall clock; the remainder waits
  for the next drain.

### TODO3 hardening (2026-07-24, same day)

A third pass closed the concurrency, backoff, and observability gaps TODO2 left:

- **Safe concurrent claim.** `claimPendingSignals` is now a single atomic
  `UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) RETURNING` that flips rows
  `pending → processing`. Two drains running at once (e.g. an overlapping cron
  and a manual trigger) can no longer double-process a ticker.
- **Lease / crash recovery.** A `processing` row whose `claimed_at` is older
  than `STALE_LEASE_SECONDS` (120 s) is reclaimable — a drain that dies
  mid-flight no longer orphans its rows.
- **Exponential backoff.** `recordSignalFailure` sets `next_attempt_at = now()
  + backoffSeconds(attempts)` (30 s → 60 s → …, capped at 1 h); the claim only
  picks rows whose backoff has elapsed, so a struggling backend isn't hammered.
- **Volatility-aware cache TTL.** `fetchTickerEntry` freshness now uses
  `cacheTtlMinutes(entry)` (hot/actionable → 5 min, quiet → 30) instead of the
  flat 15 min — the per-symbol TTL open question on [[entity-holdfold-cache]].
- **cache-miss vs cache-broken.** `readCachedEntry` returns a discriminated
  `hit | miss | broken`; a `broken` read logs `[signal-cache] cache_broken`,
  finally distinguishing a cold cache from a broken one (the standing tension
  on [[concept-cache-then-degrade]]).
- **Healthcheck.** `GET /api/signals/drain` now returns `getQueueStats()`
  (pending/processing/done/error counts, oldest-pending-age, error-rate).

## Validated by

Pure decision logic (`normalizeTicker`, `isCacheFresh`, `shouldRetry`,
`backoffSeconds`, `cacheTtlMinutes`) is covered by
`__tests__/signal-queue.test.ts` (24 cases, green). The DB-touching path
(enqueue → claim → fail-requeue → stats) now has a **guarded integration test**
(`__tests__/signal-queue.integration.test.ts`) that runs against a real
Postgres when `DATABASE_URL` is set — closing TODO2's gap — and skips
otherwise, so default CI stays green (`tsc --noEmit` clean; 60 passed / 4
skipped). Still not wired to a CI Neon-branch secret, and no external scheduler
calls `/drain` yet (see Open questions on [[entity-portfolio-intelligence]]).

> ✅ **Update (2026-07-24, TODO4):** the external scheduler is no longer
> deferred — `homebase/modal_drain.py` (a Modal cron, `*/5 13-20 * * 1-5`) now
> calls `POST /api/signals/drain` in a loop until the queue drains. See
> [[entity-live-price-tier]]. The queue is end-to-end live; what remains is
> wiring the CI integration test to a Neon-branch secret (workflow shipped in
> `.github/workflows/integration-tests.yml`; needs `NEON_API_KEY` /
> `NEON_PROJECT_ID`).

## See also

- [[entity-live-price-tier]] — the Modal drain cron that schedules this queue + the Finnhub live-price lane
- [[entity-portfolio-intelligence]] — the watchlist this queue serves
- [[entity-signal-data-plane]] — `fetchTickerEntry`/`saveTickerEntry`, the drain payload
- [[entity-holdfold-cache]] — the cache-vs-user-data policy split this decision follows
- [[concept-cache-then-degrade]] — enqueue failure is swallowed (best-effort), unlike the watchlist write itself
