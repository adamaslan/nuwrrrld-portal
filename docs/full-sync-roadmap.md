# Full Mobile ⇄ Web Sync — What's Left

Snapshot as of 2026-08-08, after the `/sync-pr` de-drift batch
(`docs/sync-pr-large-scale-run.md`, items #1–4) and the mobile PR #32 tsc
baseline fix. Source of truth for the live numbers is
`docs/wiki-portal/concept-mobile-web-parity.md` +
`docs/wiki-portal/concept-sync-requirements.md` (and their mobile mirrors in
`gcp3-mobile/docs/wiki-mobile/`) — this doc is a point-in-time punch list
synthesized from them, not a replacement.

## Where things stand

**Headline: ~64% synced**, two denominators kept separate:

- **Feature-domain parity ≈ 82%** — 9 of 11 shared product domains exist and
  work on both surfaces. AI Council is architecturally divergent; Nu AI has a
  drifted implementation.
- **Single-source (code-identical) parity ≈ 41%** — the harder number. Most
  of the gap here is portal-only growth in `lib/shared/` (three files with no
  mobile counterpart) plus features that exist on one surface only.

**Shipped this batch:**
- ✅ `lib/subscription.ts` de-drift (mobile PR #29)
- ✅ `lib/shared/prefs.ts` + `signalFilters.ts` reconciled (portal PR #50)
- ✅ `lib/digest.ts` + `lib/signalCard.ts` de-drift, real ticker-precedence bugfix (mobile PR #30 + portal PR #51)
- ✅ Drift-detection CI gate — `lib/shared/` can no longer silently re-drift (mobile PR #31 + portal PR #52)
- ✅ Mobile `tsc --noEmit` baseline fixed, 38→0 errors (mobile PR #32)

## What's needed for full sync

### 1. De-drift — close remaining share-debt

| Item | What's needed | Effort |
|---|---|---|
| `lib/nuai.ts` | Reconcile chat contract (token budget, refusal guardrails, prompt-chip grounding) between mobile's `useNuAI` and portal's `/api/nuai`. Not yet diffed in this batch. | Medium — needs a real contract comparison, likely some behavior drift beyond formatting. |
| `lib/shared/signal-policy.ts` | Portal-only (PR #40): ticker validation, cache-freshness, backoff. Mobile has no read-through cache to apply it to yet — bundle with the "signal cache/queue" port below rather than adopting the file in isolation. | Small once the port below is scoped. |
| `lib/shared/live-price.ts` | Portal-only (PR #40): pure live-price parse/validate. Only worth porting if mobile consumes `/api/signals/live` — see port table. | Small, contingent on the port decision. |
| `lib/shared/holdfold-map.ts` | Portal-only (PR #46). **Not a drop-in port** — mobile's `clients/holdfold.ts` hits a different backend (`EXPO_PUBLIC_HOLDFOLD_BACKEND_URL`) with an incompatible verdict shape (`symbol`/`risk_level`/`volatility_regime`/`atr` vs. `ticker`/`confidenceLabel`/`bias`/`adx`). Requires a backend-unification decision first. | Large — blocked on a product decision, not just code. |

**Mechanism gap:** even fully de-drifted, `lib/shared/` is "CI-enforced
identical" only for the six files the new gate (mobile PR #31 + portal PR #52)
covers. If `nuai.ts` or any future file joins `lib/shared/`, it needs adding
to `scripts/check-shared-drift.mjs`'s `PAIRS` list in both repos, or it will
drift silently again just like `prefs.ts`/`signalFilters.ts` originally did.

### 2. Port — one-surface features

**Portal has, mobile lacks:**

| Feature | To close the gap |
|---|---|
| Backtest (`/api/backtest/[symbol]`) | A mobile screen + `clients/` call, or a recorded decision that backtest stays web-only (heavier UI, desktop-first — the more likely outcome). |
| Watchlist store (`watchlist-store.ts`) | Confirm mobile's `usePortfolio` watchlist and portal's store agree on shape/persistence. Portal's watchlist-add now enqueues a signal refresh (PR #40) — mobile's doesn't. |
| Hold/Fold cache | Decide whether mobile reads portal's cached verdicts or keeps calling its own backend live. |
| Signal cache/queue + drain (PR #40) | `signal-queue.ts`, `signal-policy.ts`, `signal_cache`, `/api/signals/drain`. Real infra work, not a file copy — needs a decision on whether mobile even wants a server-side queue or should stay backend-live. |
| Real-time price tier (PR #40) | Finnhub WS → `/api/signals/live` → `live_prices`. Mobile needs a `clients/` call to `GET /api/signals/live`, or a decision that live quotes stay web-only. |
| Public council demo + share cards (PR #43) | Portal-only by nature (growth/marketing surface). Only relevant if mobile wants an app-store teaser or deep-link share flow — copy the pattern (ticker-only input, fail-closed quota) if so. |
| Daily Brief (`/api/brief`, PR #46) | Needs the `holdfold-map.ts` backend-unification decision first (see above) before mobile can offer the lighter-weight brief format. |

**Portal has, mobile-only performance note (not a port item):** mobile's
`BriefingScreen.getMarketOverview()` still fetches `/market-overview`
unscoped — the same ~16.4s cost portal PR #46 fixed on its side. Worth
profiling whether `sections=brief,ai_summary,sentiment` (skipping `history`)
covers what `MacroPulseCard` actually needs, independent of any sync decision.

**Mobile has, portal lacks:**

| Feature | To close the gap |
|---|---|
| Onboarding (`OnboardingScreen`) | A first-run flow on web, or a recorded decision that the landing page (substantially strengthened in PR #42) already serves that role. |
| Analytics + Sentry (`analytics.ts`, `sentry.ts`) | Portal has no client analytics or error reporting. Add Vercel Analytics + Sentry Next.js SDK for parity. |
| Schwab health (`schwab-health.ts`) | A portal health check for the Schwab integration, if it's meant to surface on web at all. |

### 3. Converge — the AI Council decision

The flagship feature is the least synced domain, and it's a decision gap, not
a code gap:

- **Portal**: self-contained 6-seat OpenRouter `:free` deliberation, server-side, compile-time grounding.
- **Mobile**: a composer that builds prompts and calls the ai-text RAG backend.

**Blocking question:** do the surfaces converge on the portal's OpenRouter
engine (mobile calls a portal `/api/council/*` endpoint), or do they stay
deliberately different products (deep desktop deliberation vs. lightweight
mobile tap-in)? Until a `decision-*.md` exists (both wikis), "council parity"
is undefined and shouldn't count for or against the sync %.

## Suggested priority order

1. **Record the AI Council convergence decision** — cheapest item (no code),
   and it unblocks whether "Daily Brief" / `holdfold-map.ts` work is even
   worth doing, since both touch the same backend-unification question.
2. **`lib/nuai.ts` de-drift** — the last of the "duplicated by filename"
   modules from the original batch; keeps the de-drift work from stalling
   half-finished.
3. **Backend-unification decision for Hold/Fold** — blocks `holdfold-map.ts`
   de-drift, the Daily Brief port, and arguably the AI Council decision above,
   so resolving it early unblocks the most other items.
4. **Observability port (analytics/Sentry → portal)** — self-contained,
   no cross-surface coordination needed, purely additive.
5. **Signal cache/queue + real-time price tier port** — largest single item;
   only start after #1 and #3 are resolved, since the shape of what mobile
   needs depends on those decisions.
6. **Backtest port (or decide against)** — lowest ROI per
   `concept-sync-requirements.md`'s existing priority order; likely stays
   web-only.

## What this doc is not

This is a snapshot, not the live tracker. The wikis
(`docs/wiki-portal/concept-sync-requirements.md` +
`gcp3-mobile/docs/wiki-mobile/concept-sync-requirements.md`) are the
authoritative, continuously-updated version — re-read those before acting on
anything here, since PRs land between snapshots and the parity % moves.
