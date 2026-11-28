---
date: 2026-10-12
type: concept
tags: [cache, resilience, neon, cold-start, failure-policy]
sources: [../../lib/holdfold-cache-db.ts, ../../lib/digest-cache.ts, ../../lib/watchlist-store.ts, ../../lib/backtest.ts, ../../lib/shared/signal-lookup.ts, ../../app/dashboard/page.tsx]
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

- `app/dashboard/page.tsx` requests `/market-overview?sections=brief` for its
  summary and index prices, retaining 900-second revalidation and the 8-second
  abort fallback to `null`. Selecting the consumed section avoids waiting for
  unrelated overview sections that can invoke LLM generation; cached reads
  should request only the data the renderer needs.
- [[entity-holdfold-cache]] — the canonical two-policy pair (cache vs. watchlist).
- [[entity-portfolio-intelligence]] — a **fourth** shape, new 2026-09-11: not a
  cache at all, but a *substitute computation*. `/api/portfolio/health` prefers
  an upstream and falls back to scoring the same question from local data. It
  follows the cache policy's instinct (degrade, don't crash) while inverting
  its economics — the "degraded" path is the reliable one and the preferred
  path is the one that has never once worked. The honest-floor rule still
  binds: zero coverage returns 503, not a zero.
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
  **Widened 2026-09-11.** Portfolio health now scores from `ticker_cards` when
  gcp3 is absent ([[decision-local-portfolio-scoring-over-upstream-wait]]),
  which makes a *whole derived number* subject to the same gap: the verified
  run graded a portfolio on 2026-09-11 from a 2026-09-05 bar, and nothing in
  the response degrades or flags on that. Worse than the per-ticker case,
  because a score is an aggregate — its staleness is invisible even in
  principle to a user comparing it against a price they can see. Given
  [[incident-2026-09-03-nightly-hydration-dead-15-days]], a silently-frozen
  `ticker_cards` is demonstrated, not theoretical.
- ⚠️ **[[entity-disclaimer-system]] (2026-08-11) is a third policy, not a
  variant of the existing two.** `disclaimer_acks` reads fail *closed*
  (`hasAcknowledged` → `false` on error, re-showing the gate) while writes to
  the same table fail *open* (`recordAck` swallows the error). Neither cache
  nor user-data framing fits cleanly: it isn't disposable like a cache (a
  false negative here re-prompts a real user, not just re-fetches data), but
  unlike watchlist writes it deliberately tolerates losing one ack write. The
  read/write split — not the table — is what decides the policy.

## Worked case — the signals digest's last resort

`getOrFetchDigest` (see `lib/digest-cache.ts`) is the pattern in full: per-user cache,
global cache, live fetch, then a degraded last resort. The durable Neon read has a short
freshness window, so it only answers while the row is recent. The last resort used to
read the in-memory copy only, which a cold serverless instance does not have, so a live
outage right after a cold start produced an empty page while Neon still held a digest.
The last resort now reads the newest durable row of any age and marks it degraded. The
rule it illustrates: a degrade path must read from the same durable layer the
freshness-gated path does, only without the age gate, or "degrade" quietly means "nothing".

**Follow-up (2026-11-27): the last resort has a cost, too.** Digests reach Neon only
when a local script pushes one, so most requests are past the 15-minute window. The
degraded read then ran on every signals page load, digest API call and Nu AI message.
Each of those read the whole stale payload again, because nothing remembered it
between requests. The fix keeps that row in process memory for 5 minutes. It holds
only a populated row, never an empty digest, a miss or a failed read, and serves it
marked degraded. The memo sits after the fresh-row check and the live fetch, so it never
hides a fresh row by itself. What still can is older: the in-process per-user copy (up to
15 minutes) and global copy (up to 1 hour) return before the fresh-row check, so a new
push reaches a warm instance only once those expire. That trade was left alone, because
checking Neon on every warm hit would add the reads this change removes. The memo
window is shorter than Neon's 15-minute freshness window, so it can't hide a newer
stale row for long. Concurrent cold requests can each start their own read; the
one-read figure holds for sequential requests on a warm instance. The digest is
global, with no per-user data in it, so the memo can't leak between users. Per-user
rows keep their own cache. The rule this adds: a degrade path that runs on almost
every request is effectively the main path, so budget its reads like one.

## See also

- [[concept-graceful-degradation]] — the "one hard dependency" stance this refines
- [[entity-holdfold-cache]] — the two policies side by side
- [[entity-backtest-engine]] — degradation taken to disabled-by-default
- [[decision-compile-time-grounding]] — precompute vs. request-time, same axis
