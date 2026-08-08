# Mobile ⇄ Web Full Sync — What's Left

Status snapshot as of 2026-08-08. Full detail lives in the wikis:
`docs/wiki-portal/concept-mobile-web-parity.md` +
`docs/wiki-portal/concept-sync-requirements.md` (and their mobile mirrors in
`gcp3-mobile/docs/wiki-mobile/`). This is the condensed action list.

## Current state: ~64% synced

- **Feature-domain parity ≈ 82%** — 9 of 11 shared product domains work on
  both surfaces.
- **Single-source (code-identical) parity ≈ 41%** — the harder number; most
  of the gap below.
- A drift-detection CI gate (mobile PR #31 + portal PR #52,
  `scripts/check-shared-drift.mjs`) now fails the build if
  `lib/shared/sse.ts`, `lib/digest.ts`, `lib/signalCard.ts`,
  `lib/subscription.ts`, `lib/shared/prefs.ts`, or
  `lib/shared/signalFilters.ts` drift beyond their documented seams — so the
  de-drift work already done (below) can't silently regress.
- Mobile's `npx tsc --noEmit` baseline is now clean (0 errors, was 38) as of
  mobile PR #32 — this was a type/dependency baseline fix, not a sync item;
  it touched no `lib/shared/` file and doesn't move either percentage.

### Already de-drifted (done)
1. `lib/subscription.ts` — `parseSubscriptionMetadata()` ported (mobile PR #29)
2. `lib/shared/prefs.ts` + `lib/shared/signalFilters.ts` — reconciled (portal PR #50)
3. `lib/digest.ts` + `lib/signalCard.ts` — de-drifted + a real ticker-precedence bug fixed (mobile PR #30 + portal PR #51)
4. Drift-detection CI gate — added (mobile PR #31 + portal PR #52)

## What's left, in priority order

### 1. Record the AI Council convergence decision
The flagship feature is the least synced domain — portal runs a self-contained
6-seat OpenRouter deliberation server-side; mobile taps a RAG backend via a
composer. No decision has been recorded on whether these should converge
(mobile calls a portal `/api/council/*` endpoint) or stay deliberately
different products. **Action:** write `decision-ai-council-convergence.md` in
both wikis. Until this exists, council parity shouldn't count for or against
the sync %.

### 2. Claim portal's real-time signal tier before mobile reimplements it
Portal PR #40 added a whole real-time lane with no mobile counterpart:
`signal-queue.ts`, `signal-policy.ts`, `signal_cache`, `live-price.ts` +
`live-price-db.ts`, `/api/signals/drain` + `/api/signals/live` (Finnhub WS).
Two of these (`lib/shared/signal-policy.ts`, `lib/shared/live-price.ts`)
already sit in the shared folder but are portal-only — pure share-debt.
**Action:** mobile adopts these two modules as-is (ticker validation,
cache-freshness, backoff, live-price parsing) before writing new code that
would just drift again.

### 3. Hold/Fold backend unification (blocks `holdfold-map.ts` adoption)
Portal PR #46 added `lib/shared/holdfold-map.ts` (a `/signals`→verdict
mapper), but mobile's `clients/holdfold.ts` targets a *different* backend
(`EXPO_PUBLIC_HOLDFOLD_BACKEND_URL`) with an incompatible verdict shape
(`symbol`/`risk_level`/`volatility_regime`/`atr` vs.
`ticker`/`confidenceLabel`/`bias`/`adx`). Not a drop-in port.
**Action:** decide whether mobile switches its Hold/Fold backend + verdict
schema to match the portal's before this module becomes adoptable — or record
that they stay separate.

### 4. `lib/nuai.ts` reconciliation
Chat contract has diverged (token budget, refusal guardrails, prompt-chip
grounding). **Action:** diff both copies, align request/response types with
portal's `/api/nuai`.

### 5. Cross-surface ports (lower priority — feature gaps, not drift)
| Feature | Direction | Note |
|---|---|---|
| Backtest | portal → mobile | or explicitly decide web-only |
| Watchlist store | reconcile shape | usePortfolio vs. watchlist-store.ts |
| Public council demo + share cards | portal-only by design | growth surface, not core product |
| Daily Brief (`/api/brief`) | portal → mobile | blocked on item 3 (needs normalized Hold/Fold verdict shape) |
| Analytics + Sentry | mobile → portal | observability parity |
| Onboarding | mobile → portal | landing page may already substitute; undecided |
| Schwab health check | mobile → portal | only if integration surfaces on web |

### 6. Mechanism gap (why drift keeps happening)
`lib/shared/` is meant to be single-sourced, but files inside it have drifted
before (`prefs.ts`, `signalFilters.ts`) and portal-only files have landed
inside it without a mobile counterpart (`signal-policy.ts`, `live-price.ts`,
`holdfold-map.ts`). The CI gate (item done, above) catches re-drift of files
it knows about, but doesn't stop new asymmetric additions. **Action:**
consider whether `lib/shared/` needs to become an actual shared package
(npm workspace or git subtree) rather than two manually-mirrored folders.

## Not sync items (explicitly out of scope here)
- Mobile PR #32's tsc baseline fix (`@/*` alias, `@vercel/node` types,
  `expo-notifications`/`svix` deps, dead-component deletion) — infra hygiene,
  same class as portal PR #48. No shared-code touched.
