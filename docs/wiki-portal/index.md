# Wiki Index — nuwrrrld-portal

_Last updated: 2026-08-14 (portal PR #59 — afternoon pre-close pipeline workflow + GCP scheduler setup script)_

**New here / cold-started? Read [[START-HERE]] first** — it routes you to the right pages for your task in the right order (step 0: Orient, per [[concept-wiki-led-development]]).

Catalog is organized by page type. Read `index.md` (or [[START-HERE]]) first on any query to find relevant pages, then drill in. This wiki is portal-only; cross-repo references link by path (see [[SCHEMA]] → Cross-Repo Boundary).

**Scope today:** the AI Council + grounding subsystem, the signal/data plane (Signals, Hold/Fold, backtest, caching, portfolio), and Clerk auth + Stripe billing. Still pending: retention and nuai internals — see [[overview]] "Not yet documented."

---

## Start Here / Overview

- [[START-HERE]] — **orient first**: the 60-second orient + a task-routed reading order for cold-started agents
- [[overview]] — stack, system map, current health, what's documented vs. pending

---

## System Entities

One page per named component. These are the hubs — everything links to entities.

**AI Council**
- [[entity-ai-council]] — the six-seat deliberation system; `app/api/council/*` + `lib/openrouter.ts`
- [[entity-openrouter-client]] — `lib/openrouter.ts`; seats, model map, `FREE_MODEL_CHAIN`, `runSeat` fallback

**Grounding**
- [[entity-grounding-tier-ladder]] — `lib/grounding/*` + `lib/council-grounding.ts`; the four-tier deterministic brief resolver
- [[entity-grounding-compiler]] — `scripts/compile_grounding_pack.mjs` + `corpus/`; the one place a model reads the corpus

**Signal Data Plane**
- [[entity-signal-data-plane]] — **canonical signals doc**; `lib/shared/signal-lookup.ts` for the gcp3 fetch-and-shape path and `lib/shared/signalFilters.ts` for shared client-side filtering and sorting
- [[entity-backtest-engine]] — `lib/backtest.ts`; the *separate* hit-rate engine, disabled by default
- [[entity-holdfold-cache]] — `lib/holdfold-cache-db.ts` + `watchlist-store.ts`; Neon L2 cache vs. user-data store
- [[entity-portfolio-intelligence]] — `lib/portfolio.ts`; health score, optimizer, watchlist
- [[entity-live-price-tier]] — `/api/signals/live` + `live_prices`; Finnhub WS lane + the Modal drain cron

**Billing / Auth**
- [[entity-billing]] — Clerk (auth + entitlement source of truth) + Stripe (checkout, portal, webhook sync); `lib/subscription.ts`, `lib/stripe.ts`, `app/api/stripe/*`, `app/api/webhooks/*`
- [[entity-disclaimer-system]] — hash-derived disclaimer text + Neon-backed acknowledgement gating `/verdict`, `/signals`, `/portfolio-intelligence`, `/dashboard/holdfold/[ticker]`; `lib/disclaimer.ts`, `lib/disclaimer-db.ts`

**Dev tooling / automation**
- [[entity-dev-command-suite]] — the `.claude/commands/` catalog: `/pr`, `/sync-pr`, `/bugmerge1`, `/postbugmergerev`, `/friction`, `/suggest-commands`, `/resume-safe`

---

## Concepts

Cross-cutting patterns and design choices.

- [[concept-small-model-prompting]] — the prompt contract every seat follows (write for the worst free model)
- [[concept-verdict-repair-loop]] — deterministic validators turned into a mechanical re-prompt
- [[concept-graceful-degradation]] — every dependency degrades to honest-lesser rather than failing
- [[concept-mobile-web-parity]] — how synced the mobile app and this portal are (~64%, 2026-08-07 after mobile PR #30 + portal PR #51) + full parity matrix
- [[concept-sync-requirements]] — what each surface needs to reach parity (de-drift, port, converge)
- [[concept-cache-then-degrade]] — L1→L2→backend caching, and why caches degrade but user data propagates
- [[concept-test-strategy]] — the three vitest projects, why `live` is opt-in, and why nothing runs the suite in CI
- [[concept-free-tier-resilience]] — the layered machinery keeping $0 inference reliable, and the account-wide quota ceiling it wasn't designed for
- [[concept-wiki-led-development]] — the process where this wiki is the control surface for the work: orient → change → ship → ingest, hook-enforced
- [[concept-bottleneck-command-suggestion]] — the self-improving loop: `/friction` logs pain, `/suggest-commands` mines it and proposes automation
- [[concept-global-automation-layer]] — the `~/.claude/` global tier (rules, hooks, wiki-guard) above the project command suite

---

## Decisions

Recorded design decisions — the *why* behind the architecture.

- [[decision-four-field-verdict-scaffold]] — 4 verdict fields, not 6 (small models drop later directives)
- [[decision-split-chair-synthesis-and-verdict]] — CHAIR calls twice: prose synthesis, then a 3× JSON verdict vote
- [[decision-compile-time-grounding]] — grounding is a weekly build step, not request-time RAG
- [[decision-free-tier-model-chain]] — every model is `:free`; $0 per deliberation
- [[decision-pending-signals-queue]] — watchlist-add enqueues a `pending_signals` row instead of calling gcp3 inline
- [[decision-second-analyze-backend]] — `/api/analyze` calls holdemfoldem-api (a second Cloud Run service), not gcp3-backend — and why that's a deliberate first step, not the end state
- [[decision-afternoon-pipeline-cron-split]] — scheduling split across GHA (afternoon pre-close), GCP Cloud Scheduler (market-clock jobs), and Vercel (pre-market warm + weekly calibrator) instead of one runner

---

## Incidents

- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — both Portfolio Health panels dead on web *and* mobile; the gcp3 route they call was never implemented, and the two sides share no field names
- [[incident-2026-07-27-stripe-checkout-invalid-header]] — production checkout silently failing; a malformed `STRIPE_SECRET_KEY` + a Clerk dev-instance key on the production domain, both root-caused via Vercel telemetry
- [[incident-2026-08-06-bugmerge1-command-file-loss]] — `/bugmerge1`'s own command file vanished mid-run during git checkouts/stash; now guarded by a self-integrity check + out-of-tree backup ([[concept-wiki-led-development]] feedback-loop instance)

The 2026-07-15 chain-of-thought leak remains documented as context inside [[decision-four-field-verdict-scaffold]] and [[entity-ai-council]] rather than as a standalone page (it predates this wiki). Promote it to `incident-2026-07-15-*.md` if a fuller post-mortem is warranted.

---

## Schema

- [[SCHEMA]] — conventions, page types, secret policy, PR-ingest workflow
