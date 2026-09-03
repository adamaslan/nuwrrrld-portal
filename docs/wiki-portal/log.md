# Wiki Log — nuwrrrld-portal

Append-only chronological record. Format: `## [{date}] {ingest|query|lint|friction} | {summary} | pages touched: N`

---

## [2026-08-16] ingest | PR #60 fix(stripe): checkout/portal error hardening + recovered nulogdash admin console with MFA gate; stash-recovery incident | pages touched: 3

Recovered a full feature (`app/dashboard/nulogdash` admin console, a
component-testing layer, API hardening across `brief`/`holdfold`/
`portfolio-health`) that had sat untracked in `stash@{0}` on a branch 15
commits stale against `main`. Fixed a real admin-gate bypass found during
review (`isNulogdashAdmin` trusted `emailAddresses[0]` instead of
`primaryEmailAddressId` + verification status — pinned by 22 tests, 5 of
which fail against the old logic) and added `canPerformAdminAction()` as a
separate MFA-gated check for mutating actions.

Rebasing the resulting 5-commit branch onto `main` forced the same wiki-page
conflicts to be resolved once per commit; a mechanical resolution attempt
silently duplicated a block of `log.md` mid-way through, caught only by a
full-file re-read rather than trusting `git diff`. Squashed to one commit
before re-attempting the rebase, which eliminated the repeated-resolution
surface. CI then caught a real cross-repo drift: a kept `lib/subscription.ts`
fix (`trialEnd` only serializes while `status === 'trialing'`) diverged from
`gcp3-mobile`'s stale copy. Ported the fix to mobile
(`gcp-expo1#36`, byte-identical, verified via local
`check-shared-drift.mjs`) rather than reverting it. See
[[incident-2026-08-16-stash-recovery-and-cross-repo-drift]] for the full
post-mortem.

**Pages created (1):** `incident-2026-08-16-stash-recovery-and-cross-repo-drift.md`

**Pages updated (2):** `index.md` (new incident link + header refresh),
`log.md` (this entry).

## [2026-08-05] ingest | dev-tooling layer + new /bugmerge1 command + command-suggestion mechanism | pages touched: 5

Documented the previously-unwritten dev-tooling layer and added a mechanism for
proposing new commands from observed bottlenecks. Trigger: added a `/bugmerge1`
command (scan open PRs → fix review-comment bugs → merge conflict-free) and a
pre-PR conflict guard in `/pr`; user asked to wiki it and to add a
bottleneck-driven command-suggestion mechanism plus a survey of the global
`~/.claude/` automation layer.

**Pages created (3):**
- `entity-dev-command-suite.md` — the `.claude/commands/` hub: `/pr`,
  `/bugmerge1`, `/sync-pr`, `/local-check`, `/nulogdash`, their guardrails, and
  the pre-PR conflict guard. Records the CI/test-enforcement contradiction from
  [[concept-test-strategy]].
- `concept-global-automation-layer.md` — the `~/.claude/` layer: global commands
  (`/geepr`, `/bugz`, `/reb`, `/rem1`, `/maxtoke`, `/locrun`, `/cost-savings`…),
  always-on rules (`mobile-web-wiki-sync`, `context-bloat`, `mamba`), and the
  `wiki-guard` PostToolUse hook. Notes lineage `/geepr`→`/pr`, `/bugz`→`/bugmerge1`.
- `concept-bottleneck-command-suggestion.md` — mine `log.md` + incidents + PR
  review comments for recurring friction; threshold (≥3, or 1-if-incident);
  propose-only `/suggest-commands`; the new `friction` log line as highest-signal input.

**Pages/config updated (2):**
- `index.md` — new "Dev Tooling / Workflow" entity section + two concept entries;
  header refreshed.
- `SCHEMA.md` — added the `friction` log-line type to the Log Format section.

**Cross-repo note:** the global `~/.claude/` config and the `mobile-web-wiki-sync`
rule affect `gcp3-mobile` identically. The mirror pages are *not* written here
(portal-only session) — a matching `entity-dev-command-suite` / global-automation
page belongs in `wiki-mobile` when a mobile session next touches this.

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

## [2026-08-06] ingest | dev-command-suite + self-improving loop (/friction, /suggest-commands) + /resume-safe; orient-first on /pr + /sync-pr; global artifact-and-local-html rule | pages touched: 8
## [2026-08-06] ingest | resume-safe run complete: HTML session summary (local + artifact) | pages touched: 1
## [2026-08-07] ingest | stay-on-branch-after-merge rule + checkout-guard PreToolUse hook; document PR #48 file-loss recurrence; git commands branch off origin/main | pages touched: 3
## [2026-08-07] ingest | mobile PR #29 (gcp-expo1) fix(subscription): port parseSubscriptionMetadata() — single-surface de-drift, headline ~60%→~61% | pages touched: 3
## [2026-08-07] ingest | portal PR #50 fix(shared): reconcile signalFilters.ts/prefs.ts with mobile — single-surface de-drift, headline ~61%→~62% | pages touched: 4
## [2026-08-07] ingest | mobile PR #30 + portal PR #51 fix(shared): reconcile digest.ts/signalCard.ts — dual-surface de-drift + ticker-precedence bugfix, resolves open-issue #6, headline ~62%→~64% | pages touched: 4
## [2026-08-08] ingest | portal PR #52 feat(ci): shared-core drift-detection gate (portal side) — closes /sync-pr batch item #4, headline unchanged ~64% (tooling, not de-drift); also fixes digest.ts whitespace-ticker bug + drift-script import-stripping gap from CodeRabbit review | pages touched: 3
## [2026-08-08] ingest | mobile PR #32 fix(mobile): resolve all 38 tsc --noEmit errors on baseline (gcp-expo1) + adopt lib/shared/signal-policy.ts + live-price.ts — headline ~64%→~66% (single-source ~41%→~44%) | pages touched: 1
## [2026-08-08] ingest | mobile PR #33 feat(ci): shared-core drift-detection gate (mobile side) — supersedes stale mobile PR #31 (closed, content already on main via other PRs), also fixes usePortfolio 204 empty-watchlist bug, headline unchanged ~66% | pages touched: 3
## [2026-08-11] ingest | portal PR #56 feat: disclaimer/acknowledgement system + per-ticker live analysis via holdemfoldem-api — gates verdict/signals/portfolio/analyze surfaces, adds analyze_cache | pages touched: 7
## [2026-08-12] ingest | portal PR #56 bugmerge1 pass — fixed cross-user analyze_cache leak (cache skipped for options/position requests), unbounded cache-table growth (upsert + unique index), DisclaimerModal isLoaded race, disclaimer route/localStorage hardening, 2 wiki doc corrections | pages touched: 3

## [2026-08-14] ingest | portal PR #58 chore: add CodeRabbit config, Neon findings doc, gitignore .nulogdash | pages touched: 1

Added CodeRabbit review automation (security-first tone, path filters, Clerk/Stripe/Neon checks, organization-member-only chat), committed `docs/findings-neon-and-stray-files.html` (audit of Neon build transience, mobile typecheck failures, and /sync-pr batch-run blockage), and ignored `.nulogdash/` local pipeline state. Fixed CodeRabbit findings post-merge: viewport meta for mobile rendering, refined Neon verdict to separate HTTP reachability from database-path validation, scoped CI claims to examined revisions, marked mobile repo-wide tsc --noEmit as blocking for /sync-pr, relaxed NEXT_PUBLIC_* rule to flag only secrets/internals (not prefix alone), added allow_non_org_members: false to chat config. (See [[concept-wiki-led-development]] feedback-loop instance: review → fixes → merge → wiki-ingest.) This PR touches tooling + docs only; no entity/concept changes.
## [2026-08-14] ingest | PR #59 feat(ci): afternoon pre-close pipeline workflow + GCP scheduler setup script — split scheduling GHA/GCP/Vercel by trigger semantics, fixed YAML block-scalar indentation bug in notify job pre-merge (would have broken CI parse), 4 trigger routes the workflow calls don't exist yet | pages touched: 3
## [2026-08-14] ingest | PR #59 CodeRabbit review addressed — endpoint-collision fix (/api/signals/refresh → /api/pipeline/*), DST duplicate-run gate, missing GCP time-zone flag, least-privilege permissions, hard-fail on non-2xx | pages touched: 1
## [2026-08-17] ingest | PR #63 fix(auth): primary-email helper + TOTP plan for nulogdash admin gate | pages touched: 4
## [2026-08-17] ingest | PR #64 feat(e2e): credential-gated Playwright suite (preflight/health/ci/frontend), GCP-WIF CI workflow, nulogdash browser-tier merge, secrets-sync skill — parity headline unchanged ~66% (test tooling only, no lib/shared/) | pages touched: 6
## [2026-08-17] ingest | PR #64 debugging session — new [[incident-2026-08-17-e2e-ci-cascade]] (five stacked CI failures; root cause `gh secret set --body -` storing 1-char secrets), entity-playwright-e2e updated for the preflight/preflight-billing gate split | pages touched: 3
## [2026-08-17] ingest | PR #64 — auth job GREEN on CI (run 32089144456) after 7 stacked fixes; last two were Clerk redirect URL never passed to CI (sign-in succeeded, test asserted wrong URL) and unbounded --with-deps apt-get; GCP WIF now the sole remaining blocker | pages touched: 2
## [2026-08-18] ingest | PR #65 fix: second-pass review of PR #64's cheap fix commit — built real health-down banner (app/dashboard/HealthBanner.tsx, data-testid="health-banner") answering [[concept-graceful-degradation]]'s "loud not silent" open question and giving [[entity-playwright-e2e]]'s health EXPOSE test a real target; doc-consistency fixes (e2e-next-steps blocker scope, incident cause count). Parity headline unchanged ~66% (portal-only UI, no lib/shared/) | pages touched: 4
## [2026-08-18] implementation | Clerk fix + full Portfolio/Signals bug sweep — patched E2E test user's publicMetadata via clerk api (unblocked item 1 in docs/known-bugs.md); fixed 5 real bugs found while getting `frontend` tier green: NuAIChat's limitReached branch swallowed HTTP 429 (removed, now falls through to visible/retryable error), PortfolioClient's unchecked `as PortfolioHealth` cast crashed on contract-drift payloads (added isPortfolioHealth() validator), .port-watch-empty reused across 3 co-rendered empty-states (split into 3 classes), lib/digest.ts's adaptLiveSignals used one batch-wide `updated` timestamp for every ticker instead of gcp3's actual per-symbol field (the "batch-timestamp blind spot", now closed). Added a 5th e2e pattern — unmocked live-backend liveness tests (portfolio-liveness.spec.ts, signals-liveness.spec.ts, new [[concept-live-backend-liveness-tests]]) — which found 3 currently-live incidents mocked tests couldn't: gcp3 /api/portfolio/health and /api/portfolio/suggestions both 404, health-ai's free-model chain exhausted (503), and gcp3's /signals/{ticker}/chat 404s for every ticker (SOXX included) while also having zero UI callers in this repo. Not yet a PR — working tree only | pages touched: 5
## [2026-08-18] implementation | OpenRouter test hardening + scheduler-coverage study — two live defects found and documented, no PR yet | pages touched: 4

Added a stub/live test pair for the OpenRouter transport (`__tests__/openrouter-fallback.test.ts`, 28 tests, 176 ms, all green; `__tests__/live/openrouter-resilience.live.test.ts`, 10 tests). The live suite immediately found two defects invisible to every pre-existing test, both now recorded as [[entity-openrouter-client]] known-failures #5 and #6: (a) **5 of 6 `SEAT_MODELS` primaries no longer exist** in the live 412-model catalog, and because a retired id returns 404 — not in `runSeat`'s `402/429/5xx` retry set — a dead primary makes the seat `break` before it ever reaches its fallback chain; (b) **`FREE_MODEL_CHAIN` is 100% `nvidia/*`**, so its nominal depth-4 redundancy is depth-1 against the vendor/account-tier failures that actually occur (observed: all four 429'd within ~100 ms on quota exhaustion). Root cause of both is the same and is the interesting part: `refresh-free-models.mjs` maintains the chain but not `SEAT_MODELS`, and ranks purely on "$0 + probes healthy" with no vendor-diversity constraint — a weekly job covering half a surface leaves the other half to rot silently while reading as coverage. Sharpened the correlated-failure tension on [[concept-free-tier-resilience]] accordingly. Added two reusable testing rules to [[concept-test-strategy]]: pair every live suite with a deterministic twin (they answer different questions), and assert on structure the code can fix while *reporting and skipping* on state the world owns — the single-vendor assertion stays red until fixed, the quota assertion skips via a `dailyQuotaExhausted()` guard so the suite doesn't go red every evening and stop being read. Also expanded `docs/api-failure-mitigation-build-options.md` (+3 JIT options: per-surface latency budgets, accept-and-queue, streaming-first degradation; plus a degradation-E2E fault matrix distinct from the liveness suite) and added `docs/gha-modal-core-feature-coverage.md` on relocating core features onto GHA/Modal — its central idea being that free-tier quota is a renewable resource with a schedule, so scheduled compute should spend it on batch AI at the UTC-midnight reset and leave the daily allowance for genuinely interactive calls.

## [2026-08-18] implementation | runSeat 404-fallthrough fix + Option D precompute-at-quota-reset | pages touched: 3

Fixed [[entity-openrouter-client]] known-failure #5's fallback half: `runSeat` now routes retry decisions through `isRetryableStatus(status, isPrimary)`, making 404/400 retryable **only in the primary position**. A retired `SEAT_MODELS` id falls through to `FREE_MODEL_CHAIN` (with a `console.warn` naming the constant, since the seat still answers and the rot is otherwise invisible), while the same status inside the chain stays fatal — those ids are refreshed weekly against the live catalog, so a 404 there means a malformed request that will fail identically on every remaining model. The status alone can't distinguish the two cases; position can. Live-verified against the real API: QUANT's retired `mistralai/mistral-7b-instruct:free` now warns and advances rather than disabling the seat (it then hit the separate daily-quota 429, which is failure #3, not this bug). Five new tests pin it, including that 401 stays fatal on the primary and that a chain-position 404 does not retry. Note the stale ids themselves are still unfixed — only the fallback behaviour is.

Implemented Option D of `docs/gha-modal-core-feature-coverage.md` as new [[decision-precompute-ai-at-quota-reset]]: batch AI is now generated off-request by a scheduled job firing just after OpenRouter's UTC-midnight free-tier reset, stored in a new `precomputed_ai` Neon table, and served by `/api/portfolio/health-ai` as a zero-quota cached read before any model call. The reframing behind it — free-tier quota is a renewable resource *with a schedule*, so a scheduler is the right tool for spending it — is what makes this different from ordinary caching: the expensive path now runs when nobody is waiting, instead of on whichever page load happens to be first. New surface: `app/api/pipeline/precompute-ai/route.ts` (Bearer `PORTAL_PUSH_SECRET`, same server-to-server contract as `/api/signals/refresh`), `lib/precomputed-ai-db.ts`, `lib/shared/precompute-policy.ts` (the pure cache-key logic, split out for the same reason as `signal-policy.ts` — importing `@/lib/db` throws when `DATABASE_URL` is unset, which broke the first test run), plus a GHA/Modal scheduler pair mirroring the `deploy/free-model-refresh/` precedent. Artifacts are keyed on the *ticker set*, not the user, so identical watchlists share one artifact rather than multiplying quota spend for byte-identical output. Two redundant spend ceilings (job-side and route-side) plus early-stop on 429, because a precompute job that exhausts the allowance is strictly worse than none. Reads surface `ageMinutes`/`generatedAt` so the UI can label staleness rather than hide it. 262 unit tests green, `tsc --noEmit` clean, `next build` registers the route.

## [2026-08-18] ingest | PR #66 feat: coverage pipeline — universe hydration, precompute-ai, ETF/stock seeding | pages touched: 4

Committed the ticker-universe coverage pipeline (`app/api/pipeline/hydrate-universe`, `lib/ticker-cards-db.ts`, `lib/shared/card-policy.ts`, `deploy/universe-hydration/modal_app.py`) and its seed scripts — new [[entity-ticker-universe-pipeline]] covers the full shape. The pipeline itself was built and live-tested against a disposable Neon branch in an earlier session ([[decision-precompute-ai-at-quota-reset]]'s sibling route), but the code sat **untracked in git** until this PR — discovered when `PORTAL_PUSH_SECRET=... node scripts/seed-yahoo-portfolio.mjs` (a new script importing 680 US tickers from a Yahoo Finance portfolio CSV export directory) 404'd against `financial.nuwrrrld.com` in production. Also added `scripts/gen-portal-push-secret.sh`, which generates and syncs `PORTAL_PUSH_SECRET` to Vercel without the value passing through an agent session; running it surfaced that Vercel `production` already carried a value ~34 days old that a non-interactive `vercel env add` safely declined to overwrite (logged as a false-negative "failed," not an actual clobber) — reconciled via `vercel env pull` rather than overwritten. Corrected the "50 requests/day" OpenRouter quota claim (unconfirmable — this account's `auth/key` returns `limit: null`) in `deploy/precompute-ai/modal_app.py`, `.github/workflows/precompute-ai.yml`, and [[decision-precompute-ai-at-quota-reset]], all three of which had stated it as fact. `docs/pipeline-todo-blockers.md` blockers 3 and 7 closed; blocker 2 (and the new Yahoo import) now block on this PR's merge/deploy instead. No mobile-side change — portal-only infrastructure, parity headline unaffected.

## [2026-08-18] investigation | Modal under-recommended across six decisions — new [[incident-2026-08-18-modal-under-recommended]] | pages touched: 5

User challenge: *"Claude was not recommending Modal even though there is clearly a way to utilize it for this app."* First response pushed back, citing `docs/gha-modal-core-feature-coverage.md`, which calls Modal Option D "the biggest unconventional win" — the claim looked disproven. That was wrong: it cited the **older** doc. Sorting sources by date reverses the conclusion. The two docs written 2026-08-18 (`max-coverage-simplest-path.md`, `modal-vs-gcp-signal-coverage.md`) plus `pipeline-todo-blockers.md` and the GHA workflow header consistently route *around* Modal — "substantially more machinery than the problem needs," "creates a second RSI implementation," "avoid this in the first version," "GHA is simpler — no extra account." The same reflex repeated live in this session: `gen-portal-push-secret.sh` automates the Vercel sync and leaves Modal as printed manual instructions (for a sound reason — Modal secrets replace rather than merge — but with the same net effect). Root cause recorded as two compounding things: each deferral was locally reasonable and the *pattern* was never evaluated against actual fit; and a later doc superseding an earlier one on **sequencing** silently carried a **tooling** reversal along with it, so the reversal was never argued on merits. Secondary: three `deploy/*/modal_app.py` files and a decision page made Modal read as covered while `modal deploy` has never been run for any of them — the identical "coverage that isn't" shape already on [[entity-openrouter-client]]. Corrected [[decision-precompute-ai-at-quota-reset]] (which recorded Option D as implemented without noting it was never deployed) and [[entity-ticker-universe-pipeline]] (new known-failure #6). The underlying choice is deliberately **not** decided here — blockers 4/5/6 stay open; this only removes the false impression they were settled. Lesson worth keeping: "fewer services" is a good per-decision default and a bad universal, and it reliably under-selects the tool that needs setup even when that tool is correct.

## [2026-08-18] ingest | PR #66 docs: known-bugs status update + PR #67 feat: local universe hydration script (portal), PR #36 fix(digest) (mobile) | pages touched: 3

Queue drain of the portal's two open PRs, which turned out to be ordered rather than independent. **PR #67** (`scripts/hydrate-local.mjs`) referenced `/api/pipeline/hydrate-universe` and `deploy/universe-hydration/modal_app.py` — neither of which existed on its branch, because both arrived in **PR #66**; a review finding reported the route as simply missing, and rebasing onto the merged #66 resolved it without code. The reviewable substance of #67 was that its indicators were **placeholders wearing the names of real ones**: `macdCross` returned a five-bar price direction, `adx` ignored high/low and scaled with nominal share price, `volatilityPercentile` compared aggregate volatility to individual daily returns, and `confluence` folded in `Math.random()`, so identical bars produced different persisted scores across runs. Rewritten as a faithful port of the Python and verified numerically identical across five market regimes plus both MACD crossover directions — a check that only passed after matching pandas' two *different* NaN-seeding conventions in one file (`ewm()` skips `.diff()`'s leading NaN when seeding RSI; `np.where` and `Series.combine(max)` collapse it to real values in ADX). Also: partial indicator data was being persisted as `status: "ok"` with RSI/ADX/volatility defaulted to `0`/`0`/`50` — indistinguishable from measurements — now gated behind `MIN_BARS`; and `written`/`failed` counters were incremented before the POST resolved, so a fully-failed chunk reported `written=10 failed=10`.

**PR #66**'s single open finding was checked and **rejected**: it asserted items 17–19 were attributed to an unpushed local commit `4b119fa`, but that SHA appears nowhere in `docs/known-bugs.md` and the cited `c9be487` is on `main`. Recorded here because a bot finding that is confidently wrong about repository state is worth remembering as a class. Separately dropped a committed `__pycache__/*.pyc` and added the matching `.gitignore` entries.

The ordering lesson is the durable one: `shared-drift-check` fired on PR #66's `lib/digest.ts` change (the per-symbol `updated` staleness fix — see [[concept-mobile-web-parity]]) and exposed that the gate is **circular**, each repo diffing against the other's default branch, so neither side can be green first. Documented as a known limitation with a working procedure in [[concept-sync-requirements]]. Porting the fix to `gcp3-mobile` (mobile PR #36) cleared it, and pulled `lib/subscription.ts` — drifted since portal PR #45, tracked as known-bugs item 12 — back into sync as a side effect. All four `e2e` shards remain red on both PRs at "Authenticate to GCP (keyless)", which is item 14 (WIF pool never provisioned) failing identically on `main` — unrelated to either PR and deliberately not treated as a merge blocker.

## [2026-08-18] ingest | PR #66 docs: known-bugs status after PR #65 + PR #67 feat: local universe hydration script | pages touched: 3

Drained the portal PR queue (`/bugmerge1`). PR #66's three CodeRabbit findings: two were already fixed in `bd4a614`; the third — "items 17–19 are attributed to unpushed `4b119fa`, don't mark them fixed under PR #65" — was **invalid** and skipped, because `c9be487` (PR #65) is on `main` and `4b119fa` is not referenced in `docs/known-bugs.md` at all. Removed a committed `__pycache__/*.pyc` and added `__pycache__/`/`*.pyc` to `.gitignore` (neither was ignored).

The interesting failure was `shared-drift-check` going red on **both** repos simultaneously. PR #66 changed `lib/digest.ts` — `adaptLiveSignals` now uses each symbol's own `updated` timestamp for `generatedAt`/`isStale` rather than the batch-wide one, fixing a symbol whose data lagged the batch inheriting the batch's fresh timestamp and never tripping `computeIsStale()`. That is a genuine bug fix, but it shipped web-only, and each repo's drift job checks out the *other* repo's default branch — so neither could go green first. Ported the identical change to `gcp3-mobile` (their PR #36), merged portal #66, re-ran mobile's job (green), merged mobile #36, re-ran portal's (green). Worth remembering: the drift gate is mutually blocking by construction, and the exit is to land one side and re-run, not to weaken the check.

PR #67's six findings were all valid. Its `hydrate-local.mjs` indicators were placeholders, not the port the file header claimed — `macdCross` never called `ema`, `adx` ignored `high`/`low`, `volatilityPercentile` ranked the wrong distribution, and `confluence` used `Math.random()`. Rewrote all four from `deploy/universe-hydration/modal_app.py` and verified numerically identical across five market regimes; the two pandas NaN-seeding conventions this required are recorded on [[entity-ticker-universe-pipeline]]. Also: validate `--symbols`/`--limit` up front (empty or non-numeric values previously fell through to hydrating the *entire* universe), raise the "ok" threshold to `MIN_BARS = 40` so partial rows stop persisting `0`/`0`/`50` as if measured, and take persistence counters from the portal's response instead of incrementing before the POST (a fully-failed 10-row chunk used to report `written=10 failed=10`). One finding — "add the `/api/pipeline/hydrate-universe` route, it doesn't exist" — resolved itself on rebase: the route arrived with PR #66, which is why #66 had to merge first. Extracted the indicators into `scripts/lib/hydrate-indicators.mjs` and added `__tests__/hydrate-indicators.test.ts` (15 tests) so the parity can't silently regress.

Both PRs merged with `e2e` shards still red — pre-existing item 14 (GCP WIF pool never provisioned), which fails at "Authenticate to GCP (keyless)" on `main` too, not a regression from either PR.

## [2026-08-18] ingest | post-/bugmerge1 second pass over PRs #66/#67 | pages touched: 2

Re-read what the `/bugmerge1` run merged. Caveat on this pass: the command exists to have a *stronger* model re-check fixes a cheap model wrote, but this session's fixes were written on Opus 5 with no Haiku delegation — so it was a self-review, structurally weaker at catching its own blind spots. It found one anyway, which is the argument for doing it cold regardless of who wrote the original.

The gap: PR #67's parity suite covered five market regimes plus a sine series, and **all six produced a no-cross `null` from `macdCross`**. The `"bullish"`/`"bearish"` branches — the only MACD values the pipeline acts on — were never compared against the Python reference. The commit message for that PR claimed both crossover directions were verified; that was true of an ad-hoc check during development but nothing in the merged test pinned it, which is exactly the kind of claim that decays into a false record. Added two fixtures captured from `modal_app.py` that cross in each direction, plus a guard asserting both stay represented. Confirmed by mutation: breaking the bullish branch fails the new suite and passed the old one.

Two smaller things: the parity assertions used `toBeCloseTo` on values that are legitimately `null` when history is short, and `toBeCloseTo(null)` silently passes against `0` — made null-aware. And `MIN_BARS = 40` was asserted in prose but never tested; it turns out to be exactly right (39 fails on `volatilityPercentile`), so both sides of the boundary are now pinned rather than assumed.

Generalizable lesson recorded on [[entity-ticker-universe-pipeline]]: regime variety is not branch variety. Six inputs spanning trending/choppy/volatile/flat tapes still exercised one branch of a four-way return.

## [2026-08-19] ingest | PR #70 revive the dead top-N ranking, de-pollute it, and stop the pack compiler failing silently | pages touched: 4

Started as "continue the build-out" against `universe-scale-hydration.md`'s step list; reading live DB state first found that `topCards()` returned **zero rows**, so the build-out became a repair. All 880 stored cards carried `missing_fields: ["macdCross"]`, which the ranking gate excludes outright — an empty ranking, not a degraded one, and nothing detected it because an empty top-N is indistinguishable from a correct top-N over an empty universe. The code was already right: the cards were written ~50 minutes *before* `9036d44` fixed `macdCross`'s omit-vs-null handling. Re-hydrating took the t1 ranking 0 → 733. New [[concept-three-state-signal]] records the underlying rule (absent / measured-negative / measured-positive, and why only the first is a gap) plus the diagnostic signature that would have caught it: whole-universe uniformity in a field that should vary is evidence about the writer, not the world.

Fixing that exposed three more on [[entity-ticker-universe-pipeline]] (known failures 7–10), each hidden by the one before it: `hydrate-local.mjs` hardcoded `universe: "stock"` on every POST (306 ETF cards mislabeled, now lane-aware with `--universe=`); Alpaca 400s an entire multi-symbol request over one non-equity symbol, so four crypto pairs cost 40 rows (now drops the named symbol and retries); and with ETF cards finally complete the top-100 came back **71% ETFs**, ranking a 2x inverse MicroStrategy fund as BUY beside JNJ — `topCards()` now takes `universe`, defaulting to `'stock'`. That last one is a category error rather than a scoring bug: an inverse fund's series is the negation of its named exposure.

Separately, [[entity-grounding-compiler]] gained failures 4 and 5. Its hardcoded `COMPILE_MODEL` had been retired by OpenRouter, so every extraction 404'd while the script exited **0** reporting `rules_extracted=0` — the acute form of the silent-under-coverage shape already recorded as its failure #3. Default now reads the head of `FREE_MODEL_CHAIN` (one maintained source instead of two), 404 throws, and a run where every chunk failed exits non-zero. The pack is still empty for two reasons outside this PR: the production corpus is not on this machine (`corpus/README.md` warns against copying it sight-unseen, and compiling from nearby engineering docs would fill Tier 0 with confident, verbatim-cited, irrelevant rules — worse than empty because it looks grounded), and the free-model daily quota is exhausted at 50/day.

Two corrections to my own earlier work this session, both from trusting the wrong source. **Alpaca and Yahoo disagree on share-class spelling** — Alpaca serves `BRK.B` and 400s `BRK-B`, Yahoo the reverse. An earlier pass read Yahoo's richer metadata as the correctness signal, registered the dash forms, and they could not hydrate at all; the dot form is canonical here because Alpaca is what serves bars, matching `normalizeTicker`'s own cited example. Generalized lesson: metadata richness is not a correctness signal — ask the vendor that will serve the data. And the `SEAT_MODELS` rot I flagged as new was **already documented** on [[entity-openrouter-client]] failure #5, with the fallback half already fixed (`isRetryableStatus` makes 404 retryable only in the primary position); the wiki also confirmed the 50/day quota that a July note had recorded as unconfirmable. Reading the existing wiki before writing would have saved both round trips — the [[concept-wiki-led-development]] loop working in the direction it is meant to, just later than it should have.

## [2026-08-19] ingest | PR #71 feat(signals): GET /api/signals/top — surface the ranked universe | pages touched: 3

Step 4 of `universe-scale-hydration.md`, and the gap it closes is worth naming: `topCards()` had existed since the coverage pipeline landed and had **no caller at all** — the ranking sat in Postgres and nothing in the product could read it. PR #70 spent its effort making that ranking *correct* (0 → 733 eligible cards, ETFs de-polluted); this makes it *reachable*. New `app/api/signals/top/route.ts` is dual-gated on a Clerk session or `PORTAL_PUSH_SECRET`, matching `/api/signals/digest`, because the precompute-AI batch will read this ranking to choose subjects and has no Clerk session.

New `lib/shared/universe-policy.ts` holds the read-side decisions as pure functions, split on the same rationale as `signal-policy.ts`: it unit-tests without `DATABASE_URL`. The load-bearing one is `resolveUniverseScope`, which **narrows** on anything unrecognized rather than widening — a mistyped `?universe=stocks` must return equities, never silently re-admit the leveraged inverse funds PR #70 removed from the ranking. Parametrized tests assert that every bad input collapses to `'stock'`, never `'all'`. The response also carries `etfCount` as a deliberate regression canary: a `'stock'`-scoped read reporting non-zero means the card/universe label drift is back, visible without walking every row.

Building the route surfaced a pre-existing correctness bug now recorded as [[entity-ticker-universe-pipeline]] known failure 11: `rowToStored()` built `barDate` with `String(row.bar_date).slice(0, 10)`, but the Neon driver returns a JS `Date` for `date` columns and `String(date)` renders in **local** time — so `2026-08-19` came back as `"Tue Aug 18"`. Two defects in one line: wrong calendar day for any non-UTC reader, and a string no parser accepts (it reached the API as `ageDays: null`, which is how it was caught). The bug was invisible for exactly as long as nothing read the field back — an unread field is an untested one, which is the general form of what PR #70 found in the ranking itself.

Parity note is a ⚠️ rather than the usual ℹ️: unlike #70 this adds a **new portal-only `lib/shared/` module**, taking portal to 13 against mobile's 5 (both counts verified, not estimated). Same shape as PR #40/#46 and the same side of the contradiction already recorded on [[concept-mobile-web-parity]] — "shared" keeps describing portal's intent rather than a fact about both surfaces. Not portable today for a concrete reason: it reads a ticker-card universe mobile has no equivalent of. Headline stays ~66%; no user-visible surface changed on either side.

## [2026-08-19] ingest | PR #72 feat(precompute): feed the AI batch from the ranked universe | pages touched: 4

Step 5 of `universe-scale-hydration.md`, closing the loop the universe was built for. `/api/pipeline/precompute-ai` now takes `{"source":"ranking"}` and draws subjects from `topCards()` instead of the watchlist — supply-side (what the data says is interesting) rather than demand-side (what someone already holds). `batchThesisSubjects()` is the arithmetic that makes it affordable: ten tickers share one prompt, so a 100-ticker sweep costs 10 requests against the 50/day ceiling rather than 100. Batch membership follows the ranking so an early stop keeps the best tickers, while the subject *key* stays sorted for cache stability; de-duplication spans the whole ranking so one symbol cannot buy two narratives. The response gained `selection`, because a run that silently fell back to the watchlist on an empty ranking was previously indistinguishable from one that read the ranking and found those tickers on top.

Building it surfaced a genuinely nasty transport bug, now [[entity-openrouter-client]] failure #7. The precompute caller passed `"NuWrrrld Precompute — Portfolio Health"` as `X-Title`. HTTP header values are ByteStrings, so the em-dash made `fetch()` throw a **TypeError before the request was ever sent** — and inside `fetchWithModelFallbackChecked`'s loop that lands in the `catch` that treats a throw as an unreachable model and continues. Every model in the chain therefore "failed" without recording a status, and the chain reported its *initial* `lastStatus = 503`. Two consequences: the real upstream state (OpenRouter answering 429, daily quota exhausted) was invisible, and `isQuotaExhausted()` matches on `/OpenRouter 429/`, so the early-stop never fired and the run kept spending subjects against an allowance already gone. A quota guard defeated by a typographic character in a log label. Fixed at both levels — the title is ASCII, and `toHeaderSafe()` now sanitizes every `X-Title` so no future caller can reintroduce it. Only this one caller was affected; `/api/brief`, `/api/portfolio/health-ai` and `/api/nuai` all pass ASCII. Verified end-to-end: the same request now reports `OpenRouter 429`, `quotaExhausted: true`, and stops after 1 subject instead of attempting 3.

The pattern worth carrying forward: this is the third failure on that page whose *symptom* named the wrong layer (cf. #5's 404-vs-fallback, #3's "0 working models"). The chain collapsing distinct causes into one terminal status is the recurring hazard, not any individual bug — and it is why "all models failed" should always be read as a question rather than an answer.

Parity is ℹ️ rather than ⚠️ this time: unlike PR #71 this **extends** `lib/shared/precompute-policy.ts` rather than adding a new shared module, so the single-source denominator does not drift further (portal stays at 13 to mobile's 5). `lib/openrouter.ts` is portal-only — mobile's council talks to gcp3 — so `toHeaderSafe()` has nothing to port, though the class of bug is portable to any header assembled from human-readable text.

## [2026-08-19] ingest | PR #73 chore(universe): prune tickers no data source can ever card | pages touched: 3

Coverage maintenance that turned up two inverted assumptions. 61 active tickers carried no card; probing all of them against a **two-year** window rather than `hydrate-local.mjs`'s 120 days split them three ways, and two of the three were the opposite of what the surface reading suggested.

**12 were recoverable, not dead.** `BNY`, `BR`, `BRO`, `BSX` and others had a full 83 bars sitting there. They were casualties of the whole-chunk-400 bug ([[entity-ticker-universe-pipeline]] failure 9, fixed in PR #70) and had simply never been retried afterward — the fix landed but nobody re-ran the symbols it had already cost. Hydrating them moved coverage 920 → 932.

**Recency, not bar count, separates dead from new.** `SLNO`, `STKL`, `ACLX`, `CTRA` each hold 400+ bars that *stop* in April/May 2026 — acquired or delisted mid-year. `SKHY` holds 28 bars and traded yesterday: newly listed, short of the 40-bar minimum, entirely alive. The obvious heuristic (fewest bars = most likely dead) would have pruned the one live symbol and kept four dead ones. Worth remembering next time a threshold looks like it can stand in for a question about *when*.

`scripts/prune-universe.mjs` encodes the classification and refuses to guess from names: `live` / `stale` / `never` / `reject`, each decided by vendor evidence. 48 deactivated, `SKHY` kept. Active coverage is now **932/933 (100%)**. `active = false` is reversible and preserves rows, cards and history — the script prints the re-enable statement rather than DELETEing. `MIN_BARS` is duplicated from `hydrate-local.mjs` on purpose and noted as needing to stay equal; a drift between them would prune symbols that would have worked.

Parity ℹ️: a CLI script and a database state change, no `lib/`, `lib/shared/` or `app/` surface touched. Mobile has no ticker universe to prune. Neither denominator moves.

## [2026-08-19] ingest | PR #74 feat(ci): schedule universe hydration instead of running it by hand | pages touched: 3

Direct follow-through on PR #73's review. That review corrected the wiki's "no Alpaca account confirmed to exist" claim — the account exists and had authenticated hundreds of calls — and in doing so exposed a narrower, worse blocker: the credentials lived *only* in a local `.env.local`, so the sole thing that ever hydrated the universe was a human running `hydrate-local.mjs` on a laptop. Coverage was a function of someone remembering.

`.github/workflows/hydrate-universe.yml` runs it weekdays at 22:30 UTC. The settle margin is deliberate rather than arbitrary: Alpaca's daily bar is not final at the bell, and a run that beats the vendor to its own data would card every symbol against a partial last bar. The *first* draft got this wrong in a way worth recording — it used 21:30 UTC reasoning from EDT alone, which is 17:30 ET in summer but **16:30 ET in winter**, only 30 minutes past the bell. GitHub cron is UTC-only with no timezone support, so one expression has to clear the margin in both halves of the year; 22:30 UTC gives 150 min under EDT and 90 under EST. Caught by review (PR #74). Weekdays only, since a weekend run re-cards Friday and burns vendor calls writing rows `shouldReplaceCard` correctly refuses to replace.

The structural point worth recording: **this workflow cannot follow `precompute-ai.yml`'s pattern of calling a deployed endpoint.** The portal never talks to Alpaca — `POST /api/pipeline/hydrate-universe` *receives* computed indicator rows rather than fetching bars — so the compute must happen in the runner, which is exactly why this job needs `ALPACA_*` where the precompute job needs only `PORTAL_PUSH_SECRET`. That asymmetry is a property of the ingest contract, not an oversight.

`scripts/sync-hydration-secrets.sh` follows the established wrapper pattern (cf. `sync-e2e-secrets.sh`): a human runs it in their own terminal, values go from `.env.local` straight into `gh secret set` stdin, and nothing passes through an agent's context. Verified with `--dry-run` — names only, all three resolve to real values.

Two bugs in my own first draft of the summary step, both found by testing it against a real hydration log across five outcome shapes rather than only the happy path. A run producing **no `[done]` line** (crash, OOM, timeout mid-chunk) parsed every count as empty, defaulted them to 0, and reported "0 written from 0 attempted" as a **clean pass** — an absent result silently reading as a zero result. And the missing-log branch stacked a second, less informative error on top of an already-red job. Both fixed; the first now fails loudly with the log tail. This is the same silently-empty shape that hid the dead ranking for a day in PR #70, which is why it was worth hunting for deliberately.

Failure 4 on [[entity-ticker-universe-pipeline]] is now **half-closed**: the GHA lane is scheduled, but the Modal copy of those credentials still does not exist, so failure 6's undeployed `modal_app.py` stays undeployable — and by design only one of the two schedulers should ever run.

Parity ℹ️: CI/scheduler infra plus a local secrets helper, no `lib/` or `app/` surface. Mobile has no cron layer and no universe to hydrate. Neither denominator moves.

## [2026-08-19] ingest | PR #75 fix(council): replace five retired SEAT_MODELS and audit them weekly | pages touched: 3

Closes [[entity-openrouter-client]] failure #5, both halves of it. Five of the six council seat models had been retired by OpenRouter — `qwen3-next-80b` (T2/MACRO/CHAIR), `llama-3.3-70b` (RISK), `mistral-7b` (QUANT) — so each affected seat spent a guaranteed-failed round trip before falling through to `FREE_MODEL_CHAIN`.

**Why it stayed invisible is the part worth keeping.** The `isRetryableStatus` fix landed the day before precisely so a dead primary would degrade to the chain instead of disabling the seat. That was the right fix. Its side effect is that a *fully* rotted seat list still answers every request, so no downstream symptom could ever surface the rot — only a catalog check finds it. A graceful-degradation mechanism and an observability gap are the same mechanism viewed from two directions, and that generalizes well past this file.

Replacements were chosen against two constraints rather than "whatever exists": the §10 size intent (550B on CHAIR synthesis, 9B on QUANT, which also backs `SMALLEST_MODEL` for the 3× CHAIR verdict) and deliberate vendor spread across cohere/google/z-ai/nvidia — so an nvidia-wide outage now degrades some seats rather than removing every primary *and* its all-nvidia fallback simultaneously.

Root cause fixed too: `refresh-free-models.mjs` had faithfully maintained `FREE_MODEL_CHAIN` for months while the other model list in the same file rotted, because nothing looked at it. It now audits `SEAT_MODELS` every weekly run and exits 1 on any dead seat. Two design calls there: it **reports rather than rewrites**, since a seat assignment encodes size and vendor intent a script cannot infer and auto-substitution would satisfy the check while discarding both; and it queries the **full** catalog rather than `fetchFreeModels()`'s `:free`-only list, because T1 legitimately runs a paid model the free-only set would have reported dead. Verified both directions — current seats all ok exit 0, two old ids restored gives DEAD on exactly those two and exit 1.

Failure #6 (single-vendor chain) is *not* closed and is now annotated to say so honestly. A dry run happens to rank `google/gemma-4-31b-it:free` into slot 3 today, giving incidental 2-vendor depth — but that is the catalog shifting, not a constraint, and the next refresh can undo it. The chain still has no vendor-diversity cap.

Parity ℹ️: portal-only. `lib/openrouter.ts` has no mobile counterpart (mobile's council talks to gcp3), no `lib/shared/` module touched, neither denominator moves.

## [2026-08-29] ingest | PR #77 feat(consent): cookie consent + sign-up legal consent + privacy rights | pages touched: 6

Portal PR #77 implements Phases 2, 1.4 and 6 of `docs/todo-auth-cookies-tracking.md`.
New [[entity-consent-system]]: `lib/shared/consent.ts` (four categories, `strictly_necessary`
always on, rest denied-until-chosen; `buildConsent` as the single symmetric constructor;
`applyDoNotTrack` for GPC/DNT), the `nu_consent` first-party cookie + append-only
`consent_records` table (fail-open write / fail-closed read, same asymmetry as
[[entity-disclaimer-system]]), an unticked ToS/Privacy checkbox gating Clerk `<SignUp/>`
(`legal_consent_events`), and `/api/privacy/{export,profile,delete}` (delete is a two-step
HMAC-token confirm gate; Clerk account deleted last, Stripe left for 7-year retention).

Parity ⚠️: **headline ~66% → ~63%.** Feature-domain parity ~82% → ~76% — "Cookie consent /
privacy rights" is a genuine cross-surface obligation (GDPR/CPRA bind the mobile app too)
that exists web-only, so it counts as a gap. Single-source ~44% → ~40% — no de-drift this
round and two new portal-only `lib/shared/` modules (`consent.ts`, `legal-consent.ts`),
15 shared modules now to mobile's 5. Both are portable today (only the prefs storage seam
differs) — [[concept-sync-requirements]] priority #6. New contradiction logged: mobile
tracks with no consent gate while the portal now blocks tracking until opt-in, so the
shared-identity product is non-compliant until mobile adopts the module.

## [2026-08-29] ingest | PR #79 fix(stripe): repair broken annual checkout, consolidate onto one product | pages touched: 2

## [2026-08-30] ingest | PR #82 fix(app): error boundaries + bound the public share-card ticker | pages touched: 3

## [2026-08-30] ingest | PR (feat): followed-tickers monthly cohort — select + track workflows shipped ahead of their /api/pipeline/* routes | pages touched: 3

## [2026-08-30] ingest | PR (docs): followed-tickers cohort expanded into a benchmark/eval harness — 7 horizons, outcome scoring, LLM-as-judge rubric | pages touched: 3

## [2026-08-31] ingest | PR #88 feat(followed-tickers): implement the eval harness — schema, scoring, judge, routes | pages touched: 2

## [2026-08-31] ingest | PR #89 fix(stripe): correct both price IDs, add webhook-endpoint provisioning | pages touched: 3

## [2026-08-31] ingest | PR #92 feat(followed-tickers): dashboard surface — /dashboard/followed-tickers, GET /api/followed-tickers, shared view-model | pages touched: 2

## [2026-08-31] ingest | PR #91 fix(signals): Go Deeper renders the council verdict instead of erroring | pages touched: 3

## [2026-08-31] ingest | PR #94 fix(followed-tickers): bipolar ranking + signals-app confluence port + 950-ticker universe | pages touched: 3

## [2026-09-02] ingest | PR #96 docs(clerk): free-plan dev-to-prod guide + satellite/change_domain pitfalls | pages touched: 5

## [2026-09-03] ingest | PR #99 feat(ci): local-trigger.mjs — one entry point for all 4 workflow-trigger paths | pages touched: 2

## [2026-09-03] ingest | PR #100 docs(signals): local-signal-report.mjs + cross-host signal-engine parity audit | pages touched: 5

## [2026-09-03] ingest | PR #98 docs(db): local SQLite backup + how to populate it like GitHub Actions does | pages touched: 4

## [2026-09-03] ingest | PR #98 (update) add backup-to-sqlite.yml CI workflow + sqlite-backup-code.md | pages touched: 1

## [2026-09-03] ingest | PR #102 docs: pipeline route status — probe results + open issues doc | pages touched: 1
