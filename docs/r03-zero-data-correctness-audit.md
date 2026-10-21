# R03 — Zero-data and correctness audit

**Date:** 2026-10-21  
**Scope:** Atlas risks P45, P12, P07, signal-score validation, `pending_signals`, and invoice ownership.  
**Status:** P45 code paths now refuse to invent a ticker take when no grounding exists; the other findings remain open where they require a policy, external schedule, or data-owner decision.

## P45 — no-data behavior

- The authenticated multi-seat route on `origin/main` already rejects all-seat `NoGroundingError` runs before making model calls, refunds an actually bumped quota unit, and avoids creating an orphan session. Partial grounding runs retain grounded seats and mark the others degraded. The existing `__tests__/council-deliberate.test.ts` covers these cases.
- The unauthenticated public demo route still called the RISK model with an empty prompt grounding when the signal lookup returned no brief. This branch fixes that gap: it returns HTTP 503 with a clear no-live-data message, keeps the attempt charged against the existing daily quota, does not call or cache a model answer, and preserves normal grounded and cache-hit behavior. Keeping the attempt charged prevents repeated anonymous requests for unknown tickers from bypassing the cap on upstream lookups.
- The live signal adapter also used to fall back to the first returned symbol when the requested key was missing. That could ground one ticker's answer with another ticker's signal and then cache it under the requested ticker. The adapter now accepts only a matching map key and rejects an entry whose own `symbol` disagrees; a mismatch degrades to no grounding. The reader also rejects previously cached rows whose embedded symbol conflicts with the cache key.
- Focused verification: `council-public-route.test.ts`, `council-deliberate.test.ts`, `council-grounding-card-fallback.test.ts`, and `signal-lookup-no-backend.test.ts` — 22 tests passed; ESLint and `git diff --check` passed. The cache-identity hardening was added after the last Claude review and still needs cross-model review.

## P12 — declared-but-empty sentiment

`tools/nwf-lab/nwf_lab/features/news_sentiment.py` raises `MissingInputError` when the declared `news` input contains no articles. This establishes a local feature-level failure contract. It does not prove that the separate production signal scan treats Finnhub 403 / gcp3 401 failures as fatal; no production pipeline was triggered or changed. P12 remains open for that production path.

## P07 — sector-cap coverage

`lib/shared/paper-sectors.ts` returns `null` for unmapped tickers, and `lib/shared/paper-engine-core.ts` applies the sector cap only when a sector is known. This avoids silently inventing a sector, but unknown symbols can bypass the per-sector cap. A safe behavior requires the product owner to choose whether unknown-sector candidates are rejected, grouped into a conservative bucket, or allowed with a disclosed limit. Do not select a policy implicitly.

## Signal-score validation

The codebase has consumers and source-specific ranges for several score fields, but no confirmed single contract covering every producer and reader in this audit. Establish accepted units/ranges and invalid-value behavior at the producer boundary before rejecting or normalizing existing records. No range change was made.

## `pending_signals` ownership

The portal contains enqueue and drain functions in `lib/signal-queue.ts` and a bearer-protected handler in `app/api/signals/drain/route.ts`. Repository presence alone does not establish an active owner or live schedule; the atlas points to an external Homebase Modal drain worker. Confirm that operator and schedule before selecting or changing a drain path.

## Invoice ownership

The atlas records `invoices` as a shared-database table not declared in this repo's schema. No table rows or credentials were read. The owning service's data owner must determine ownership and approve any read-only contents review because invoice data may contain PII.

## Remaining gates

1. Verify the production P12 scan failure contract without triggering a paid or production run.
2. Record the unknown-sector policy and signal-score range contract with the product/data owner.
3. Confirm who operates the external `pending_signals` drain and whether its schedule is active.
4. Have the billing/data owner establish `invoices` ownership through an approved, read-only review.
