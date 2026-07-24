---
date: 2026-07-20
type: overview
tags: [overview, stack, health, system-map]
sources: [../../package.json, ../../app, ../../lib, PR#35, PR#36, PR#37]
---

# Overview — nuwrrrld-portal

The **web portal** for NuWrrrld Financial — a Next.js 16 app that puts the AI Council, Hold/Fold signals, and portfolio intelligence in the browser. Sibling to the Expo mobile app (`gcp3-mobile`) and the gcp3 backend/pipeline. The AI Council originated in mobile and was ported here.

## Stack

- **Framework**: Next.js `16.2.9`, React `19.2.4` (App Router; `app/api/*` route handlers)
- **Auth**: Clerk (`@clerk/nextjs ^7.5.2`) — entitlements via `publicMetadata.subscription_status`
- **DB**: Neon Postgres (`@neondatabase/serverless ^1.1.0`) — council sessions/verdicts, grounding pack, caches
- **Billing**: Stripe (`^22.2.1`) — checkout, portal, webhooks
- **LLM**: OpenRouter, free-tier only ([[decision-free-tier-model-chain]])

> ⚠️ This repo pins a Next.js version with breaking changes from common training data — consult `node_modules/next/dist/docs/` before writing framework code (per `AGENTS.md`).

## System map

```
Browser (dashboard/*)
  ├── /api/council            single-seat T1/T2 quick-ask   ─┐
  ├── /api/council/deliberate six-seat debate               ─┤─► lib/openrouter.ts ─► OpenRouter (:free)
  │                                                          │      ▲
  │                                                          │      │ per-seat sliced brief
  │                                                          └── lib/council-grounding.ts
  │                                                                 └─► lib/grounding/* ─► Neon grounding_pack
  ├── /api/holdfold, /api/signals/*   ─► gcp3 backend /signals
  ├── /api/portfolio/*                ─► portfolio intelligence
  ├── /api/stripe/*, /api/webhooks/*  ─► Stripe / Clerk
  └── /api/retention/*, /api/nuai     ─► engagement + assistant

CI (GitHub Actions, weekly)
  ├── refresh-free-models.mjs   (Mon 06:17 UTC) ─► FREE_MODEL_CHAIN
  └── compile_grounding_pack.mjs (Mon 06:23 UTC) ─► Neon grounding_pack  [reads corpus/ once]
```

## Current health

**Wired and documented (the AI Council + grounding subsystem):**

- ✅ Six-seat deliberation with per-seat grounding, diff-shaped critique, split synthesis/verdict — [[entity-ai-council]]
- ✅ Four-tier deterministic grounding ladder — [[entity-grounding-tier-ladder]]
- ✅ Weekly compile-time grounding pipeline in CI — [[entity-grounding-compiler]]
- ✅ Free-tier model chain with cron refresh — [[entity-openrouter-client]]

**Wired and documented (the signal data plane):**

- ✅ gcp3 fetch-and-shape read path for Signals / Hold-Fold / per-ticker briefs — [[entity-signal-data-plane]]
- ✅ Neon L2 cache + watchlist store (post-2026-07-15 audit; two failure policies) — [[entity-holdfold-cache]] / [[concept-cache-then-degrade]]
- ✅ Historical hit-rate backtest client (separate engine, disabled by default) — [[entity-backtest-engine]]
- ✅ Portfolio health / optimizer / watchlist type contract — [[entity-portfolio-intelligence]]

**Known gaps / risks:**

- ⚠️ **Production corpus not migrated** — `corpus/` holds sample files only; the compiled pack is a placeholder ([[entity-grounding-compiler]] #1).
- ⚠️ **No live-model golden tests in CI** — parsing/critique/validation logic is unit-tested; whether a real 7B produces parseable output is not (deferred PR #37).
- ⚠️ **CHAIR synthesis is the one hard dependency** — its failure is a 503; everything else degrades gracefully ([[concept-graceful-degradation]]).

**Known gaps / risks (data plane):**

- ⚠️ **Watchlist is not a signal trigger** — adding a ticker persists a row but schedules no signal/backtest compute for it; the "add stock → cache → run signals" loop is not closed ([[entity-portfolio-intelligence]] #1).
- ⚠️ **Backtest engine dark by default** — the track-record UI is invisible unless `SIGNALS_ENGINE_URL` is set ([[entity-backtest-engine]] #1).
- ⚠️ **Per-ticker lookup is uncached** — N Council briefs = N backend round-trips ([[entity-signal-data-plane]]).

**Not yet documented in this wiki** (awaits future ingest):

- `/api/stripe/*`, `/api/webhooks/*` — billing
- `/api/retention/*`, `/api/nuai` — engagement internals

## See also

- [[index]] — full page catalog
- [[entity-ai-council]] — the system's centerpiece
- `gcp3-mobile/docs/wiki-mobile/overview.md` — the mobile sibling
- `gcp3/docs/wiki-gcp3/overview.md` — the backend/pipeline
