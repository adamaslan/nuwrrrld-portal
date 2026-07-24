---
date: 2026-07-24
type: concept
tags: [sync, parity, mobile, web, cross-surface, shared]
sources: [../../lib, ../../lib/shared, ../../app/api, ../../app/dashboard, gcp3-mobile/lib, gcp3-mobile/screens]
---

# Concept — Mobile ⇄ Web Parity (% Synced)

Companion page: [[concept-sync-requirements]] — the concrete work each surface needs to close the gap.
Mobile mirror: `gcp3-mobile/docs/wiki-mobile/concept-mobile-web-parity.md`.

## The pattern

NuWrrrld Financial ships as **two surfaces over one product**: the Expo/React
Native app (`gcp3-mobile`) and this Next.js 16 portal (`nuwrrrld-portal`). Both
authenticate with Clerk, entitle off `publicMetadata.subscription_status`, and
present the same product domains (signals, Hold/Fold, portfolio, Nu AI, the AI
Council, billing, retention). "Synced" means a feature behaves the same on both
surfaces **and** its business logic is single-sourced rather than re-implemented
per platform.

The intended sync mechanism is `lib/shared/` — a folder present in *both* repos
holding platform-agnostic modules meant to be identical. Where a module lives in
`lib/shared/` and is byte-identical across repos, that domain is truly synced.
Where the same filename exists in both `lib/` roots but has drifted, the surfaces
agree in intent but not in code.

## Headline: ~62% synced (2026-07-24, after PR #40)

Two different denominators, deliberately kept separate:

- **Feature-domain parity ≈ 82%** — 9 of 11 shared product domains exist and
  work on both surfaces; only the AI Council is architecturally divergent, and
  two domains (Signals/Digest, Nu AI) have drifted implementations. Unchanged by
  PR #40 (which added depth, not a new shared domain).
- **Single-source (code-identical) parity ≈ 38%** (was ~44%) — PR #40 added a
  whole portal-only real-time signal tier (`signal-queue`, `signal-policy`,
  `signal-cache` read-through, `live-price` + `live-price-db`, `/api/signals/drain`
  + `/live`) with **no mobile counterpart**. Two of those new modules
  (`lib/shared/signal-policy.ts`, `lib/shared/live-price.ts`) even sit in the
  supposedly-shared `lib/shared/` folder yet are portal-only — new share-debt.

The blended **~62%** (down from ~65%) reflects the portal pulling further ahead
on the signal data plane: the product still *looks* synced to a user, but the
code gap widened. The risk lives in the gap between those two numbers.

## Domain parity matrix

| Domain | Mobile | Portal | Shared module | Status |
|--------|--------|--------|---------------|--------|
| **Auth (Clerk)** | `@clerk/clerk-expo` | `@clerk/nextjs` | — (SDK differs by design) | ✅ Aligned — same provider + entitlement key |
| **Subscription/billing** | `subscription.ts`, `PaywallScreen`, `useSubscription` | `subscription.ts`, `stripe.ts`, `dashboard/billing`, `upgrade` | `lib/subscription.ts` **identical** | ✅ Synced |
| **Retention** | `retention.ts`, `useStreak`, `TrialExpiryBanner` | `retention.ts`, `/api/retention` | `lib/retention.ts` **identical** | ✅ Synced |
| **Portfolio** | `portfolio.ts`, `PortfolioScreen`, `usePortfolio` | `portfolio.ts`, `/api/portfolio`, `dashboard/portfolio` | `lib/portfolio.ts` **identical** | ✅ Synced ([[entity-portfolio-intelligence]]) |
| **SSE transport** | `shared/sse.ts` | `shared/sse.ts` | **identical** | ✅ Synced |
| **Signals / Digest** | `digest.ts`, `signalCard.ts`, `DigestScreen` | `digest.ts`, `signalCard.ts`, `/api/signals`, `dashboard/signals` | `digest.ts`, `signalCard.ts` **diverged** | 🟡 Partial — adapters drifted; portal now much deeper ([[entity-signal-data-plane]]) |
| **Signal cache / queue** | — | `signal-queue.ts`, `signal-policy.ts`, `signal_cache`, `/api/signals/drain` ([[decision-pending-signals-queue]]) | `signal-policy.ts` in `lib/shared/` but portal-only | ⬅️ Portal-only (PR #40) |
| **Real-time price tier** | — | `live-price.ts`, `live-price-db.ts`, `live_prices`, `/api/signals/live` ([[entity-live-price-tier]]) | `live-price.ts` in `lib/shared/` but portal-only | ⬅️ Portal-only (PR #40) |
| **Nu AI chat** | `nuai.ts`, `NuAIScreen`, `useNuAI` | `nuai.ts`, `/api/nuai`, `dashboard/nuai` | `nuai.ts` **diverged** | 🟡 Partial |
| **Hold/Fold** | `clients/holdfold.ts`, `HoldFoldScreen` | `/api/holdfold`, `dashboard/holdfold`, `holdfold-cache` | none (portal adds cache layer) | 🟡 Partial — portal has cache ([[entity-holdfold-cache]]) |
| **Shared prefs** | `shared/prefs.ts` | `shared/prefs.ts` | **diverged** | 🟡 Partial |
| **Shared signal filters** | `shared/signalFilters.ts` | `shared/signalFilters.ts` | **diverged** | 🟡 Partial |
| **Feedback** | `feedback.ts` | `/api/feedback`, `lib/feedback` | none | 🟡 Present both, unshared |
| **Push** | `pushNotifications.ts` | `/api/push` | none | 🟡 Present both, unshared |
| **Referral / share** | `shareSheet.ts` | `/api/referral`, `dashboard/share` | none | 🟡 Present both, unshared |
| **AI Council** | `clients/council.ts` composer → ai-text RAG backend | 6-seat OpenRouter deliberation, server-side ([[entity-ai-council]]) | none | 🔴 Divergent architectures |
| **Backtest** | — | `/api/backtest`, `backtest.ts` ([[entity-backtest-engine]]) | — | ⬅️ Portal-only |
| **Watchlist store** | (folded into `usePortfolio`) | `watchlist-store.ts` | — | ⬅️ Portal-only |
| **Onboarding** | `OnboardingScreen` | — | — | ➡️ Mobile-only |
| **Analytics / Sentry** | `analytics.ts`, `sentry.ts` | — | — | ➡️ Mobile-only |
| **Schwab health** | `schwab-health.ts` | — | — | ➡️ Mobile-only |

Legend: ✅ synced · 🟡 partial · 🔴 divergent · ⬅️ portal-only · ➡️ mobile-only.

## Contradictions / tensions

> ⚠️ Contradiction: `lib/shared/` is meant to be the single source of truth, but
> `prefs.ts` and `signalFilters.ts` already differ between repos *inside that very
> folder* — and PR #40 added `signal-policy.ts` + `live-price.ts` there with no
> mobile counterpart at all. A "shared" module that only one surface has is a
> standing invitation to drift the moment mobile grows its own copy. See
> [[concept-sync-requirements]].

> ⚠️ Contradiction: the mobile wiki's [[concept-backend-is-source-of-truth]]
> argues for one canonical adapter, yet `digest.ts` / `signalCard.ts` exist as two
> independently-evolved copies. Mobile's `overview.md` open-issue #6 flags exactly
> this divergence.

> ❓ Open question: the AI Council is the flagship feature and is the *least*
> synced — portal runs a self-contained 6-seat OpenRouter debate while mobile taps
> a RAG backend. Is convergence a goal, or are these deliberately different products
> (deep desktop deliberation vs. lightweight mobile tap-in)? Decision not recorded.

## Where it appears

- Shared backbone: `lib/shared/` in both repos (only `sse.ts` is truly shared today)
- Identical logic modules: `lib/subscription.ts`, `lib/retention.ts`, `lib/portfolio.ts`
- The `nuwrrrld-fullstack` skill exists specifically to single-source cross-surface
  business logic and keep Clerk parity — the mechanism this page measures.

## See also

- [[concept-sync-requirements]] — the checklist to raise the number
- [[entity-signal-data-plane]] · [[entity-holdfold-cache]] · [[entity-portfolio-intelligence]] · [[entity-backtest-engine]]
- [[entity-ai-council]] — the divergent flagship
- `gcp3-mobile/docs/wiki-mobile/overview.md` — open-issue #6 (adapter divergence)
- `gcp3-mobile/docs/wiki-mobile/concept-backend-is-source-of-truth.md`
