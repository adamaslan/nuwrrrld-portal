# R03 — Zero-data and correctness audit

**Date:** 2026-10-21  
**Scope:** Atlas risks P45, P12, P07, signal-score validation, `pending_signals`, and invoice ownership.  
**Status:** P45 code paths now refuse to invent a ticker take when no grounding exists; the other findings remain open where they require a policy, external schedule, or data-owner decision.

## P45 — no-data behavior

- The authenticated multi-seat route on `origin/main` already rejects all-seat `NoGroundingError` runs before making model calls, refunds an actually bumped quota unit, and avoids creating an orphan session. Partial grounding runs retain grounded seats and mark the others degraded. The existing `__tests__/council-deliberate.test.ts` covers these cases.
- The unauthenticated public demo route still called the RISK model with an empty prompt grounding when the signal lookup returned no brief. This branch fixes that gap: it returns HTTP 503 with a clear no-live-data message, keeps the attempt charged against the existing daily quota, does not call or cache a model answer, and preserves normal grounded and cache-hit behavior. Keeping the attempt charged prevents repeated anonymous requests for unknown tickers from bypassing the cap on upstream lookups.
- The live signal adapter also used to fall back to the first returned symbol when the requested key was missing. That could ground one ticker's answer with another ticker's signal and then cache it under the requested ticker. The adapter now accepts only a matching map key and rejects an entry whose own `symbol` disagrees; a mismatch degrades to no grounding. The reader also rejects previously cached rows whose embedded symbol conflicts with the cache key.
- Focused verification: `council-public-route.test.ts`, `council-deliberate.test.ts`, `council-grounding-card-fallback.test.ts`, and `signal-lookup-no-backend.test.ts` — 23 tests passed; ESLint and `git diff --check` passed. The cache-identity hardening was added after the last Claude review and still needs cross-model review.

## P12 — declared-but-empty sentiment

`tools/nwf-lab/nwf_lab/features/news_sentiment.py` now reports an empty declared `news` feed as a Finnhub `vendor_gap`, which makes `nwf-lab` exit with code 2. In GCP3, `backend/news_sentiment.py` at `origin/main` `17974fe` caught each Finnhub `/news` category error as `[]`, then cached and returned `neutral` with zero articles; its refresh callers could therefore treat the sentiment stage as complete. Commits `288bdcc`, `6c10b96`, `64446d7`, `4d96c66`, and `1b5b547` on isolated GCP3 branch `codex/r03-p12-empty-sentiment` now raise on zero usable headlines, bypass cached results without usable headlines, label partial category coverage, record missing sentiment in the fetch checkpoint, and return HTTP 503 from scheduled refresh paths. `/refresh/bake` already aborts for a `fetch_failed` checkpoint; `/market-overview` exposes a partial status. Focused verification: 47 GCP3 sentiment/refresh tests and 56 nwf-lab tests passed. The broader GCP3 suite had 9 unrelated failures (5 require `MASSIVE_API_KEY` in the test environment; 4 screener assertions disagree with current behavior). Claude's cross-model review is pending; no production pipeline was triggered or deployed. The Homebase manual tool at `homebase@489fbd0` separately treats news enrichment as optional and swallows errors (`refresh-signals.py:145-160`), but it is not the historical 929-signal scanner. P12 remains open pending cross-model review, PR integration, and approved deployment/live run evidence for the actual affected pipeline.

## P07 — sector-cap coverage

`lib/shared/paper-sectors.ts` returns `null` for unmapped tickers, and `lib/shared/paper-engine-core.ts` applies the sector cap only when a sector is known. This avoids silently inventing a sector, but unknown symbols can bypass the per-sector cap. A safe behavior requires the product owner to choose whether unknown-sector candidates are rejected, grouped into a conservative bucket, or allowed with a disclosed limit. Do not select a policy implicitly.

## Signal-score validation

The codebase has different score fields with distinct units; a single global range would be incorrect. The live digest accepts any JavaScript number for gcp3 `confluence_score` without a finite/range check (`lib/digest.ts:107`); the cache TTL reader treats that same field as a 0–100 scale (`lib/shared/signal-policy.ts:76-83`), while the digest test explicitly accepts `0.91` (`__tests__/digest-adapt.test.ts:133-135`). Separately, the portal's own card `score` is deliberately signed in `[-100,100]` (`lib/shared/card-policy.ts:194-202`, `lib/council-grounding.ts:89`), while portfolio-health's upstream `score` contract is finite `[0,100]` (`app/api/portfolio/health/route.ts:76-83`). These are separate contracts; the portal checkout does not establish the gcp3 producer's canonical `confluence_score` unit. A data-owner decision must state range, direction/sign semantics, and invalid-value behavior for each field at its producer boundary. No range change was made.

## `pending_signals` ownership

The portal contains enqueue and drain functions in `lib/signal-queue.ts` and a bearer-protected handler in `app/api/signals/drain/route.ts`. The central portal wiki log says `homebase/modal_drain.py` and its Modal cron shipped on 2026-07-24, but that file is absent from the shared `/Users/adamaslan/code/homebase` checkout and the available `homebase-*` worktrees. That claim is not live schedule proof. Confirm the operator, source repository/path, and deployed schedule before selecting or changing a drain path.

## Invoice ownership

The atlas records `invoices` as a shared-database table not declared in this repo's schema. No table rows or credentials were read. The owning service's data owner must determine ownership and approve any read-only contents review because invoice data may contain PII.

## Remaining gates

1. Verify the production P12 scan failure contract without triggering a paid or production run.
2. Record the unknown-sector policy and signal-score range contract with the product/data owner.
3. Confirm who operates the external `pending_signals` drain and whether its schedule is active.
4. Have the billing/data owner establish `invoices` ownership through an approved, read-only review.
