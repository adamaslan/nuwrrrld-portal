# Wiki Log — nuwrrrld-portal

Append-only chronological record. Format: `## [{date}] {ingest|query|lint} | {summary} | pages touched: N`

---

## [2026-07-30] ingest | testing + free-tier robustness pages | pages touched: 6 (4 new, 2 index; both wikis)

Added a documented home for two subjects that were load-bearing but unwritten:
how each surface tests itself, and how each stays reliable on a free tier.

**Pages created (2 per wiki):**
- `concept-test-strategy.md` — portal: the three vitest projects (unit /
  components / live), why `live` is quarantined from the default suite
  (external quota makes it legitimately flaky, not badly written), and a
  ranked list of what would actually raise confidence.
- `concept-free-tier-resilience.md` — portal: the five layers keeping $0
  inference reliable (in-request chain fallthrough, weekly refresh cron,
  `MIN_WORKING` refuse-to-worsen guard, honest degradation, capability
  budgeting) and the account-wide quota ceiling none of them address.

Findings that changed the picture rather than just describing it:
- **Nothing runs the unit suite in CI.** `integration-tests.yml:13` asserts
  "the default unit suite (npm test) still runs everywhere" — no workflow
  does. 180 unit + component tests are local-only. Recorded as a contradiction.
- **19 of 29 portal test files are untracked** — including all three live
  tests and every landing component test. Same written-but-never-committed
  failure that repeatedly lost wiki content.
- **`npm run lint` crashes repo-wide** (ESLint flat/eslintrc circular config),
  so lint enforces nothing.
- **The refresh-free-models cron has failed both recent scheduled runs**
  (07-20, 07-27) — a weekly 14-model probe against a 50/day account budget is
  plausibly self-inflicted; pre-flighting `GET /api/v1/key` would fix the red.
- Mobile has **no test framework at all** (no jest/vitest/testing-library/detox
  in package.json) — its page documents that absence honestly and argues the
  first tests should target the modules parity claims are byte-identical, so
  tests double as drift detection.

## [2026-07-30] ingest | PR #46 ground /api/brief in real market data | pages touched: 3 (concept-mobile-web-parity, concept-sync-requirements, index; mobile mirror)

`/api/brief` had two dead upstream calls — a nonexistent `/holdfold` endpoint
(404→null) and an unscoped `/market-overview` fetch that took 16.4s against a
6s client timeout (always null) — so the prompt always fell back to
placeholder text while still instructing the model to cite specifics; it
dutifully wrote briefs narrating their own missing data. Fixed by deriving
verdicts from `/signals` via a new `lib/shared/holdfold-map.ts` (shared
between `/api/brief` and `/api/holdfold`, which previously had its own
private copy of this mapping) and scoping the overview fetch to
`?sections=brief` (16.4s → ~0.5s).

Parity impact: `holdfold-map.ts` is a fourth portal-only `lib/shared/` file
(after `signal-policy.ts`, `live-price.ts` from PR #40) — not portable to
mobile as-is since mobile's Hold/Fold client hits a different backend with an
incompatible verdict shape. Also surfaced that mobile's `BriefingScreen` has
its own independent long-term-brief implementation, never previously tracked
in the parity matrix — added as a new 🔴 Divergent row alongside AI Council,
plus a performance note that mobile's own `getMarketOverview()` call has the
same unscoped-fetch cost this PR just fixed on the portal side. Headline
~61%→~60% (single-source ~37%→~36%; feature-domain ~82% unchanged — Daily
Brief already existed on both sides, just newly tracked as a row).

## [2026-07-30] ingest | PR #44 refresh FREE_MODEL_CHAIN (automated) | pages touched: 3

Routine weekly chain refresh (`gemma-4-31b-it` → `nemotron-3-nano-omni-30b-a3b-reasoning`)
merged after confirming CodeRabbit had no actionable comments and the only
failing check (Cloudflare Pages) fails identically on `main` — pre-existing,
unrelated (Vercel is the real deploy target and passed).

While re-running `scripts/refresh-free-models.mjs --dry-run` to sanity-check
the new chain, found every model in the live probe returning 429 — not a dead
roster, but the OpenRouter key's **account-wide** free-tier daily cap (50
req/day, shared across every model) fully exhausted, confirmed via
`GET /api/v1/key` (`X-RateLimit-Remaining: 0`, reset at the next UTC
midnight). This is the exact "concurrency against the free pool" risk
[[decision-free-tier-model-chain]] had flagged as unvalidated — now refuted
(it fails). Updated [[entity-openrouter-client]] ("Known failures") and
[[decision-free-tier-model-chain]] ("Validated by") to document it, since a
whole-chain 429 currently looks indistinguishable from "every free model
died" to both the refresh script and any caller.

Also merged PR #45's already-open fixes while investigating — no new wiki
content needed there since PR #45 was fully ingested in the entry below on
its own merge.

## [2026-07-27] ingest | PR #45 Stripe checkout production incident | pages touched: 6

Root-caused "still can't actually sign up via Stripe" via Vercel production
telemetry (`get_runtime_errors` on `/api/stripe/checkout`) and a curl of the
live `/sign-in` page: (1) a malformed `STRIPE_SECRET_KEY` threw an unhandled
`ERR_INVALID_CHAR` inside `stripe.checkout.sessions.create`, producing a
bodyless 500 the frontend showed as a generic alert; (2) Clerk was serving a
Development instance key (`pk_test_...`) on the production domain. Shipped:
try/catch on both Stripe SDK call sites (`checkout`/`portal` routes) returning
real `502` JSON errors, `/api/health` checks for both misconfig classes
(price-ID placeholders, Clerk dev-key-in-production), and
`parseSubscriptionMetadata()` in `lib/subscription.ts` replacing untyped casts
at 3 call sites. `npm run build` clean, `npx vitest run --project unit` 170
passed / 4 skipped (2 new test files), `tsc --noEmit` clean. Two manual steps
(key rotation, Clerk production promotion) remain — owner-only, tracked as
open items on the incident page.

**First Stripe/Clerk billing documentation in this wiki** — `overview.md`
previously listed `/api/stripe/*`, `/api/webhooks/*` as "not yet documented."

**Pages created (2):**
- `entity-billing.md` — Clerk (entitlement source of truth) + Stripe (checkout/portal/webhook sync); first billing entity page
- `incident-2026-07-27-stripe-checkout-invalid-header.md` — the incident, root cause, resolution, open manual items

**Pages updated (4):**
- `concept-mobile-web-parity.md` — assessment note; headline ~62%→~61%; Subscription/billing matrix row downgraded from "✅ Synced… identical" to "🟡 Partial… diverged" (see below)
- `concept-sync-requirements.md` — new top-priority de-drift row for `lib/subscription.ts`
- `overview.md` — moved billing from "not yet documented" to documented; added two new known-gaps bullets
- `index.md` — added the new entity + incident pages; refreshed scope line and last-updated

**Cross-repo finding:** this PR's `parseSubscriptionMetadata()` was added to
the portal's `lib/subscription.ts` only — confirmed via `diff` against
`gcp3-mobile/lib/subscription.ts` that the two files were byte-identical
before this change. This is new, real single-source drift in a module the
parity matrix previously counted as one of only four fully-synced shared
modules. Mirrored in `gcp3-mobile/docs/wiki-mobile/` (parity pages + index +
log only — the incident/entity pages are portal-specific and referenced by
path from mobile, not duplicated).

**Schema compliance:** entity page has all 5 required sections; incident page
has all 6; every new page has ≥3 cross-links; no secrets (Stripe/Clerk key
prefixes shown are placeholders/format descriptions, never real values);
cross-repo mobile reference uses a path-link, not a wikilink. ✅

---

## [2026-07-24] sync | PR #43 parity check (landing Phase 3+4) — +1 matrix row | pages touched: 3

PR #43 (`feat/landing-phase3-4-viral-loop`) added a sticky-scroll council
demo, a RISK-seat spotlight, a "how it works" section, and — the one piece
with real backend — a no-login public council demo (`/api/council/public`,
new `public_demo_usage`/`public_demo_cache` tables), shareable OG verdict
cards (`/api/og/verdict/[ticker]`), and public `/verdict/[ticker]` pages.
Assessed against the mobile↔web parity rule: reuses the existing portal-only
`lib/openrouter.ts` AI Council stack rather than adding a new shared module —
no `lib/shared/` file touched — so single-source parity is unchanged.
Feature-domain parity also holds (this isn't a new *shared* domain). Added one
new matrix row ("Public council demo + share cards", portal-only) since it's
a real extension of the AI Council surface worth tracking, even though it
doesn't move the headline. Updated `concept-mobile-web-parity.md` (assessment
note + matrix row) and `concept-sync-requirements.md` (noted as a pattern
mobile could copy for an app-store teaser, if ever wanted). Mirrored in
`gcp3-mobile/docs/wiki-mobile/`.

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

## [2026-07-26] investigation | Portfolio Health "unavailable" / "returned empty" | pages touched: 5 (incident-2026-07-26-portfolio-health-endpoint-missing [new], entity-portfolio-intelligence, concept-graceful-degradation, index, log)

Traced both user-facing Portfolio Health failures to a single cause: the gcp3
route `{MCP_BACKEND_URL}/api/portfolio/health` was never registered — the logic
is orphaned in `portfolio_analyzer.py`. Findings that changed existing pages:

- `entity-portfolio-intelligence` known-failure #2 ("verify the health-ai →
  health fallback holds") **verified false in both directions** — health-ai
  doesn't fall back, and its fallback target is itself broken.
- Its open question "is the score from real holdings or the watchlist?"
  **answered: neither** — no tickers are sent, so gcp3 would grade its hardcoded
  `DEFAULT_PORTFOLIO`.
- `concept-graceful-degradation` gains its first counterexample: degradation
  with no floor, and silent degradation into plausible fabrication. Sharpened
  rule recorded — the council's "*and say so*" clause is the load-bearing part.
- Contract drift found: gcp3 emits `ai_grade`/`ai_*`; portal expects
  `score`/`factors[]`/`summary`. Naive wiring would grade every user F silently.
- Regression origin: `homebase/nuwrrrld-portal-audit.md` un-disabled the score
  button on the assumption the route worked, surfacing a pre-existing break.

Also produced `docs/portfolio-health-ai-workflow.html` (full-stack trace,
11-defect catalogue, ranked causes for the empty-stream symptom). Mobile mirror
updated — same route, same breakage.

## [2026-07-26] implementation | Portfolio Health fix Phases 1-2 (code-complete, not deployed) | pages touched: 1 (incident-2026-07-26-portfolio-health-endpoint-missing)

Implemented all Phase 1 and Phase 2 items from `docs/portfolio-health-fix-plan.md`:
gcp3 `/api/portfolio/health` route + `to_health_contract` adapter, portal sends
real watchlist tickers with a `204` empty-state, new opt-in
`fetchWithModelFallbackChecked` (openrouter.ts) that treats empty completions
as failures and primes each candidate model before flushing headers, raised
`max_tokens`, `Accept`-negotiation on `health-ai`/`brief`, and a `grounded`
signal surfaced in the UI instead of silent fabrication.

`npx tsc --noEmit` and `npx vitest run` (137 passed) clean on portal; gcp3's
two edited files pass `ast.parse` (no local env to run them live — deps like
`google.cloud` aren't in the base mamba env). Caught and fixed two connected
bugs while implementing: mobile's `usePortfolio.ts` would have thrown on the
new `204` (res.ok is true for 204, `.json()` on empty body throws), and
`PortfolioClient.tsx` never sent an `Accept` header, so enabling content
negotiation on `health-ai` would have silently broken its own streaming UI.

**Not deployed. Not verified live.** Acceptance checkboxes in the fix plan are
intentionally left unchecked — this incident's own history (the 2026-07-21
env-var fix that "looked ineffective" for five days) is the reason the plan
requires a positive live observation, not passing typecheck, before calling
anything fixed.

## [2026-08-06] ingest | /postbugmergerev command + wiki-led-development concept | pages touched: 2

## [2026-08-06] ingest | START-HERE orientation entry point + orient-first enforcement; catalogued bugmerge1 incident, reconciled parity headline to ~60% | pages touched: 5

## [2026-08-06] ingest | PR #48 feat(ci): env-schema validator, CI test job, lint fix | pages touched: 4
