# Wiki Log — nuwrrrld-portal

Append-only chronological record. Format: `## [{date}] {ingest|query|lint} | {summary} | pages touched: N`

---

## [2026-07-24] sync | PR #42 parity check (landing revamp) — no change | pages touched: 3

PR #42 (`feat/landing-revamp-phase1-2`) rewrote the signed-out landing page:
copy simplified to plain language, `landing.css`'s local green palette
repointed onto the app's neon tokens, a market-data shape bug fixed
(`brief.indices` keyed by display name, not a top-level `.indices` keyed by
ticker), and `framer-motion`/`lenis`/`react-intersection-observer`/
`lucide-react` added for scroll-reveal, parallax, and a magnetic CTA. Assessed
against the mobile↔web parity rule: touches no `lib/shared/` module and no
cross-surface business logic — it's the portal's public marketing surface,
which mobile has no direct analog for (nearest equivalent, `OnboardingScreen`,
already tracked as mobile-only). Headline (~62%) and matrix left unchanged;
added a dated assessment note to `concept-mobile-web-parity.md` and updated the
Onboarding row in `concept-sync-requirements.md` to reflect the strengthened
landing page. Mirrored in `gcp3-mobile/docs/wiki-mobile/`.

---

## [2026-07-24] sync | PR #40 parity recompute — portal pulled ahead on the signal data plane | pages touched: 3

Per the mobile↔web wiki-sync rule, recomputed parity after PR #40. Headline
dropped ~65% → **~62%**: feature-domain parity held at ~82% (no new *shared*
domain) but single-source parity fell ~44% → ~38% because the PR added a whole
portal-only real-time signal tier (`signal-queue`, `signal-policy`, read-through
`signal_cache`, `live-price` + `live-price-db`, `/api/signals/drain` + `/live`)
with no mobile counterpart — two of those modules (`signal-policy.ts`,
`live-price.ts`) even sit in `lib/shared/` yet are portal-only (new share-debt).
Updated `concept-mobile-web-parity.md` (headline + matrix rows + tension) and
`concept-sync-requirements.md` (de-drift + port tables flag the two new shared
candidates). Mobile mirror (`gcp3-mobile/docs/wiki-mobile/`) updated in the same
turn.

---

## [2026-07-24] ingest | TODO4 — ship the 3 deferred items (drain cron, Finnhub WS tier, CI Neon branch) | pages touched: 4

Shipped everything TODO3 left deferred. (1) `homebase/modal_drain.py` — a
lightweight Modal cron that loops `POST /api/signals/drain` until the queue is
empty (the scheduler the pending-signals loop was waiting on). (2) Finnhub
WebSocket live-price tier: portal `live_prices` table + `POST/GET
/api/signals/live` + pure `lib/shared/live-price.ts` (unit-tested) + guarded
`lib/live-price-db.ts`, fed by a persistent `homebase/modal_finnhub_ws.py`
container. (3) `.github/workflows/integration-tests.yml` — creates an ephemeral
Neon branch, migrates, runs the guarded integration test, deletes the branch
(needs `NEON_API_KEY` / `NEON_PROJECT_ID`). Portal: `tsc --noEmit` clean, vitest
66 passed / 4 skipped; both homebase modules `py_compile` clean.

**Pages created (1):** `entity-live-price-tier.md` — the WS lane + drain cron + CI.
**Pages updated (3):** `decision-pending-signals-queue.md` (deferred scheduler now shipped), `index.md`, `log.md`.

**Cross-repo note:** `modal_drain.py` / `modal_finnhub_ws.py` live in `homebase/`; referenced by path per SCHEMA, not documented as portal pages.

---

## [2026-07-24] ingest | TODO3 hardening of the pending_signals loop (50% more robust) | pages touched: 4

Third pass (scheduled restart, run at 17:42 CEST). Closed the concurrency /
backoff / freshness-precision / observability gaps TODO2 left. Changes:
(1) `claimPendingSignals` is now an atomic `UPDATE … FOR UPDATE SKIP LOCKED …
RETURNING` (`pending → processing`) so concurrent drains can't double-process;
(2) a 120 s lease reclaims rows orphaned by a crashed drain; (3) failures
requeue with `backoffSeconds` (exponential, capped 1 h) via a new
`next_attempt_at` column; (4) `cacheTtlMinutes` makes `fetchTickerEntry`'s cache
window volatility-aware (5/15/30 min); (5) `readCachedEntry` returns
`hit|miss|broken` and logs `cache_broken`; (6) `GET /api/signals/drain` returns
`getQueueStats` (counts, oldest-pending-age, error-rate). New pure helpers
(`backoffSeconds`, `cacheTtlMinutes`) unit-tested; a guarded
`signal-queue.integration.test.ts` (dynamic-import, runs only with
`DATABASE_URL`) closes TODO2's "Validated by" gap. `tsc --noEmit` clean;
vitest 60 passed / 4 skipped.

**Pages updated (4):**
- `decision-pending-signals-queue.md` — added a "TODO3 hardening" block; rewrote "Validated by" (24 unit cases + guarded integration test)
- `entity-signal-data-plane.md` — volatility-aware TTL + discriminated cache read documented
- `concept-cache-then-degrade.md` — the "no telemetry separating miss from broken" tension now partially addressed for the per-ticker L2
- `log.md` — this entry

**Schema (SQL):** `pending_signals` gains `next_attempt_at`, `claimed_at`, and a `processing` status (idempotent `ADD COLUMN IF NOT EXISTS`); status index realigned to `(status, next_attempt_at)`.

**Wiki schema compliance:** decision page keeps all 7 sections; ≥3 cross-links each; no secrets. ✅

---

## [2026-07-24] ingest | TODO2 hardening of the pending_signals loop (75% more robust) | pages touched: 3

Follow-up to the TODO.md queue implementation. Closed the seven robustness gaps
listed in TODO2.md: (1) `signal_cache` is now a real read-through L2 in
`fetchTickerEntry` — fresh cache → live (warms cache) → *stale cache on outage*
→ null; (2) `normalizeTicker` guards enqueue/drain/watchlist; (3) enqueue dedups
via `WHERE NOT EXISTS` + a partial unique index; (4) failed drains retry under
`MAX_ATTEMPTS` instead of dying; (5) `purgePendingSignals(7d)` runs each drain;
(6) drain has a 25 s time budget; (7) pure logic extracted to
`lib/shared/signal-policy.ts` and unit-tested. `tsc --noEmit` clean; full vitest
suite 53/53 green (12 new in `__tests__/signal-queue.test.ts`).

**Pages updated (3):**
- `entity-signal-data-plane.md` — L2 read-through documented; "uncached round-trip" open question resolved; three-cache-overlap noted
- `decision-pending-signals-queue.md` — added a "TODO2 hardening" consequences block + updated "Validated by" (unit-tested logic, DB path still un-integration-tested)
- `concept-cache-then-degrade.md` — signal-lookup reclassified from uncached to read-through-with-stale-serve; added the stale-age tension

**Schema compliance:** decision page retains all 7 sections; no secrets; ≥3 cross-links each. ✅

---

## [2026-07-24] ingest | pending_signals queue implementation (4-phase TODO.md) | pages touched: 3

Implemented the "add stock → cache → run signals" loop from the robustness
pass: `lib/signal-queue.ts` (enqueue/claim/mark helpers), `pending_signals` +
`signal_cache` tables (`lib/db/schema.sql`), `POST /api/signals/drain` (drains
the queue via existing `fetchTickerEntry`), watchlist-add now enqueues, and
"+ Watchlist" buttons on `SignalsClient`/`HoldFoldClient`. External scheduling
(Modal/Zo cron calling `/drain`) deferred — lives in `homebase/`, a separate
repo. `npx tsc --noEmit` passes.

**Pages created (1):**
- `decision-pending-signals-queue.md` — why enqueue-then-drain instead of a synchronous watchlist-add call

**Pages updated (2):**
- `entity-portfolio-intelligence.md` — known failure #1 ("watchlist is not yet a signal trigger") closed; open questions updated
- `index.md` — added the new decision page; refreshed "last updated"

**Schema compliance:** decision page has all 7 required sections; ≥3 cross-links; no secrets; cross-repo mention of `homebase/` uses prose, not a wikilink (different repo). ✅

---

## [2026-07-24] ingest | Signal data plane, backtest, cache & portfolio subsystems | pages touched: 8

Second build-out. Extended the wiki from "AI Council + grounding only" to also cover the signal read path — the ~25% of the portal that was listed as "not yet documented" in `overview.md`. Source of truth: the portal code read directly on 2026-07-24 (`lib/backtest.ts`, `lib/portfolio.ts`, `lib/watchlist-store.ts`, `lib/holdfold-cache-db.ts`, `lib/shared/signal-lookup.ts`, `lib/shared/signalFilters.ts`, `app/dashboard/signals/SignalsClient.tsx`, `app/dashboard/holdfold/HoldFoldClient.tsx`) plus the 2026-07-15 audit history (PR #34) and PR #37.

**Pages created (5):**
- `entity-signal-data-plane.md` — gcp3 fetch-and-shape read path; per-ticker lookup, digest/holdfold shape, shared filters
- `entity-backtest-engine.md` — the separate `SIGNALS_ENGINE_URL` hit-rate engine, disabled by default
- `entity-holdfold-cache.md` — Neon L2 cache vs. watchlist user-data store; the two failure policies
- `entity-portfolio-intelligence.md` — health/optimizer/watchlist type contract; the un-closed "add stock → run signals" loop
- `concept-cache-then-degrade.md` — L1→L2→backend layering; cache degrades, user data propagates

**Pages updated (3):**
- `index.md` — added Signal Data Plane entity group + cache concept; refreshed scope line
- `overview.md` — moved Hold/Fold + portfolio + signals from "not yet documented" to documented; added data-plane risks
- `log.md` — this entry

**Schema compliance:** entity pages have all 5 required sections; concept page has all 4; every new page has ≥3 cross-links; no secrets (used `{gcp3-backend-url}` for the Cloud Run host); cross-repo refs use path-links (wiki-gcp3, wiki-mobile). ✅

---

## [2026-07-20] build-out | Initial AI Council + grounding subsystem wiki | pages touched: 12

First substantive build-out of `wiki-portal`. Before today the wiki held only `SCHEMA.md`, `raw/`, and one entity page (`entity-ai-council.md`), and had no `index.md`, `log.md`, or `overview.md` — unlike its more mature siblings `wiki-mobile` (34 pages) and `wiki-gcp3` (39 pages).

Source of truth: the portal codebase read directly on 2026-07-20 (`lib/openrouter.ts`, `lib/grounding/*`, `lib/council-grounding.ts`, `lib/council-verdict.ts`, `lib/council-critique.ts`, `lib/council-validate.ts`, `lib/council-db.ts`, `app/api/council/*`, `scripts/compile_grounding_pack.mjs`, `scripts/grounding-chunker.mjs`, `corpus/README.md`, `.github/workflows/compile-grounding-pack.yml`) plus the PR history (#34, #35, #36, #37). Every page synthesized from code, not copied.

**Pages created (11):**

_Core infra (3):_
- `overview.md` — stack (Next.js 16 / React 19 / Clerk / Neon / Stripe / OpenRouter), system map, health, documented-vs-pending scope
- `index.md` — full catalog by page type
- `log.md` — this file

_Entities (3):_
- `entity-grounding-tier-ladder.md` — the four-tier deterministic brief resolver + taxonomy + per-seat slicing
- `entity-openrouter-client.md` — seats, `SEAT_MODELS`, `FREE_MODEL_CHAIN`, `runSeat` fallback
- `entity-grounding-compiler.md` — the weekly CI compile pipeline; corpus/chunker; verbatim-quote invariant

_Concepts (3):_
- `concept-small-model-prompting.md` — the ≤5-directive / positive-constraint / recency contract; §-map to code
- `concept-verdict-repair-loop.md` — numeric cross-check + trade-logic sanity → mechanical re-prompt
- `concept-graceful-degradation.md` — the "one hard dependency" resilience stance

_Decisions (4):_
- `decision-four-field-verdict-scaffold.md` — 4 fields not 6
- `decision-split-chair-synthesis-and-verdict.md` — two CHAIR calls; 3× verdict vote, min confidence
- `decision-compile-time-grounding.md` — build-time pack, not request-time RAG
- `decision-free-tier-model-chain.md` — $0 per deliberation

**Pages updated (1):**
- `entity-ai-council.md` — no content change needed; all five of its previously-dangling `[[…]]` links now resolve (`entity-grounding-tier-ladder`, `concept-small-model-prompting`, `concept-verdict-repair-loop`, `decision-four-field-verdict-scaffold`, `decision-split-chair-synthesis-and-verdict`).

**Schema compliance check:**
- Entity pages have required sections (What it is, Where used, Known failures, Open questions, See also): ✅
- Concept pages have required sections (The pattern, Where it appears, Contradictions / tensions, See also): ✅
- Decision pages have required sections (Decision, Date, Context, Alternatives considered, Consequences, Validated by, See also): ✅
- All new pages added to `index.md`: ✅
- No secrets written (used `{gcp3-backend-url}`-style refs; backend host appears only where already hardcoded in source as a documented open question): ✅
- Every new page has ≥3 cross-links: ✅
- Cross-repo references use path-links, not `[[…]]`: ✅ (mobile council-composer, gcp3 endpoint-signals / bake-pipeline / no-mock-data)

**Open items carried:**
- Production corpus migration (sample-only today) — tracked on `entity-grounding-compiler`.
- No live-model golden tests in CI — tracked on `entity-ai-council`, both verdict decisions.
- The rest of the portal (Stripe, retention, portfolio, Hold/Fold, nuai) remains un-ingested — listed in `overview.md`.

## [2026-07-24] sync | cross-surface parity analysis | pages touched: 4 (concept-mobile-web-parity, concept-sync-requirements, index; mobile mirror)

## [2026-07-24] ingest | PR #41 dev financial-data hydration seeder | pages touched: 1 (log only — dev tooling, no mobile↔web parity change; ynced unaffected)
