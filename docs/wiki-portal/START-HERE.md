---
date: 2026-08-06
type: overview
tags: [orientation, start-here, onboarding, wiki-led, entry-point]
sources: [./index.md, ./overview.md, ./SCHEMA.md, ./concept-wiki-led-development.md]
---

# START HERE — Orient Before You Change

**If you are a cold-started agent or a human returning after time away, read this page first.** It exists to close the "assumes the reader" gap in [[concept-wiki-led-development]]: this wiki only pays off if you *orient* from it before touching code. This is step 0 (Orient) of the loop — do it before the first edit.

Orientation is cheap here by design: the wiki is a connected graph. Land on any page, follow **See also**, and the whole model is one or two hops away. This page is the fastest on-ramp.

## The 60-second orient (always do this)

1. Read [[overview]] — the stack, the system map, current health, and what's *not* yet documented.
2. Skim [[index]] — the full catalog by page type (entities are the hubs; concepts are the patterns; decisions are the *why*; incidents are the scars).
3. Check the newest line in [[log|log.md]] — it names the last change and which pages hold it, so you can orient from **recency** instead of a cold read.

That's enough to know the shape of the system. Then jump to the task-specific route below.

## Orient by task — read these, in this order

| If you're touching… | Read first (in order) | Watch out for |
|---|---|---|
| **AI Council / deliberation** (`app/api/council/*`, `lib/openrouter.ts`) | [[entity-ai-council]] → [[entity-openrouter-client]] → [[concept-small-model-prompting]] → [[decision-four-field-verdict-scaffold]] | prompts target the *worst* free model; verdict has 4 fields not 6 |
| **Grounding** (`lib/grounding/*`, `lib/council-grounding.ts`, `corpus/`) | [[entity-grounding-tier-ladder]] → [[entity-grounding-compiler]] → [[decision-compile-time-grounding]] | grounding is a weekly build step, not request-time RAG |
| **Signals / Hold-Fold / backtest** (`lib/shared/signal-lookup.ts`, `lib/backtest.ts`) | [[entity-signal-data-plane]] (canonical) → [[entity-backtest-engine]] → [[entity-holdfold-cache]] → [[decision-pending-signals-queue]] | backtest is a *separate* engine, disabled by default; caches degrade but user data must propagate ([[concept-cache-then-degrade]]) |
| **Portfolio / watchlist** (`lib/portfolio.ts`) | [[entity-portfolio-intelligence]] → [[entity-holdfold-cache]] → [[incident-2026-07-26-portfolio-health-endpoint-missing]] | the gcp3 Portfolio Health route the panels call was never implemented |
| **Live prices** (`/api/signals/live`, `live_prices`) | [[entity-live-price-tier]] → [[concept-cache-then-degrade]] | Finnhub WS lane + Modal drain cron |
| **Billing / auth** (Clerk, Stripe, `app/api/stripe/*`, `app/api/webhooks/*`) | [[entity-billing]] → [[incident-2026-07-27-stripe-checkout-invalid-header]] | Clerk `publicMetadata.subscription_status` is the entitlement source of truth; a dev-instance key on prod silently killed checkout once |
| **Anything that also exists in the mobile app** | [[concept-mobile-web-parity]] → [[concept-sync-requirements]] | recompute the parity matrix + headline % on both wikis (`~/.claude/rules/mobile-web-wiki-sync.md`) |
| **Free-tier reliability / model chain** | [[concept-free-tier-resilience]] → [[decision-free-tier-model-chain]] → [[concept-graceful-degradation]] | every model is `:free`; the account-wide quota ceiling is the known gap |
| **CLI commands / the dev workflow itself** | [[entity-dev-command-suite]] → [[concept-wiki-led-development]] → [[incident-2026-08-06-bugmerge1-command-file-loss]] | `/bugmerge1` self-protects its own definition file during git plumbing |
| **Automation / removing a bottleneck** (full stack + admin local app) | [[concept-bottleneck-command-suggestion]] → [[concept-global-automation-layer]] → [[entity-dev-command-suite]] | log pain with `/friction`; mine it with `/suggest-commands`; it proposes, you adopt |
| **A long automated run near the token limit** | [[concept-wiki-led-development]] (`/resume-safe`) | checkpoint to `log.md` at a safe boundary; resume re-orients from START-HERE |
| **Tests / CI** | [[concept-test-strategy]] | three vitest projects; `live` is opt-in; nothing runs the suite in CI |

## Before you finish (the other half of the loop)

Orienting is step 0–1. When your change ships, you owe the wiki an **ingest** (step 4) — that's enforced on `gh pr create`/`gh pr merge` by the wiki-guard hook, not optional. See [[SCHEMA]] → "On PR Creation" and [[concept-wiki-led-development]] for the full orient → change → ship → ingest loop.

## See also

- [[concept-wiki-led-development]] — why orientation matters and how the loop is enforced
- [[overview]] — the system map this page routes into
- [[index]] — the full catalog
- [[SCHEMA]] — conventions, page types, secret policy, PR-ingest workflow
