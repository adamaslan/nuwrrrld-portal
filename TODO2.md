# TODO2 — harden the pending_signals loop (75% more robust)

Builds on TODO.md. That pass made the loop *work*; this one makes it *survive*.
Grounded in the real gaps left behind (several of which I flagged as known
failures / open questions on the wiki decision page):

| # | Gap in TODO.md's implementation | Fix here |
|---|---|---|
| 1 | `signal_cache` is **write-only** — the drain writes it, nothing reads it | Make `fetchTickerEntry` a read-through L2: fresh cache → live → stale-on-outage |
| 2 | No input validation — drain fetches any string, wasting a backend call | `normalizeTicker()` pure guard at every entry point |
| 3 | No dedup — one ticker can spawn N pending rows = N redundant fetches | enqueue is `INSERT … WHERE NOT EXISTS (pending)` |
| 4 | No retry — a transient gcp3 blip marks a row `error` **forever** | `attempts` column + `shouldRetry()`; requeue under the cap |
| 5 | No hygiene — `done`/`error` rows accumulate forever | `purgePendingSignals()`, called opportunistically from drain |
| 6 | Drain runs 10 × 8 s serially → up to 80 s, over serverless limits | per-batch time budget + smaller default batch |
| 7 | Zero test coverage on any of the queue logic | `__tests__/signal-queue.test.ts` over the pure helpers |

The design rule stays the same as [[concept-cache-then-degrade]]: **caches
degrade silently, user data propagates.** Every new cache read/write is
try/catch-guarded; the watchlist write is not.

## Phase 1 — `signal_cache` becomes a real read-through L2
- [x] `isCacheFresh(generatedAt, maxAgeMinutes, now)` — pure, testable.
- [x] `getCachedTickerEntry(ticker, maxAgeMinutes)` — guarded read of `signal_cache`.
- [x] Rewire `fetchTickerEntry`: fresh cache hit → return; else live fetch →
      on success warm the cache and return; on live failure → fall back to
      **any-age** cached entry (outage resilience) before returning null.
- [x] Collapses "N council briefs = N backend hits" (open question on
      [[entity-signal-data-plane]]) into "1 hit per TTL window per ticker."

## Phase 2 — ticker validation + enqueue dedup
- [x] `normalizeTicker(input): string | null` — pure; uppercase, trim, reject
      anything but `^[A-Z][A-Z.\-]{0,9}$`. One definition, used everywhere.
- [x] Use it in `enqueueSignalRefresh`, the drain loop, and the watchlist POST.
- [x] `enqueueSignalRefresh` only inserts when no `pending` row for that ticker
      already exists (`WHERE NOT EXISTS`).

## Phase 3 — retry + hygiene
- [x] Schema: `attempts int NOT NULL DEFAULT 0` on `pending_signals`
      (idempotent `ALTER … ADD COLUMN IF NOT EXISTS`).
- [x] `shouldRetry(attempts, maxAttempts)` — pure, testable.
- [x] Drain increments `attempts`; a failed fetch under the cap goes back to
      `pending` (transient blip recovers), at/over the cap becomes `error`.
- [x] `purgePendingSignals(olderThanDays)` — delete terminal rows; called
      best-effort at the end of each drain.

## Phase 4 — tests, observability, wiki
- [x] `__tests__/signal-queue.test.ts` — `normalizeTicker`, `isCacheFresh`,
      `shouldRetry` (pure logic, no DB needed).
- [x] Structured `console.log` summary line on drain (claimed/done/retried/failed).
- [x] Update `entity-signal-data-plane.md` (L2 read closes the open question),
      `decision-pending-signals-queue.md` (retry/dedup/hygiene consequences),
      `concept-cache-then-degrade.md` (signal_cache is now read-through), `log.md`.
- [x] `npx tsc --noEmit` + `npx vitest run` green.

## Still deferred (unchanged from TODO.md)
- External Modal/Zo cron that calls `POST /api/signals/drain` (lives in `homebase/`).
- Live Finnhub WebSocket tier; delta-only "since last bar" candle diffing.
