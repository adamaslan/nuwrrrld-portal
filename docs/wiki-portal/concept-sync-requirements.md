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
| ~~`lib/subscription.ts`~~ | **Done — mobile PR #29 (2026-08-07), gcp-expo1.** Mobile ported `parseSubscriptionMetadata()` verbatim; both copies confirmed byte-identical. Single-surface fix (mobile-only PR — portal needed no change). See [[entity-billing]] and [[incident-2026-07-27-stripe-checkout-invalid-header]]. |
| ~~`lib/shared/prefs.ts`~~ | **Done — portal PR #50 (2026-08-07).** Confirmed to differ only on the intended localStorage/SecureStore storage-backend seam; reclassified ✅ Aligned rather than edited. |
| ~~`lib/shared/signalFilters.ts`~~ | **Done — portal PR #50 (2026-08-07).** Quote-style drift reconciled to mobile's single-quote convention; only the `@/lib/digest` vs `../digest` import-path seam remains, tracked by the drift gate. |
| ~~`lib/shared/signal-policy.ts`~~ | **Done — mobile PR #32 (2026-08-08).** Adopted verbatim (pure ticker validation / cache-freshness / backoff) before mobile grew its own copy. Byte-identical, tracked by the drift gate. Mobile doesn't consume it in a feature yet — see §2's Signal cache/queue row. |
| ~~`lib/shared/live-price.ts`~~ | **Done — mobile PR #32 (2026-08-08).** Adopted verbatim (pure live-price row/batch parsing). Byte-identical, tracked by the drift gate. Mobile doesn't call `/api/signals/live` yet — see §2's Real-time price tier row. |
| `lib/shared/holdfold-map.ts` | New (PR #46), portal-only. Pure `/signals`→verdict mapper. **Not a drop-in share** — mobile's `clients/holdfold.ts` targets a different backend (`EXPO_PUBLIC_HOLDFOLD_BACKEND_URL`) with a different verdict schema entirely (`symbol`/`risk_level`/`volatility_regime`/`atr` vs. this module's `ticker`/`confidenceLabel`/`bias`/`adx`). De-drifting this one requires a backend-unification decision first, not just a port. |
| ~~`lib/digest.ts`~~ | **Re-synced — portal PR #66 + mobile PR #36 (2026-08-18)**, after the per-symbol `updated` staleness fix landed portal-first and drifted for part of one day; see [[concept-mobile-web-parity]]. Originally: **logic done — mobile PR #30 + portal PR #51 (2026-08-07).** Fixed a real ticker-precedence bug (portal's code contradicted its own comment) and ported `dataQualityScore` to mobile; both copies confirmed byte-identical. Still open: physically moving the file into `lib/shared/` (currently reconciled in place at `lib/digest.ts` in both repos) — a bigger, lower-priority restructuring with broad import fallout, not required for parity. |
| ~~`lib/signalCard.ts`~~ | **Logic done — same PRs.** Portal adopted mobile's `encodeURIComponent(signal.id)`; mobile adopted portal's `_baseAppUrl` unused-param convention. Move to `lib/shared/` still open, same as `digest.ts`. |
| `lib/nuai.ts` | Reconcile chat contract (token budget, refusal guardrails, prompt-chip grounding). Portal drives `/api/nuai`; ensure the request/response types match mobile's `useNuAI`. |

**Definition of done:** each file exists once in `lib/shared/`, is byte-identical
as consumed by both repos, and CI fails if the two copies drift (a checksum/diff
gate).

> ✅ **Done — mobile PR #31 + portal PR #52 (2026-08-08).** `scripts/check-shared-drift.mjs`
> (identical in both repos) + a CI job in each that checks out the sibling repo
> and diffs `lib/shared/sse.ts`, `lib/digest.ts`, `lib/signalCard.ts`,
> `lib/subscription.ts` (must be byte-identical) and `lib/shared/prefs.ts` /
> `lib/shared/signalFilters.ts` (must differ only by the documented seam).
> Answers the open contradiction below: "shared" now means "CI-enforced
> identical," not "manually kept in sync."

> ⚠️ **Known limitation — the gate is circular (found 2026-08-18, portal PR
> #66/#67 + mobile PR #36).** Each repo's `shared-drift-check` checks out the
> *sibling's default branch*, so a change to a gated file can only ever be
> green on one side at a time: the first PR to carry it fails against the
> other repo's not-yet-updated `main`, and the mirror PR fails symmetrically.
> Neither can go green first. The working procedure is to open both PRs, merge
> the one whose repo the change originated in while its drift job is still red
> (the failure is expected and its content should be *read* to confirm it names
> only the intended file), then re-run the sibling's job, which now passes.
> Skipping the read is how an unrelated drift would ride along unnoticed —
> the gate's failure text is the check, not its exit code.

## 2. Port — one-surface features

### Portal has, mobile lacks
| Feature | To sync mobile needs… |
|---------|----------------------|
| **Backtest** ([[entity-backtest-engine]]) | A mobile screen + a `clients/` call hitting `/api/backtest/[symbol]`. Or a decision that backtest stays web-only (heavier UI, desktop-first). |
| **Watchlist store** (`watchlist-store.ts`) | Confirm mobile's `usePortfolio` watchlist and portal's `watchlist-store.ts` agree on shape and persistence; ideally share the store logic. Note: portal's watchlist-add now **enqueues a signal refresh** (PR #40) — mobile's does not. |
| **Hold/Fold cache** ([[entity-holdfold-cache]]) | Decide whether mobile should read the same cached verdicts or keep calling the backend live. Today portal caches; mobile does not. |
| **Signal cache/queue + drain** ([[decision-pending-signals-queue]]) | New in PR #40: `signal-queue.ts`, `signal_cache`, `/api/signals/drain`. `signal-policy.ts` (ticker validation, cache-freshness, backoff) is now shared (mobile PR #32) — mobile has the pure logic but not the queue/cache feature built on top of it. |
| **Real-time price tier** ([[entity-live-price-tier]]) | New in PR #40: Finnhub WS → `/api/signals/live` → `live_prices`. `lib/shared/live-price.ts` parsing is now shared (mobile PR #32) — mobile still needs either to read `GET /api/signals/live` or a decision that live quotes stay web-only. |
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

### Cookie consent / privacy rights — portal has, mobile *must* get (PR #77)

New with portal PR #77 and different in kind from the rows above: this is not an
optional port, it is a **compliance obligation that binds both surfaces**. The
mobile app runs `analytics.ts` + `sentry.ts` today with no consent gate at all;
GDPR (opt-in) and CPRA (opt-out + GPC + "Do Not Sell or Share") apply to it
exactly as they apply to the portal.

| Piece | To sync, mobile needs… |
|-------|------------------------|
| **Consent model** | Adopt `lib/shared/consent.ts` verbatim (the four categories, `buildConsent`/`acceptAll`/`rejectAll`, `applyDoNotTrack`, `parseConsent`). Portable today — the only platform seam is where the choice is persisted, and `lib/shared/prefs.ts` (SecureStore) already solves that. Add to the drift gate on adoption. |
| **Legal consent** | Adopt `lib/shared/legal-consent.ts`; add the required unticked ToS/Privacy checkbox to the mobile sign-up flow. A consent event recorded on either surface should satisfy both — the `legal_consent_events` table is already keyed by Clerk `user_id`, not by surface. |
| **Consent capture UI** | A React Native equivalent of `ConsentBanner` + `ConsentPreferences` (first-run banner, per-category screen, a "Cookie preferences" entry in settings). Honor the OS-level tracking signal (iOS ATT / `expo-tracking-transparency`) as the mobile analogue of GPC — same "browser/OS privacy signal wins" rule. |
| **Analytics/Sentry gating** | Wrap every `analytics.ts` / `sentry.ts` init behind `isAllowed(record, "analytics")`. This is the concrete action item that makes the existing "Analytics + Sentry" mobile-only row below safe to *keep* mobile-only. |
| **Privacy-rights endpoints** | `/api/privacy/export|profile|delete` are Clerk-`user_id`-keyed and surface-agnostic — mobile can call the portal's endpoints directly rather than re-implementing them. Deletion cascades across shared tables regardless of which surface triggered it. |

### Mobile has, portal lacks
| Feature | To sync portal needs… |
|---------|----------------------|
| **Onboarding** (`OnboardingScreen`) | A first-run/onboarding flow in the portal, or a decision that web onboarding is handled by the marketing/landing site instead — PR #42 substantially strengthened that landing site (plain-language copy, brand-aligned tokens, a fixed market-data bug, scroll/parallax motion), making "the landing page is portal's onboarding" a more credible answer than before, though still undecided. |
| **Analytics + Sentry** (`analytics.ts`, `sentry.ts`) | Portal has no client analytics or error reporting module found. Add equivalents (or wire Vercel Analytics + a Sentry Next.js SDK) for observability parity — **but gated behind `lib/shared/consent.ts`'s `analytics` category from the start** (PR #77), so the portal doesn't repeat mobile's un-gated tracking. This is Phase 3 of `docs/todo-auth-cookies-tracking.md`. |
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

1. ~~`lib/subscription.ts` de-drift~~ — **done, mobile PR #29 (2026-08-07)**.
2. ~~`lib/shared/prefs.ts` + `signalFilters.ts` de-drift~~ — **done, portal PR #50 (2026-08-07)**.
3. ~~`digest.ts` + `signalCard.ts` de-drift~~ — **done, mobile PR #30 + portal PR #51 (2026-08-07)**. Resolved standing cross-wiki open issue (mobile #6).
4. ~~Add a drift-detection CI gate so `lib/shared/` can't silently diverge again.~~ — **done, mobile PR #33 + portal PR #52 (2026-08-08).** (An earlier mobile PR #31 attempting this went stale — its content had landed on `main` via other PRs by the time it was reviewed — and was closed in favor of #33, rebased clean.) Original `/sync-pr` batch closed out.
5. ~~Adopt `lib/shared/signal-policy.ts` + `live-price.ts` before mobile reimplements them.~~ — **done, mobile PR #32 (2026-08-08).** Byte-identical, tracked by the drift gate. Neither is consumed by a mobile feature yet — that's still #6/#7 below.
6. **Adopt `lib/shared/consent.ts` + `lib/shared/legal-consent.ts` into `gcp3-mobile` and gate `analytics.ts`/`sentry.ts` behind the `analytics` category (PR #77).** Highest-ROI of the open items because it is a compliance obligation, not a nice-to-have, and the modules are portable today (only the prefs storage seam differs). Add both to the drift gate on adoption.
7. **Adopt `lib/shared/attribution.ts` into `gcp3-mobile`.** First-party
   acquisition attribution (UTM/gclid/fbclid/referrer, `nu_attrib` 90-day
   first-touch). Portable today — the only seam is cookie vs. `expo-secure-store`,
   the same seam `consent.ts` has. Lower urgency than #6 (a measurement gap, not
   a compliance one), but it should be adopted *before* mobile grows its own
   attribution, not after.
8. **Give mobile a data-subject-rights path.** The portal now serves
   `/api/privacy/{export,profile,delete,rectify}` against the shared Clerk
   identity; mobile serves none. A user can exercise GDPR access/erasure/
   rectification on web but not in the app, against the same account. Cheapest
   correct fix is for mobile to link out to the portal's endpoints rather than
   reimplement them — the ledger and cascade should stay single-copy. This is a
   compliance asymmetry, same class as #6.
9. Record the AI Council convergence decision.
8. Port observability (analytics/Sentry) to portal — consent-gated from the start (see #6); port backtest to mobile (or decide against). Wire mobile up to consume `signal-policy.ts`/`live-price.ts` if the real-time signal tier is ever ported.

## Where it appears

This page is the actionable half of the parity pair — where
[[concept-mobile-web-parity]] measures, this one plans. The work it describes
lands in:

- `lib/shared/` in both repos — the target destination for every §1 de-drift
  item. `holdfold-map.ts` remains the one portal-only file generating share-debt;
  `signal-policy.ts` and `live-price.ts` were adopted by mobile PR #32.
- `lib/subscription.ts`, `lib/digest.ts`, `lib/signalCard.ts`, `lib/nuai.ts` —
  the duplicated-by-filename modules §1 tracks.
- The `nuwrrrld-fullstack` skill — the intended mechanism for single-sourcing
  cross-surface business logic.
- `~/.claude/rules/mobile-web-wiki-sync.md` — the rule that forces this page to
  be revisited on every PR, so the plan tracks reality rather than aging out.

## Contradictions / tensions

> ✅ Resolved for the eight §1 files with a mobile PR #33 + portal PR #52
> (2026-08-08) CI gate — not a shared package, but "manually kept in sync" no
> longer means "silently," since a CI job now fails the build on drift (running
> on both repos as of PR #33). `signal-policy.ts` + `live-price.ts` joined the
> gate's file list once mobile PR #32 adopted them. `holdfold-map.ts` is the
> one `lib/shared/` file still portal-only and outside the gate — a real
> npm-workspace/git-subtree mechanism remains open if that set grows further.

## See also

- [[concept-mobile-web-parity]] — the measurement this page targets
- [[entity-signal-data-plane]] · [[entity-holdfold-cache]] · [[entity-portfolio-intelligence]] · [[entity-backtest-engine]] · [[entity-ai-council]] · [[entity-billing]]
- `gcp3-mobile/docs/wiki-mobile/concept-backend-is-source-of-truth.md` — the principle behind §1
- `gcp3-mobile/docs/wiki-mobile/overview.md` — open-issue #6 (adapter divergence)
