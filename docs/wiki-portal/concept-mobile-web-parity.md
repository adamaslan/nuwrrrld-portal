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

> ℹ️ **PR #42 (2026-07-24) assessed, no change.** A signed-out landing-page
> revamp (`app/page.tsx`, `app/landing.css`, new `components/landing/*` motion
> primitives) — copy, brand-token alignment, a market-data parsing bug fix, and
> Framer Motion/Lenis polish. Touches no `lib/shared/` module and no
> cross-surface business logic; mobile has no directly analogous public
> marketing surface (its nearest equivalent, `OnboardingScreen`, is already
> tracked below as mobile-only). Headline and matrix are unchanged by this PR.

> ℹ️ **PR #43 (2026-07-24) assessed, minor matrix addition, headline unchanged.**
> Phase 3+4 of the landing revamp: a sticky scrollytelling council demo, a
> RISK-seat spotlight, a "how it works" section, and — the one piece with
> real backend — a no-login "ask the council" public demo
> (`POST /api/council/public`, `public_demo_usage`/`public_demo_cache` tables)
> plus shareable OG verdict cards (`/api/og/verdict/[ticker]`) and public
> `/verdict/[ticker]` pages. This reuses the *existing* portal-only AI Council
> stack (`lib/openrouter.ts`) rather than adding a new shared module — no
> `lib/shared/` file touched — so it doesn't move single-source parity. Added
> a matrix row below since it's a real, if portal-only, extension of the AI
> Council domain (unauthenticated growth/demo surface, not full deliberation).

> ⚠️ **PR #45 (2026-07-27) assessed — new drift in a previously-identical
> module.** A Stripe checkout production incident fix
> ([[incident-2026-07-27-stripe-checkout-invalid-header]]): defensive
> try/catch on the Stripe SDK calls, `/api/health` checks for a malformed
> Stripe key and a Clerk dev-instance key in production, and a new
> `parseSubscriptionMetadata()` in `lib/subscription.ts`. That last change was
> added **only to the portal's copy** — `lib/subscription.ts` was previously
> byte-identical with mobile's (per the matrix row below), so this PR quietly
> creates new single-source drift in a module that was supposed to be the
> easy, already-solved case. No feature-domain change (billing already worked
> on both surfaces); single-source parity nudges down slightly. See
> [[concept-sync-requirements]] §1 for the de-drift task this adds.

> ⚠️ **PR #46 (2026-07-30) assessed — new portal-only `lib/shared/` module, same
> pattern as PR #40.** Fixed `/api/brief`: it was calling a nonexistent
> `/holdfold` endpoint (always 404→null) and fetching `/market-overview`
> without `sections=brief` (16.4s against a 6s timeout, always null) — so on
> every request it silently fell back to a prompt that told the model to
> "cite specific indices, percentages, or verdicts" with none actually
> fetched, and the model dutifully wrote a brief narrating its own missing
> data. Fix extracts the `/signals`→verdict mapping out of
> `app/api/holdfold/route.ts` into **`lib/shared/holdfold-map.ts`** — but
> mobile's own Hold/Fold client (`clients/holdfold.ts`) hits a *different*
> backend entirely (`EXPO_PUBLIC_HOLDFOLD_BACKEND_URL`, not gcp3) with an
> incompatible verdict shape (`symbol`/`risk_level`/`volatility_regime`/`atr`
> vs. portal's `ticker`/`confidenceLabel`/`bias`), so this isn't portable to
> mobile as-is — it just adds a fourth `lib/shared/` file with no mobile
> counterpart (after `signal-policy.ts`, `live-price.ts`; see the
> contradiction below). Separately, mobile's `BriefingScreen` has its own
> independent long-term-brief implementation (`buildLongTermPrompt` composing
> live `getMarketOverview()` + `getMacroPulse()` + `getSignals()` into a
> council prompt) that was never in this matrix — added as its own row since
> it's architecturally divergent from portal's one-shot `/api/brief`, not a
> feature gap. Also notable: mobile's `getMarketOverview()` still fetches the
> **unscoped** `/market-overview` (no `sections=` param) on every
> `BriefingScreen` load — the same ~16s-vs-~0.5s cost this PR just fixed on
> the portal side, but for mobile's full-section long-term-brief use case
> that may be closer to intentional than a bug (see
> [[concept-sync-requirements]] §2).

## Headline: ~60% synced (2026-07-30, after PR #46)

Two different denominators, deliberately kept separate:

- **Feature-domain parity ≈ 82%** — 9 of 11 shared product domains exist and
  work on both surfaces; only the AI Council is architecturally divergent, and
  two domains (Signals/Digest, Nu AI) have drifted implementations. Unchanged by
  PR #40 (which added depth, not a new shared domain).
- **Single-source (code-identical) parity ≈ 36%** (was ~37%) — PR #40 added a
  whole portal-only real-time signal tier (`signal-queue`, `signal-policy`,
  `signal-cache` read-through, `live-price` + `live-price-db`, `/api/signals/drain`
  + `/live`) with **no mobile counterpart**. Two of those new modules
  (`lib/shared/signal-policy.ts`, `lib/shared/live-price.ts`) even sit in the
  supposedly-shared `lib/shared/` folder yet are portal-only — new share-debt.
  PR #45 shaved a further point off: `lib/subscription.ts`, previously one of
  only four truly identical modules, now carries a portal-only
  `parseSubscriptionMetadata()`. PR #46 adds a fourth portal-only file to
  `lib/shared/` (`holdfold-map.ts`) — same share-debt pattern, not portable
  as-is since mobile's Hold/Fold client targets a different backend with an
  incompatible verdict shape.

The blended **~60%** (down from ~61%) reflects the portal continuing to pull
ahead on the signal/Hold-Fold data plane while `lib/shared/` keeps
accumulating portal-only files — the product still *looks* synced to a user,
but the code gap widens with each PR that adds to `lib/shared/` without a
mobile counterpart. The risk lives in the gap between those two numbers.

## Domain parity matrix

| Domain | Mobile | Portal | Shared module | Status |
|--------|--------|--------|---------------|--------|
| **Auth (Clerk)** | `@clerk/clerk-expo` | `@clerk/nextjs` | — (SDK differs by design) | ✅ Aligned — same provider + entitlement key |
| **Subscription/billing** | `subscription.ts`, `PaywallScreen`, `useSubscription` | `subscription.ts`, `stripe.ts`, `dashboard/billing`, `upgrade` ([[entity-billing]]) | `lib/subscription.ts` **diverged (PR #45)** — mobile lacks `parseSubscriptionMetadata()` | 🟡 Partial — was ✅ Synced until PR #45 |
| **Retention** | `retention.ts`, `useStreak`, `TrialExpiryBanner` | `retention.ts`, `/api/retention` | `lib/retention.ts` **identical** | ✅ Synced |
| **Portfolio** | `portfolio.ts`, `PortfolioScreen`, `usePortfolio` | `portfolio.ts`, `/api/portfolio`, `dashboard/portfolio` | `lib/portfolio.ts` **identical** | ✅ Synced ([[entity-portfolio-intelligence]]) |
| **SSE transport** | `shared/sse.ts` | `shared/sse.ts` | **identical** | ✅ Synced |
| **Signals / Digest** | `digest.ts`, `signalCard.ts`, `DigestScreen` | `digest.ts`, `signalCard.ts`, `/api/signals`, `dashboard/signals` | `digest.ts`, `signalCard.ts` **diverged** | 🟡 Partial — adapters drifted; portal now much deeper ([[entity-signal-data-plane]]) |
| **Signal cache / queue** | — | `signal-queue.ts`, `signal-policy.ts`, `signal_cache`, `/api/signals/drain` ([[decision-pending-signals-queue]]) | `signal-policy.ts` in `lib/shared/` but portal-only | ⬅️ Portal-only (PR #40) |
| **Real-time price tier** | — | `live-price.ts`, `live-price-db.ts`, `live_prices`, `/api/signals/live` ([[entity-live-price-tier]]) | `live-price.ts` in `lib/shared/` but portal-only | ⬅️ Portal-only (PR #40) |
| **Nu AI chat** | `nuai.ts`, `NuAIScreen`, `useNuAI` | `nuai.ts`, `/api/nuai`, `dashboard/nuai` | `nuai.ts` **diverged** | 🟡 Partial |
| **Hold/Fold** | `clients/holdfold.ts`, `HoldFoldScreen` — different backend, incompatible verdict shape | `/api/holdfold`, `dashboard/holdfold`, `holdfold-cache`, `/api/brief` (PR #46) | `lib/shared/holdfold-map.ts` in `lib/shared/` but portal-only (PR #46) | 🟡 Partial — portal has cache + shared mapper ([[entity-holdfold-cache]]) |
| **Daily Brief / Market Briefing** | `BriefingScreen` — live council prompt from `getMarketOverview()` + `getMacroPulse()` + `getSignals()` | `/api/brief` — one-shot LLM completion grounded on scoped market data + Hold/Fold verdicts (PR #46) | none | 🔴 Divergent — different data (mobile: full sections + macro; portal: brief-only + verdicts), different output shape (council prose vs. 4-sentence structured brief) |
| **Shared prefs** | `shared/prefs.ts` | `shared/prefs.ts` | **diverged** | 🟡 Partial |
| **Shared signal filters** | `shared/signalFilters.ts` | `shared/signalFilters.ts` | **diverged** | 🟡 Partial |
| **Feedback** | `feedback.ts` | `/api/feedback`, `lib/feedback` | none | 🟡 Present both, unshared |
| **Push** | `pushNotifications.ts` | `/api/push` | none | 🟡 Present both, unshared |
| **Referral / share** | `shareSheet.ts` | `/api/referral`, `dashboard/share` | none | 🟡 Present both, unshared |
| **AI Council** | `clients/council.ts` composer → ai-text RAG backend | 6-seat OpenRouter deliberation, server-side ([[entity-ai-council]]) | none | 🔴 Divergent architectures |
| **Public council demo + share cards** | — | `/api/council/public`, `/api/og/verdict/[ticker]`, `/verdict/[ticker]` (PR #43) | none (reuses `lib/openrouter.ts`) | ⬅️ Portal-only, unauthenticated growth surface |
| **Backtest** | — | `/api/backtest`, `backtest.ts` ([[entity-backtest-engine]]) | — | ⬅️ Portal-only |
| **Watchlist store** | (folded into `usePortfolio`) | `watchlist-store.ts` | — | ⬅️ Portal-only |
| **Onboarding** | `OnboardingScreen` | — | — | ➡️ Mobile-only |
| **Analytics / Sentry** | `analytics.ts`, `sentry.ts` | — | — | ➡️ Mobile-only |
| **Schwab health** | `schwab-health.ts` | — | — | ➡️ Mobile-only |

Legend: ✅ synced · 🟡 partial · 🔴 divergent · ⬅️ portal-only · ➡️ mobile-only.

## Contradictions / tensions

> ⚠️ Contradiction: `lib/shared/` is meant to be the single source of truth, but
> `prefs.ts` and `signalFilters.ts` already differ between repos *inside that very
> folder* — and PR #40 added `signal-policy.ts` + `live-price.ts`, PR #46 added
> `holdfold-map.ts`, all three portal-only with no mobile counterpart. A
> "shared" module that only one surface has is a standing invitation to drift
> the moment mobile grows its own copy — and in `holdfold-map.ts`'s case,
> mobile can't even adopt it without first switching its Hold/Fold backend and
> verdict schema to match portal's. See [[concept-sync-requirements]].

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
- [[entity-signal-data-plane]] · [[entity-holdfold-cache]] · [[entity-portfolio-intelligence]] · [[entity-backtest-engine]] · [[entity-billing]]
- [[entity-ai-council]] — the divergent flagship
- [[incident-2026-07-27-stripe-checkout-invalid-header]] — the PR #45 incident that introduced the `lib/subscription.ts` drift
- [[entity-openrouter-client]] — PR #46's account-wide free-tier quota finding, relevant to any future council-based mobile brief work
- `gcp3-mobile/docs/wiki-mobile/overview.md` — open-issue #6 (adapter divergence)
- `gcp3-mobile/docs/wiki-mobile/concept-backend-is-source-of-truth.md`
