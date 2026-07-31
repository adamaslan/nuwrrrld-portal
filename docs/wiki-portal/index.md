# Wiki Index — nuwrrrld-portal

_Last updated: 2026-07-30 (PR #46 /api/brief grounding fix; new lib/shared/holdfold-map.ts, parity matrix gets a Daily Brief row, headline ~60%)_

Catalog is organized by page type. Read `index.md` first on any query to find relevant pages, then drill in. This wiki is portal-only; cross-repo references link by path (see [[SCHEMA]] → Cross-Repo Boundary).

**Scope today:** the AI Council + grounding subsystem, the signal/data plane (Signals, Hold/Fold, backtest, caching, portfolio), and Clerk auth + Stripe billing. Still pending: retention and nuai internals — see [[overview]] "Not yet documented."

---

## Overview

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
- [[entity-signal-data-plane]] — **canonical signals doc**; `lib/shared/signal-lookup.ts` + `signalFilters.ts`, the gcp3 fetch-and-shape read path
- [[entity-backtest-engine]] — `lib/backtest.ts`; the *separate* hit-rate engine, disabled by default
- [[entity-holdfold-cache]] — `lib/holdfold-cache-db.ts` + `watchlist-store.ts`; Neon L2 cache vs. user-data store
- [[entity-portfolio-intelligence]] — `lib/portfolio.ts`; health score, optimizer, watchlist
- [[entity-live-price-tier]] — `/api/signals/live` + `live_prices`; Finnhub WS lane + the Modal drain cron

**Billing / Auth**
- [[entity-billing]] — Clerk (auth + entitlement source of truth) + Stripe (checkout, portal, webhook sync); `lib/subscription.ts`, `lib/stripe.ts`, `app/api/stripe/*`, `app/api/webhooks/*`

---

## Concepts

Cross-cutting patterns and design choices.

- [[concept-small-model-prompting]] — the prompt contract every seat follows (write for the worst free model)
- [[concept-verdict-repair-loop]] — deterministic validators turned into a mechanical re-prompt
- [[concept-graceful-degradation]] — every dependency degrades to honest-lesser rather than failing
- [[concept-mobile-web-parity]] — how synced the mobile app and this portal are (~65%, 2026-07-24) + full parity matrix
- [[concept-sync-requirements]] — what each surface needs to reach parity (de-drift, port, converge)
- [[concept-cache-then-degrade]] — L1→L2→backend caching, and why caches degrade but user data propagates

---

## Decisions

Recorded design decisions — the *why* behind the architecture.

- [[decision-four-field-verdict-scaffold]] — 4 verdict fields, not 6 (small models drop later directives)
- [[decision-split-chair-synthesis-and-verdict]] — CHAIR calls twice: prose synthesis, then a 3× JSON verdict vote
- [[decision-compile-time-grounding]] — grounding is a weekly build step, not request-time RAG
- [[decision-free-tier-model-chain]] — every model is `:free`; $0 per deliberation
- [[decision-pending-signals-queue]] — watchlist-add enqueues a `pending_signals` row instead of calling gcp3 inline

---

## Incidents

- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — both Portfolio Health panels dead on web *and* mobile; the gcp3 route they call was never implemented, and the two sides share no field names
- [[incident-2026-07-27-stripe-checkout-invalid-header]] — production checkout silently failing; a malformed `STRIPE_SECRET_KEY` + a Clerk dev-instance key on the production domain, both root-caused via Vercel telemetry

The 2026-07-15 chain-of-thought leak remains documented as context inside [[decision-four-field-verdict-scaffold]] and [[entity-ai-council]] rather than as a standalone page (it predates this wiki). Promote it to `incident-2026-07-15-*.md` if a fuller post-mortem is warranted.

---

## Schema

- [[SCHEMA]] — conventions, page types, secret policy, PR-ingest workflow
