# TODO — close the "add stock → cache → run signals" loop

Scope: `nuwrrrld-portal` only (Next.js app + Neon). Implements suggestions #1,
#2, #6 (from the wiki robustness pass) as a serverless-cron-friendly queue: the
portal enqueues, an external scheduled job (Modal/Zo cron, out of this repo's
scope) drains it via a secret-guarded endpoint. Delta-only, no new deps.

Grounded in: `lib/watchlist-store.ts`, `lib/holdfold-cache-db.ts`,
`lib/shared/signal-lookup.ts`, `app/api/signals/refresh/route.ts`,
`app/api/portfolio/watchlist/route.ts`, `lib/db/schema.sql`.

## Phase 1 — Schema: `pending_signals` queue table
- [x] Add `pending_signals` table to `lib/db/schema.sql` (ticker, requested_by,
      status: pending/done/error, requested_at, processed_at) — idempotent,
      `IF NOT EXISTS`, matches existing table style.
- [x] Add a `signal_cache` table keyed by ticker (not just the global
      `holdfold_cache` blob) so a single ticker can be upserted without
      rewriting the whole payload — this is what the drain step writes to,
      and what `signal-lookup` can read from as an L2 (open question from
      `entity-signal-data-plane`).

## Phase 2 — Enqueue on watchlist-add
- [x] `lib/signal-queue.ts` — `enqueueSignalRefresh(ticker)` helper (try/catch
      guarded like other cache writes — enqueue failure must never block the
      watchlist add itself).
- [x] Wire into `app/api/portfolio/watchlist/route.ts` POST: after a
      successful `addToWatchlist`, enqueue the ticker.

## Phase 3 — Drain endpoint (what an external cron calls)
- [x] `app/api/signals/drain/route.ts` — `POST`, `Bearer PORTAL_PUSH_SECRET`
      auth (same secret/pattern as `/api/signals/refresh`). Pulls pending
      rows, calls `fetchTickerEntry` per ticker (existing
      `lib/shared/signal-lookup.ts`), upserts into `signal_cache`, marks
      row done/error. Caps batch size so one drain call stays fast.
- [x] `GET` on the same route for a cheap queue-depth healthcheck (mirrors
      the existing `GET` on `/api/signals/refresh`).

## Phase 4 — UI: add-to-watchlist buttons + wiki
- [x] Add a "+ Watchlist" button to `SignalsClient.tsx` cards and the
      `HoldFoldClient.tsx` detail panel, calling
      `POST /api/portfolio/watchlist`.
- [x] Update `docs/wiki-portal/entity-portfolio-intelligence.md` — the
      "watchlist is not yet a signal trigger" known-failure is now closed;
      link the new queue.
- [x] New `docs/wiki-portal/decision-pending-signals-queue.md` — why a queue
      table instead of calling the backend synchronously from the watchlist
      POST (keeps the request fast, lets any scheduler drain it).
- [x] Update `index.md` + `log.md` per the wiki ingest workflow.

## Deferred (out of this repo's scope)
- The actual Modal/Zo cron that calls `/api/signals/drain` on a schedule
  lives in `homebase/` (separate repo, not in this working directory).
- Live Finnhub WebSocket tier, delta-only "since last bar" candle diffing.
