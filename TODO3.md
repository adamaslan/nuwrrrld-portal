# TODO3 — make the pending_signals loop 50% more robust (beyond TODO2)

Builds on TODO2.md. That pass added retry/dedup/hygiene/read-through-L2. This
one closes the concurrency, backoff, freshness-precision, and observability
gaps that TODO2 explicitly left open (see its "Validated by" and the standing
tensions on `concept-cache-then-degrade`).

| # | Gap TODO2 left | Fix here |
|---|---|---|
| 1 | `claimPendingSignals` = plain SELECT; two concurrent drains double-process a ticker | Atomic claim: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`, rows move `pending → processing` |
| 2 | A stuck `processing` row (crashed drain) is orphaned forever | Lease: claim also re-grabs `processing` rows older than `STALE_LEASE_SECONDS` |
| 3 | Retries requeue instantly and hammer a struggling backend | Exponential backoff: `next_attempt_at` column + pure `backoffSeconds(attempts)`; claim filters `next_attempt_at <= now()` |
| 4 | Flat 15-min cache TTL treats a hot signal and a sleepy one alike | Pure `cacheTtlMinutes(entry)` — actionable/extreme signals expire in 5 min, quiet ones in 30 |
| 5 | `readCachedEntry` returns null for BOTH cold-miss and DB-broken | Discriminated `CacheReadResult` + a `cache_broken` log line (the tension on `concept-cache-then-degrade`) |
| 6 | `GET /drain` reports only a bare pending count | `getQueueStats()` — pending/processing/error counts, oldest-pending-age, error-rate |
| 7 | DB path was `tsc`-only, never exercised (TODO2 "Validated by" gap) | Guarded integration test (dynamic import, runs only when `DATABASE_URL` set) |

Design rule unchanged: caches degrade silently, user data propagates
([[concept-cache-then-degrade]]). All new pure logic lives in
`lib/shared/signal-policy.ts` and is unit-tested.

## Phase 1 — safe concurrent claim + lease
- [x] Schema: `pending_signals` gains `next_attempt_at timestamptz NOT NULL
      DEFAULT now()` and `claimed_at timestamptz`; status vocabulary adds
      `processing` (idempotent `ADD COLUMN IF NOT EXISTS`).
- [x] `claimPendingSignals(limit)` → atomic `UPDATE … FROM (SELECT … FOR UPDATE
      SKIP LOCKED)` that flips rows to `processing` and `RETURNING` them, so two
      drains never grab the same row.
- [x] Claim also reclaims `processing` rows whose `claimed_at` is older than
      `STALE_LEASE_SECONDS` (crash recovery).

## Phase 2 — exponential backoff
- [x] `backoffSeconds(attempts, base, max)` — pure, capped, unit-tested.
- [x] `recordSignalFailure` sets `next_attempt_at = now() + backoff`, clears
      `claimed_at`; `markSignalDone` clears `claimed_at`.

## Phase 3 — volatility-aware cache TTL
- [x] `cacheTtlMinutes(entry)` — pure; actionable (`ai_action` BUY/SELL/STRONG)
      or extreme confluence (≥70 / ≤30) → 5 min; quiet middle (45–55) → 30 min;
      else 15. Unit-tested.
- [x] `fetchTickerEntry` uses `cacheTtlMinutes(cached.payload)` instead of the
      flat `CACHE_TTL_MINUTES` for its freshness check.

## Phase 4 — observability + tests + wiki
- [x] `readCachedEntry` returns `{ outcome: 'hit'|'miss'|'error', entry? }`;
      a `'error'` logs `[signal-cache] cache_broken`.
- [x] `getQueueStats()` + richer `GET /api/signals/drain` healthcheck.
- [x] `__tests__/signal-queue.test.ts` extended with `backoffSeconds` +
      `cacheTtlMinutes` cases.
- [x] `__tests__/signal-queue.integration.test.ts` — guarded, dynamic-import,
      runs only when `DATABASE_URL` is set (closes TODO2's "Validated by" gap).
- [x] Wiki: `decision-pending-signals-queue`, `entity-signal-data-plane`,
      `concept-cache-then-degrade`, `log.md`.
- [x] `tsc --noEmit` + `vitest run` green.

## Still deferred
- External Modal/Zo cron that calls `POST /api/signals/drain` (lives in `homebase/`).
- Live Finnhub WebSocket tier; delta-only "since last bar" candle diffing.
- Running the integration test in CI (needs a Neon-branch `DATABASE_URL` secret).
