---
date: 2026-07-24
type: concept
tags: [cache, resilience, neon, cold-start, failure-policy]
sources: [../../lib/holdfold-cache-db.ts, ../../lib/watchlist-store.ts, ../../lib/backtest.ts, ../../lib/shared/signal-lookup.ts]
---

# Concept — Cache, Then Degrade (and the Two Failure Policies)

## The pattern

Every external read in the data plane is wrapped so that failure produces the
*honest lesser* result, never a crash — but **what "lesser" means depends on
whether the data is a cache or the user's own data.**

- **Cache reads degrade silently.** `holdfold-cache-db`, `digest-cache-db`,
  `backtest`, and `signal-lookup` all `try/catch` → `return null`. A DB outage,
  an un-migrated table, a timeout, or a malformed payload all collapse to the
  same "no cached value, re-fetch or hide the feature" outcome.
- **User data propagates.** `watchlist-store` does **not** swallow errors — a
  failed insert becomes a 503. Losing a cached digest is fine; silently dropping
  a ticker the user saved is a data-loss bug wearing a graceful-degradation
  costume.

Layering, where it exists: in-memory L1 (per-instance, fast, wiped on cold
start) → Neon L2 (shared, survives deploys) → live backend. The 2026-07-15 audit
added the L2 tier precisely because L1-only state disappeared on every deploy.

## Where it appears

- [[entity-holdfold-cache]] — the canonical two-policy pair (cache vs. watchlist).
- [[entity-signal-data-plane]] — `signal-lookup` is now a full read-through L2
  (fresh `signal_cache` → live → *stale cache on outage* → null): it embodies
  the L1→L2→backend layering *and* the stale-serve fallback in one function.
  `formatTickerBrief` still guards each malformed array element.
- [[entity-backtest-engine]] — disabled-by-default is the limit case: the feature
  is *always* "degraded" until an env var proves the engine is live.
- [[entity-openrouter-client]] — `runSeat` fallback down `FREE_MODEL_CHAIN` is the
  same instinct one layer up (model-level rather than data-level).
- [[entity-disclaimer-system]] — the asymmetric-by-field variant (see
  Contradictions below): read fails closed, write fails open, in the same table.

## Contradictions / tensions

- ⚠️ **Silent degradation hides outages.** An un-migrated `holdfold_cache` looks
  identical to a cold cache: correct behavior, zero signal that the cache never
  works. _Partially addressed (TODO3):_ `signal-lookup`'s `readCachedEntry` now
  returns a discriminated `hit | miss | broken` and logs `cache_broken` on a
  read error, so at least the per-ticker L2 distinguishes the two — but
  `holdfold_cache`/`digest_cache` still collapse both to `null`.
- ⚠️ **The two policies are convention, not type-enforced.** Nothing stops a
  future author from `try/catch`-swallowing a watchlist write. The
  cache-vs-user-data distinction lives in comments and reviewer vigilance.
- ⚠️ `backtest` remains uncached-by-design, trading resilience for freshness.
  (`signal-lookup` no longer does — TODO2 gave it the read-through L2.)
- ⚠️ **Stale-serve has no visible age.** Now that `signal-lookup` serves stale
  `signal_cache` on outage, a user can see real-but-old data with no badge
  saying how old — the freshness-contract gap on [[entity-signal-data-plane]].
- ⚠️ **[[entity-disclaimer-system]] (2026-08-11) is a third policy, not a
  variant of the existing two.** `disclaimer_acks` reads fail *closed*
  (`hasAcknowledged` → `false` on error, re-showing the gate) while writes to
  the same table fail *open* (`recordAck` swallows the error). Neither cache
  nor user-data framing fits cleanly: it isn't disposable like a cache (a
  false negative here re-prompts a real user, not just re-fetches data), but
  unlike watchlist writes it deliberately tolerates losing one ack write. The
  read/write split — not the table — is what decides the policy.

## See also

- [[concept-graceful-degradation]] — the "one hard dependency" stance this refines
- [[entity-holdfold-cache]] — the two policies side by side
- [[entity-backtest-engine]] — degradation taken to disabled-by-default
- [[decision-compile-time-grounding]] — precompute vs. request-time, same axis
