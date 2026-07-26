---
date: 2026-07-24
type: entity
tags: [live-price, finnhub, websocket, modal, real-time, drain, cron]
sources: [../../app/api/signals/live/route.ts, ../../lib/live-price-db.ts, ../../lib/shared/live-price.ts, ../../app/api/signals/drain/route.ts]
---

# Entity — Real-Time Price Tier & Drain Cron

## What it is

The low-latency "quote lane" that fronts the slower signal cache, plus the
external scheduler that finally closes the pending-signals loop. Three pieces,
two of which live in `homebase/` (a separate repo):

- **`POST/GET /api/signals/live`** (this repo) — a `PORTAL_PUSH_SECRET`-guarded
  batch upsert of `{ticker, price, tradedAt, volume?}` into the `live_prices`
  table. Pure validation/latest-per-ticker dedup is `lib/shared/live-price.ts`
  (`parseLivePriceBatch`, unit-tested); the guarded DB writes are
  `lib/live-price-db.ts` (`upsertLivePrices` uses an `unnest` batch upsert with
  a `WHERE EXCLUDED.traded_at >= live_prices.traded_at` guard so an out-of-order
  tick never overwrites a newer one). `GET ?ticker=` reads one last price.
- **`homebase/modal_finnhub_ws.py`** — a persistent Modal container
  (`min_containers=1`) holding one Finnhub trades WebSocket subscription (via the
  existing `FinnhubWsClient`), debouncing the tick firehose to the latest price
  per symbol every 5 s and POSTing the batch to `/api/signals/live`.
- **`homebase/modal_drain.py`** — a lightweight (httpx-only) Modal cron
  (`*/5 13-20 * * 1-5`) that calls `POST /api/signals/drain` in a loop until the
  queue is empty. This is the scheduler [[decision-pending-signals-queue]]
  deferred — the thing that actually turns a watchlist add into a cached signal.

## Where used

- `POST /api/signals/live` ← `modal_finnhub_ws.py`; `POST /api/signals/drain`
  ([[entity-signal-data-plane]] drain) ← `modal_drain.py`.
- `live_prices` is intended to sit in front of `signal_cache` for any surface
  that wants a sub-second quote (not yet wired into a dashboard component).
- `.github/workflows/integration-tests.yml` exercises the drain/queue path
  against an ephemeral Neon branch.

## Known failures

1. **No consumer yet.** `live_prices` is written by the WS tier but no
   dashboard component reads `GET /api/signals/live` — the tier is plumbed end
   to end but not yet surfaced. Same "write-only until wired" shape the
   `signal_cache` L2 had before TODO3.
2. **Single warm container = single point of failure.** `min_containers=1`
   keeps one WS connection; if Modal recycles it mid-session there's a gap until
   the next container subscribes. Acceptable for a best-effort quote lane
   ([[concept-cache-then-degrade]]), not for anything authoritative.
3. **Secrets live in one Modal secret.** Both homebase workers read
   `nuwrrrld-secrets` (`PORTAL_PUSH_SECRET`, `FINNHUB_API_KEY2`,
   `EXPO_PUBLIC_PORTAL_URL`); a rotation must update that secret or both stop.

## Open questions

- ❓ Should `fetchTickerEntry` / the Hold-Fold UI prefer `live_prices` over the
  `signal_cache` price when it's fresher? Today they're independent.
- ❓ The WS symbol set (`DEFAULT_SYMBOLS`) is hardcoded in `modal_finnhub_ws.py`
  rather than derived from actual watchlists — it should subscribe to the union
  of live `watchlist_items` instead.
- ❓ `live_prices` has no TTL/staleness badge; a halted feed shows the last tick
  forever (the freshness-contract gap tracked on [[entity-signal-data-plane]]).

## See also

- [[decision-pending-signals-queue]] — the loop whose scheduler `modal_drain.py` is
- [[entity-signal-data-plane]] — the slower signal cache this fronts
- [[entity-portfolio-intelligence]] — watchlists that should drive the WS symbol set
- [[concept-cache-then-degrade]] — best-effort writes; live price is an enhancement, never a hard dep
- `homebase/modal_finnhub_ws.py`, `homebase/modal_drain.py` — the external workers (separate repo)
