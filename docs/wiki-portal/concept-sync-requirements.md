---
date: 2026-07-24
type: concept
tags: [sync, parity, requirements, roadmap, mobile, web, shared]
sources: [../../lib, ../../lib/shared, gcp3-mobile/lib, gcp3-mobile/screens]
---

# Concept — What Each Surface Needs to Sync

Companion page: [[concept-mobile-web-parity]] — the current ~60% measurement this
page is a plan to raise. Mobile mirror:
`gcp3-mobile/docs/wiki-mobile/concept-sync-requirements.md`.

## The pattern

Closing the parity gap is not one project — it is three distinct kinds of work,
each with a different owner and risk profile:

1. **De-drift** existing duplicated modules (make "shared" actually shared).
2. **Port** features that exist on only one surface to the other (or record a
   decision that they intentionally stay single-surface).
3. **Converge** the one architecturally divergent domain (the AI Council) or
   formally split it.

Everything below is framed as: *what has to be true for the domain to count as
synced.*

## 1. De-drift — promote to a real single source

These modules are duplicated by filename but have drifted. The target end-state is
one copy in `lib/shared/`, imported by both repos (via a shared package, git
subtree, or the `nuwrrrld-fullstack` skill's single-sourcing workflow).

| Module | What's needed |
|--------|---------------|
| `lib/subscription.ts` | New (PR #45), portal-only. Was byte-identical with mobile until this PR added `parseSubscriptionMetadata()` (validates `publicMetadata.subscription_status` against the known enum, degrades to `free` on malformed data) to the portal copy only. Lowest-effort de-drift on this whole list — port the same function verbatim to mobile's `lib/subscription.ts` to restore identical status. See [[entity-billing]] and [[incident-2026-07-27-stripe-checkout-invalid-header]]. |
| `lib/shared/prefs.ts` | Diff the two copies; reconcile to one. Already lives in `shared/` on both sides, so it should be the *easiest* to fix and is the most embarrassing to leave drifted. |
| `lib/shared/signalFilters.ts` | Same — reconcile filter predicates so a "watchlist"/"muted" filter means the same thing on both surfaces. |
| `lib/shared/signal-policy.ts` | New (PR #40), portal-only. Pure ticker validation / cache-freshness / backoff — no mobile copy yet. **Promote to shared before mobile grows its own**, so it never drifts in the first place. |
| `lib/shared/live-price.ts` | New (PR #40), portal-only. Pure live-price parse/validate. Share if mobile ever consumes `/api/signals/live`. |
| `lib/shared/holdfold-map.ts` | New (PR #46), portal-only. Pure `/signals`→verdict mapper. **Not a drop-in share** — mobile's `clients/holdfold.ts` targets a different backend (`EXPO_PUBLIC_HOLDFOLD_BACKEND_URL`) with a different verdict schema entirely (`symbol`/`risk_level`/`volatility_regime`/`atr` vs. this module's `ticker`/`confidenceLabel`/`bias`/`adx`). De-drifting this one requires a backend-unification decision first, not just a port. |
| `lib/digest.ts` | Resolve the `adaptLiveSignals` error-handling split (throw vs. null) and field mappings flagged in mobile `overview.md` #6. Pick one adapter; move it to `lib/shared/`. |
| `lib/signalCard.ts` | Reconcile card-shape derivation so a signal renders identically. Move to `lib/shared/`. |
| `lib/nuai.ts` | Reconcile chat contract (token budget, refusal guardrails, prompt-chip grounding). Portal drives `/api/nuai`; ensure the request/response types match mobile's `useNuAI`. |

**Definition of done:** each file exists once in `lib/shared/`, is byte-identical
as consumed by both repos, and CI fails if the two copies drift (a checksum/diff
gate).

## 2. Port — one-surface features

### Portal has, mobile lacks
| Feature | To sync mobile needs… |
|---------|----------------------|
| **Backtest** ([[entity-backtest-engine]]) | A mobile screen + a `clients/` call hitting `/api/backtest/[symbol]`. Or a decision that backtest stays web-only (heavier UI, desktop-first). |
| **Watchlist store** (`watchlist-store.ts`) | Confirm mobile's `usePortfolio` watchlist and portal's `watchlist-store.ts` agree on shape and persistence; ideally share the store logic. Note: portal's watchlist-add now **enqueues a signal refresh** (PR #40) — mobile's does not. |
| **Hold/Fold cache** ([[entity-holdfold-cache]]) | Decide whether mobile should read the same cached verdicts or keep calling the backend live. Today portal caches; mobile does not. |
| **Signal cache/queue + drain** ([[decision-pending-signals-queue]]) | New in PR #40: `signal-queue.ts`, `signal-policy.ts`, `signal_cache`, `/api/signals/drain`. `signal-policy.ts` (ticker validation, cache-freshness, backoff) is a **prime de-drift candidate to promote to shared** — mobile has the same needs. |
| **Real-time price tier** ([[entity-live-price-tier]]) | New in PR #40: Finnhub WS → `/api/signals/live` → `live_prices`. Mobile needs either to read `GET /api/signals/live` or a decision that live quotes stay web-only. `lib/shared/live-price.ts` parsing is reusable as-is. |
| **Public council demo + share cards** | New in PR #43: `/api/council/public` (no-login, ticker-only, 1/day/IP), `/api/og/verdict/[ticker]`, `/verdict/[ticker]`. Portal-only by nature (a growth/marketing surface, not core product), but if mobile ever wants an app-store-listing teaser or a deep-link share flow, this is the pattern to copy — same fail-closed-quota / server-built-prompt safety rules should apply. |
| **Daily Brief** (`/api/brief`, PR #46) | Grounded, structured (market overview + Hold/Fold verdicts), 4-sentence one-shot completion — cheap and fast (~0.5–1.3s to gather data) compared to mobile's `BriefingScreen`, which composes a full long-term council prompt from three unscoped fetches. If mobile wants this lighter-weight brief format, it needs its own Hold/Fold data source normalized to this shape first (see §1's `holdfold-map.ts` row) — not a simple port. |

### Mobile-only performance note (not a port item)

`BriefingScreen`'s `getMarketOverview()` (`gcp3-mobile/lib/clients/gcp3.ts`)
fetches `/market-overview` with no `sections=` param — the same ~16.4s
unscoped call PR #46 just fixed on the portal side by adding
`?sections=brief`. Mobile's screen genuinely needs more sections (it also
renders `MacroPulseCard`), so this may not be pure waste — but if
`MacroPulseCard` doesn't need `history` (the most expensive section per the
backend's own `days` param), scoping to `sections=brief,ai_summary,sentiment`
would likely cut this well below 16s with no behavior change. Worth a quick
profiling pass before assuming it's intentional.

### Mobile has, portal lacks
| Feature | To sync portal needs… |
|---------|----------------------|
| **Onboarding** (`OnboardingScreen`) | A first-run/onboarding flow in the portal, or a decision that web onboarding is handled by the marketing/landing site instead — PR #42 substantially strengthened that landing site (plain-language copy, brand-aligned tokens, a fixed market-data bug, scroll/parallax motion), making "the landing page is portal's onboarding" a more credible answer than before, though still undecided. |
| **Analytics + Sentry** (`analytics.ts`, `sentry.ts`) | Portal has no client analytics or error reporting module found. Add equivalents (or wire Vercel Analytics + a Sentry Next.js SDK) for observability parity. |
| **Schwab health** (`schwab-health.ts`) | A portal health check for the Schwab integration, if that integration is meant to surface on web. |

## 3. Converge — the AI Council

The flagship is the least synced domain and needs an explicit decision, not a
silent port:

- **Portal**: self-contained 6-seat OpenRouter `:free` deliberation, server-side,
  with compile-time grounding — [[entity-ai-council]], [[entity-openrouter-client]].
- **Mobile**: `clients/council.ts` composer that builds prompts and calls the
  ai-text RAG backend (`ragChat()`).

**What's needed:** a recorded `decision-*.md` (on both wikis) answering — do the
surfaces converge on the portal's OpenRouter engine (mobile calls a portal
`/api/council/*` endpoint), or do they stay deliberately different (deep desktop
deliberation vs. lightweight mobile tap-in)? Until that decision exists, "council
parity" is undefined and should not be counted for or against the sync %.

## Priority order (highest ROI first)

1. `lib/subscription.ts` de-drift — port `parseSubscriptionMetadata()` to mobile; one function, restores a previously-solved module to identical (PR #45 regression).
2. `lib/shared/prefs.ts` + `signalFilters.ts` de-drift — already in `shared/`, low effort, high symbolic value.
3. `digest.ts` + `signalCard.ts` de-drift — resolves a standing cross-wiki open issue (mobile #6).
4. Add a drift-detection CI gate so `lib/shared/` can't silently diverge again.
5. Record the AI Council convergence decision.
6. Port observability (analytics/Sentry) to portal; port backtest to mobile (or decide against).

## Where it appears

This page is the actionable half of the parity pair — where
[[concept-mobile-web-parity]] measures, this one plans. The work it describes
lands in:

- `lib/shared/` in both repos — the target destination for every §1 de-drift
  item, and the folder whose portal-only files (`signal-policy.ts`,
  `live-price.ts`, `holdfold-map.ts`) generate most of the current gap.
- `lib/subscription.ts`, `lib/digest.ts`, `lib/signalCard.ts`, `lib/nuai.ts` —
  the duplicated-by-filename modules §1 tracks.
- The `nuwrrrld-fullstack` skill — the intended mechanism for single-sourcing
  cross-surface business logic.
- `~/.claude/rules/mobile-web-wiki-sync.md` — the rule that forces this page to
  be revisited on every PR, so the plan tracks reality rather than aging out.

## Contradictions / tensions

> ❓ Open question: is there a shared package (npm workspace / git subtree) planned,
> or does "shared" mean "manually kept in sync"? Manual sync is why `prefs.ts` and
> `signalFilters.ts` already drifted. The de-drift work in §1 is wasted without a
> mechanism to keep them identical.

## See also

- [[concept-mobile-web-parity]] — the measurement this page targets
- [[entity-signal-data-plane]] · [[entity-holdfold-cache]] · [[entity-portfolio-intelligence]] · [[entity-backtest-engine]] · [[entity-ai-council]] · [[entity-billing]]
- `gcp3-mobile/docs/wiki-mobile/concept-backend-is-source-of-truth.md` — the principle behind §1
- `gcp3-mobile/docs/wiki-mobile/overview.md` — open-issue #6 (adapter divergence)
