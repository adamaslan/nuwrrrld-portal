---
date: 2026-07-24
type: entity
tags: [cache, neon, holdfold, watchlist, cold-start, audit-2026-07-15]
sources: [../../lib/holdfold-cache-db.ts, ../../lib/watchlist-store.ts, ../../lib/digest-cache-db.ts, ../../lib/db/schema.sql]
---

# Entity — Hold/Fold Cache & Watchlist Store

## What it is

The Neon-backed persistence layer that replaced the portal's in-memory
module-level state after the **2026-07-15 production-readiness audit** (PR #34).
Two sibling stores, same `@/lib/db` connection, opposite failure policies:

- **`lib/holdfold-cache-db.ts`** — an L2 cache for Hold/Fold payloads
  (`holdfold_cache`, 15-min TTL). Every function is `try/catch`-guarded: a DB
  outage or un-migrated table degrades to a live re-fetch, never a hard failure.
  Mirrors `lib/digest-cache-db.ts`. This is a **cache** → silent degradation.
- **`lib/watchlist-store.ts`** — primary user data (`watchlist_items`,
  `(user_id, ticker)` unique). Here errors **propagate** as 503 rather than
  degrade — losing a cached digest is fine; silently dropping a user's saved
  ticker is not. `addToWatchlist` returns the `"exists"` sentinel on duplicate.

The distinction — *cache degrades, user-data propagates* — is the load-bearing
idea; see [[concept-cache-then-degrade]].

## Where used

- `app/api/holdfold/route.ts` — reads L2 before hitting the backend, writes L2
  after a successful fetch. In front sits a per-instance in-memory L1.
- `app/api/portfolio/watchlist` — CRUD over `watchlist-store`.
- `app/dashboard/portfolio/*` — renders the watchlist ([[entity-portfolio-intelligence]]).

**2026-08-11 addition — a third sibling table, `analyze_cache`
(`lib/analyze-cache-db.ts`):** same Neon connection, same try/catch-guarded
degrade-to-null shape as `holdfold_cache`, but keyed on
`(symbol, period, asset_type, risk_profile)` rather than one whole-market
payload — it fronts the new per-ticker `POST /api/analyze` route
([[decision-second-analyze-backend]]), which calls a *different* upstream
(`holdemfoldem-api` via `MCP_ANALYZE_URL`) than this cache's `gcp3-backend`.
Position lots are deliberately excluded from the cache key: P&L is computed
from the cached market analysis, not re-fetched per position.

**2026-08-12 fix (PR #56 review pass):** the key's exclusion of position/options
fields meant a personalized response (options strategy, position P&L) could be
cached under the same key a plain request would read — one caller's
position-shaped output leaking to the next caller asking about the same
ticker. `app/api/analyze/route.ts` now calls
`isGenericAnalyzeRequest()` ([[decision-second-analyze-backend]]) and only
reads/writes the cache for requests with no options/position fields at all;
personalized requests always hit the backend fresh. Separately, `cache_key`
gained a `UNIQUE` index and `saveAnalysis` now upserts instead of inserting —
the table previously grew one row per refresh per key forever.

## Known failures

1. **The bug this fixed.** Before the audit, `app/api/holdfold/route.ts` cached
   in a module-level `cached` variable and the watchlist lived in an in-memory
   `Map`. Every deploy/cold start wiped both — the backend got hammered right
   after each deploy and users' watchlists vanished. Neon persistence closed both.
2. **Un-migrated table = permanent cache miss.** If `holdfold_cache` was never
   migrated, reads return `null` forever and every request re-fetches — correct
   but silently un-cached. There is no telemetry that distinguishes "cold cache"
   from "missing table."

## Open questions

- ❓ 15-min TTL is a hardcoded constant, not per-symbol volatility-aware — a
  fast-moving ticker and a sleepy one cache for the same 15 minutes.
- ❓ Should the per-ticker `signal-lookup` path ([[entity-signal-data-plane]])
  share this cache? Today it is uncached.
- ❓ No eviction/compaction on `holdfold_cache` — it is insert-only; old rows
  accumulate.

## See also

- [[entity-signal-data-plane]] — the fetch path this cache fronts
- [[entity-portfolio-intelligence]] — owns the watchlist half of this store
- [[concept-cache-then-degrade]] — the two-policy pattern generalized
- [[concept-graceful-degradation]] — the resilience stance it instantiates
