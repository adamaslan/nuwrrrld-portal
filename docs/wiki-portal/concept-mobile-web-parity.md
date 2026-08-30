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

> ℹ️ **PR #48 (2026-08-06) assessed — CI/lint infra only (env-schema validator, CI test job, eslint flat-config fix). No feature-domain or single-source code changes. Headline unchanged at ~60%.**

> ✅ **Mobile PR #29 (2026-08-07) assessed — de-drifts `lib/subscription.ts`, first item of the [[concept-sync-requirements]] §1 priority list.** Ports `parseSubscriptionMetadata()` verbatim from the portal copy into mobile's `lib/subscription.ts`, closing the drift introduced by PR #45. Confirmed byte-identical by diff post-port. Single-surface fix (mobile-only PR, no portal change needed — portal already had this code). No feature-domain change; single-source parity nudges back up.

> ✅ **Portal PR #50 (2026-08-07) assessed — de-drifts `lib/shared/signalFilters.ts` and confirms `lib/shared/prefs.ts`, item #2 of the [[concept-sync-requirements]] §1 list.** `signalFilters.ts` had drifted by quote style only (double vs single); standardized on mobile's single-quote convention, leaving only the necessary import-path seam (mobile's `@/` alias is unconfigured — a separate, pre-existing bug documented in `docs/findings-neon-and-stray-files.html`, not sync-batch scope). `prefs.ts` was assessed and confirmed to differ *only* on the intended localStorage/SecureStore storage-backend seam — reclassified from 🟡 Partial to ✅ Aligned rather than edited, since forcing byte-identity there would break the platform split by design. Single-surface fix (portal-only PR — mobile's copy needed no change).

> ✅ **Mobile PR #30 + portal PR #51 (2026-08-07) assessed — de-drift `lib/digest.ts` (`adaptLiveSignals`) and `lib/signalCard.ts`, resolving open-issue #6, item #3 of [[concept-sync-requirements]] §1.** This was real functional drift, not formatting: portal's ticker-precedence code (`s.symbol ?? symbolKey`) contradicted its own comment claiming the map key is authoritative — mobile's precedence was actually correct and portal was fixed to match (a genuine bug fix, not just reconciliation). Portal's `dataQualityScore` field (backend-reported freshness, taking precedence over the client-side staleness heuristic) is now ported to mobile, since both adapters target the same GCP3 `/signals` API. Mobile's more defensive entry-filtering and trimmed/filtered indicators/reasons were adopted by portal. `signalCard.ts`: portal adopted mobile's `encodeURIComponent(signal.id)` URL-safety fix; mobile adopted portal's `_baseAppUrl` unused-param convention. Both files confirmed byte-identical post-merge. First dual-surface (two-PR) item in this batch — items #1–2 were single-surface.

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

> ✅ **Portal PR #52 (2026-08-08) assessed — drift-detection CI gate, item #4 of
> [[concept-sync-requirements]] §1.** Adds `scripts/check-shared-drift.mjs` plus
> a CI job that checks out `gcp3-mobile` and fails the build if `lib/shared/sse.ts`,
> `lib/digest.ts`, `lib/signalCard.ts`, or `lib/subscription.ts` isn't
> byte-identical, or if `lib/shared/prefs.ts` / `lib/shared/signalFilters.ts`
> drift beyond the documented localStorage/SecureStore + import-path seam.
> Also fixes two CodeRabbit-flagged bugs from its own review: `lib/digest.ts`'s
> `symbolKey || entry.symbol` never fell back to `entry.symbol` for
> whitespace-only keys (symbolKey, an object key, is always truthy) — now
> trimmed first; and the drift script's `stripCommentsAndImports` blindly
> dropped every import line before comparing `signalFilters.ts`, so a changed
> binding would've passed the gate as equal — now only the documented
> `@/lib/digest` vs `../digest` module specifier is normalized away, bindings
> stay in the comparison.

> ℹ️ **Mobile PR #32 (2026-08-08) assessed — tsc baseline fix, one bundled shared-drift fix. Headline unchanged at ~64%.** Resolved all 38 pre-existing `npx tsc --noEmit` errors on the mobile repo's baseline: missing `@/*` path alias, `@vercel/node` types on `api/*.ts`, missing `expo-notifications`/`svix` dependencies, deleted three dead components, plus type-safety fixes in `lib/api.ts` and `lib/auth-provider.tsx` — same infra-only class as portal PR #48. Also ported this repo's `lib/digest.ts` fix from PR #52's CodeRabbit review to keep the two copies byte-identical. Notably, this PR also adopted `lib/shared/signal-policy.ts` + `lib/shared/live-price.ts` verbatim from the portal — see the next entry, since that's the parity-moving part.

> ✅ **Mobile PR #32 (signal-policy/live-price adoption) + mobile PR #33 (drift-gate CI, 2026-08-08) — item #5 of [[concept-sync-requirements]] §1, closes the `lib/shared/signal-policy.ts` + `lib/shared/live-price.ts` share-debt PR #40 created.** Both pure, dependency-free modules (ticker validation, cache freshness/backoff, live-price row/batch parsing) are now byte-identical copies in `gcp3-mobile/lib/shared/`, tracked by the drift gate on both sides. Mobile doesn't yet *consume* either module (no live-price feed wired up on this surface), but landing them now — rather than mobile writing its own version later — is exactly the "adopt before drift" ordering [[concept-sync-requirements]] §1 recommends. Mobile PR #33 also finally adds the drift-gate CI job to `gcp3-mobile` itself (it existed only on the portal side after #52) plus a real `usePortfolio`/`PortfolioScreen` fix (a 204 empty watchlist was showing "health score unavailable" instead of "add tickers to get scored"). PR #33 supersedes an earlier stale mobile PR #31 whose wiki/code content had already landed on `main` via other merged PRs — only the still-missing CI workflow and portfolio fix were carried forward.

> ℹ️ **Portal PR #56 (2026-08-11) assessed — portal-only, headline unchanged at ~66%.** Adds [[entity-disclaimer-system]] (hash-derived disclaimer text + Neon acknowledgement, gating `/verdict`, `/signals`, `/portfolio-intelligence`, `/dashboard/holdfold/[ticker]`) and a per-ticker live-analysis panel calling the *second signal-data* backend (`holdemfoldem-api` via `MCP_ANALYZE_URL`, see [[decision-second-analyze-backend]]) — not `gcp3-backend`, and not shared with mobile. The one new `lib/shared/` file this PR adds, `analyze-policy.ts`, is pure cache-key derivation with no mobile counterpart yet, same starting state `signal-policy.ts` was in before mobile PR #32 adopted it — a parity candidate for a future PR, not this one. No existing `lib/shared/` module touched; single-source parity unaffected.

> ℹ️ **Portal PR #59 (2026-08-14) assessed — CI/scheduler infra only, headline unchanged at ~66%.** Adds `afternoon-pipeline.yml` (GitHub Actions cron) and `setup-schedulers.sh` (GCP Cloud Scheduler provisioning) — see [[decision-afternoon-pipeline-cron-split]]. Touches no `lib/`, `lib/shared/`, or `app/` code; nothing here is mobile-reachable or mobile-relevant (mobile has no equivalent server-side cron layer to sync against). Neither denominator moves.

> ℹ️ **Portal PR #64 (2026-08-17) assessed — test tooling only, headline unchanged at ~66%.** Adds [[entity-playwright-e2e]] (the `e2e/` Playwright suite, `e2e-resiliency.yml`, `sync-e2e-secrets.sh`) and one `__tests__/digest-adapt.test.ts` addition pinning `adaptLiveSignals`'s existing batch-wide `generatedAt` behavior. Touches no `lib/shared/` module and adds none — the fault-injection suite asserts against portal-only UI (`app/dashboard/*`), and the digest-adapt test pins behavior already in `lib/digest.ts`, unchanged by this PR. Same shape as PR #59: portal-only tooling, no mobile-reachable code, neither denominator moves. `gcp3-mobile` has no Playwright/e2e layer of its own to compare against yet — a parity candidate only if/when mobile adopts an equivalent test tier, not before.

> ℹ️ **Portal PR #65 (2026-08-18) assessed — portal-only UI + docs, headline unchanged at ~66%.** Second-pass review of PR #64's cheap fix commit. Adds `app/dashboard/HealthBanner.tsx` (a client component polling `/api/health`, the UI end of [[concept-graceful-degradation]]) so the [[entity-playwright-e2e]] health EXPOSE test has a real `data-testid="health-banner"` target instead of asserting against a selector nothing rendered; plus doc-consistency fixes (`e2e-next-steps.md` blocker scope, incident cause count). Touches no `lib/shared/` module and no cross-surface business logic — the banner is a dashboard-only surface with no mobile counterpart (mobile has no `/api/health` dashboard probe). Same shape as PR #59/#64: portal-only, neither denominator moves. A parity candidate only if mobile later grows an equivalent health-status surface.

> ℹ️ **Portal PRs #66 + #67 and mobile PR #36 (2026-08-18) assessed — headline unchanged at ~66%, but one shared module was re-synced.** Portal PR #66 landed the coverage pipeline ([[entity-ticker-universe-pipeline]], precompute-AI, ETF/stock seeding) and, in passing, changed `lib/digest.ts`: `adaptLiveSignals` now derives `generatedAt`/`isStale` from each symbol's own `updated` field, falling back to the batch-wide timestamp only when a symbol omits one. That closed a real defect — a symbol whose data lagged the batch inherited the batch's fresh timestamp and never tripped `computeIsStale()` — but it landed web-only, so the drift gate went red on **both** repos at once, each comparing against the other's `main`. Mobile PR #36 ported the same fix verbatim, which cleared the deadlock and restored `digest.ts` to byte-identical. No new shared module and no new shared domain, so neither denominator moves; this is a *repair* of existing single-source parity, not an extension of it. Portal PR #67 (`scripts/hydrate-local.mjs`) is portal-only tooling — a local runner for the hydration pipeline whose indicator math is now pinned to the Modal Python implementation by `__tests__/hydrate-indicators.test.ts`; mobile has no counterpart and needs none.

> ✅ **Portal PR #66/#67 + mobile PR #36 (2026-08-18) assessed — `lib/digest.ts` re-drifted and re-synced within the same day, headline unchanged at ~66%.** Portal PR #66 changed `adaptLiveSignals` to read each signal's own `updated` field, falling back to the batch-wide timestamp only when a symbol omits one — the "batch-timestamp blind spot", where a symbol whose data lagged the batch inherited the batch's fresh timestamp and never tripped `computeIsStale()`. This is the behavior [[entity-playwright-e2e]]'s `signal-timing.spec.ts` DIAGNOSE test was written to expose, and the behavior portal PR #64's `__tests__/digest-adapt.test.ts` had *pinned as correct* — so the pin described a bug, not a contract. Landing it portal-only tripped `shared-drift-check` on both repos at once, and revealed a **circular gate**: each repo's drift job checks out the *other's default branch*, so with the fix on only one side neither PR could go green first. Broken by porting the identical change to mobile (mobile PR #36) and merging portal #66 first, then re-running mobile's job. Post-merge both copies are byte-identical again and `lib/subscription.ts` — open item 12, drifted since portal PR #45 — came back into sync in the same pass. Neither denominator moves: `digest.ts` was already counted as single-source, and this restored that state rather than adding a module. Worth noting as the first drift caught *by the gate rather than by review*, which is the gate working as designed.

> ℹ️ **Portal PR #67 (2026-08-18) assessed — portal-only local tooling, headline unchanged at ~66%.** Adds `scripts/hydrate-local.mjs`, a JS re-implementation of [[entity-ticker-universe-pipeline]]'s indicator math (`deploy/universe-hydration/modal_app.py`) for running hydration against a local dev server. Review found the first cut shipped *placeholder* indicators — `macdCross` returned a five-bar price direction rather than a signal-line crossover, `adx` ignored high/low and scaled with nominal share price, `volatilityPercentile` ranked aggregate volatility against individual daily returns, and `confluence` mixed in `Math.random()`, making persisted scores non-reproducible. Replaced with a faithful port verified numerically identical to the Python across five market regimes and both crossover directions, including pandas' `ewm()` NaN-seeding conventions (`.diff()`'s leading NaN is *skipped* when seeding RSI, but `np.where`/`Series.combine(max)` collapse it to a real 0.0/high-low value in ADX — two different conventions in one file). No mobile counterpart: mobile has no hydration tooling and does not compute indicators client-side. **This is the second copy of the indicator math**, exactly the "creates a second RSI implementation" cost [[incident-2026-08-18-modal-under-recommended]] records as an argument *against* routing around Modal — the duplication is now real rather than hypothetical, and is a de-drift candidate should a third consumer appear.

> ℹ️ **Portal PR #70 (2026-08-19) assessed — portal-only pipeline repair, headline unchanged at ~66%.** Extends `scripts/hydrate-local.mjs` (the PR #67 tooling above) and the [[entity-ticker-universe-pipeline]] behind it: lane-aware `stock`/`etf` hydration so ETF cards stop being labeled as stocks, chunk-resilient Alpaca fetching (one non-equity symbol was 400-ing an entire 10-symbol request), a `universe` filter on `topCards()` defaulting to `'stock'` after inverse/leveraged ETFs turned up ranked as BUY recommendations, and fixes to `scripts/compile_grounding_pack.mjs` whose hardcoded model id had been retired by OpenRouter. Adds [[concept-three-state-signal]]. All server-side pipeline and CLI work — no `lib/shared/` module touched, no `app/` surface, nothing mobile-reachable; mobile has no ticker universe, card ranking, or grounding compiler to compare against. Same shape as #59/#64/#65/#67: neither denominator moves. The one portable piece is the *rule* in [[concept-three-state-signal]] (absent ≠ measured-negative ≠ measured-positive), a data-contract principle worth carrying across if mobile ever grows its own signal-ingest path — not shared code.

> ⚠️ **Portal PR #71 (2026-08-19) assessed — a *new portal-only* `lib/shared/` module, headline unchanged at ~66% but the single-source denominator drifts again.** Adds `GET /api/signals/top` (the first caller of `topCards()`; until now the ranking existed in the database and nothing in the product read it) and **`lib/shared/universe-policy.ts`** holding its pure decisions — scope, horizon, limit, strong-card threshold, card age, page summary. Also fixes a `barDate` off-by-one-day bug in `rowToStored()` ([[entity-ticker-universe-pipeline]] known failure 11).
>
> The parity-relevant part is the new `lib/shared/` file. This is the same shape as PR #40's and PR #46's additions and it lands on the same side of the contradiction recorded below: portal now has **13** modules under `lib/shared/` against mobile's **5**, so "shared" continues to describe *portal's* intent rather than a fact about both surfaces. `universe-policy.ts` is not portable today for a concrete reason rather than a stylistic one — it reads a ticker-card universe mobile has no equivalent of (no `ticker_universe`, no `ticker_cards`, no ranking) — so this is a parity *candidate* only if mobile grows a coverage layer, not a de-drift task anyone should pick up now. Feature-domain parity is untouched: no user-visible surface changed on either side.

> ℹ️ **Portal PR #72 (2026-08-19) assessed — portal-only pipeline + a shared-module *fix*, headline unchanged at ~66%.** Adds `{"source":"ranking"}` to `/api/pipeline/precompute-ai` so the AI batch draws subjects from [[entity-ticker-universe-pipeline]]'s ranking instead of the watchlist, with `batchThesisSubjects()` packing ten tickers per prompt (a 100-ticker sweep costs 10 requests against the 50/day ceiling, not 100). Extends the existing `lib/shared/precompute-policy.ts` rather than adding a new shared module — so unlike PR #71 the single-source denominator does **not** drift further; portal stays at 13 shared modules to mobile's 5.
>
> The one change with cross-surface reach is `toHeaderSafe()` in `lib/openrouter.ts` ([[entity-openrouter-client]] failure #7): a non-ASCII `X-Title` made `fetch()` throw before sending, which the fallback chain reported as "all models failed" with the wrong status. `lib/openrouter.ts` is portal-only — mobile's council talks to gcp3, not OpenRouter directly — so there is nothing to port. But the *class* of bug is portable and worth knowing on both sides: any header value assembled from human-readable text needs the same guard, and mobile's clients do set custom headers.


> ℹ️ **Portal PR #73 (2026-08-19) assessed — data-plane maintenance, headline unchanged at ~66%.** Adds `scripts/prune-universe.mjs`, which deactivates tickers no data source can card (48 pruned, active coverage 920/981 → 932/933), and recovers 12 that were casualties of an already-fixed bug. Touches no `lib/`, no `lib/shared/`, and no `app/` surface — a CLI script and a database state change. Mobile has no ticker universe to prune. Neither denominator moves.


> ℹ️ **Portal PR #74 (2026-08-19) assessed — CI/scheduler infra only, headline unchanged at ~66%.** Adds `.github/workflows/hydrate-universe.yml` (weekday scheduled hydration of the ticker universe) and `scripts/sync-hydration-secrets.sh` (the repo's variable contract for it, wrapping the shared secrets-sync script). Same shape as PR #59's scheduler work: server-side scheduling and a local secrets helper, touching no `lib/`, `lib/shared/`, or `app/` code. Mobile has no equivalent server-side cron layer and no ticker universe to hydrate, so this creates no gap and closes none. Neither denominator moves.


> ℹ️ **Portal PR #75 (2026-08-19) assessed — portal-only AI infrastructure, headline unchanged at ~66%.** Replaces five retired `SEAT_MODELS` ids in `lib/openrouter.ts` and teaches `scripts/refresh-free-models.mjs` to audit that list weekly ([[entity-openrouter-client]] failure #5, now resolved). `lib/openrouter.ts` is portal-only — mobile's council talks to gcp3 rather than OpenRouter directly — so there is nothing to port and no `lib/shared/` module is touched. Neither denominator moves. The transferable part is the *failure mode*, not the code: a graceful-degradation fix (a dead primary falling through to a fallback chain) made a fully-rotted config invisible, because a degraded seat answers exactly like a healthy one. Any surface with a fallback chain should expect that trade.


> ⚠️ **Portal PR #77 (2026-08-29) assessed — a new cross-surface *obligation* domain lands web-only, and two more portal-only `lib/shared/` modules. Headline drops to ~63%.** Adds cookie/tracking consent infrastructure (`ConsentBanner` + `ConsentPreferences` mounted in the root layout, the `nu_consent` first-party cookie via `POST /api/consent`, `consent_records` + `legal_consent_events` tables), an express ToS/Privacy checkbox gating Clerk `<SignUp/>` (`LegalConsentGate` → `/api/legal-consent`), and the data-subject-rights endpoints the privacy policy already promises (`/api/privacy/export|profile|delete`, the last a two-step HMAC-token confirm gate).
>
> Two things move the number. First, **`lib/shared/consent.ts` and `lib/shared/legal-consent.ts` are new** — pure, deliberately written to be mirrored in `gcp3-mobile`, but not yet ported. Portal is now at **15** modules under `lib/shared/` against mobile's **5**; same standing-drift-invitation shape as `signal-policy.ts`/`live-price.ts` before mobile PR #32, and the same remedy applies ("claim the module before mobile grows its own copy" — [[concept-sync-requirements]]). Unlike `universe-policy.ts` or `holdfold-map.ts`, these two *are* portable today: consent has no backend or schema dependency mobile lacks, only a storage seam (`lib/shared/prefs.ts` / expo-secure-store) already solved elsewhere in this matrix.
>
> Second, consent capture is a **genuine cross-surface obligation** — GDPR/CPRA apply to the mobile app too — so it enters the feature-domain denominator as a real gap, not a portal-only extension like Backtest or the public council demo. Mobile has `analytics.ts` + `sentry.ts` today (tracking with *no* consent gate); this PR makes the portal the only surface that asks. New matrix row below, ⬅️ portal-only but flagged as a required port, not an optional one.

> *(Superseded: PR #77 alone took the headline ~66% → ~63%; PRs #78/#79 and mobile PR #39 then moved it to the current figure below.)*

## Headline: ~62% synced (2026-08-29, after portal PRs #77/#78/#79 + mobile PR #39 — consent/DSAR land web-only, `attribution.ts` mirrored to mobile)

Two different denominators, deliberately kept separate:

- **Feature-domain parity ≈ 76%** (was ~82%) — 9 of 12 shared product domains
  exist and work on both surfaces. PR #77 adds a 12th, **Cookie consent /
  privacy rights**, a real cross-surface obligation (GDPR/CPRA bind the mobile
  app too) that today exists on the portal only — counted as a gap, not a
  portal-only bonus. The AI Council is still architecturally divergent; Nu AI is
  still drifted.
- **Single-source (code-identical) parity ≈ 40%** (was ~44%) — no module was
  de-drifted or adopted this round, and PR #77 adds two more portal-only files
  under `lib/shared/` (`consent.ts`, `legal-consent.ts`), so the denominator
  grows while the numerator holds; portal now carries 15 `lib/shared/` modules
  to mobile's 5. Prior progress unchanged: mobile PR #29
  ported `parseSubscriptionMetadata()`; portal PR #50 reconciled
  `signalFilters.ts` and confirmed `prefs.ts`'s seam; mobile PR #30 + portal
  PR #51 de-drifted `digest.ts`/`signalCard.ts` (open-issue #6), including a
  genuine bug fix (portal's ticker-precedence code contradicted its own
  documented intent) and porting portal's `dataQualityScore` field to mobile;
  mobile PR #32 adopted `lib/shared/signal-policy.ts` + `lib/shared/live-price.ts`
  verbatim, closing the two-module share-debt PR #40 created (mobile has the
  code but not yet the feature — see the matrix row below). Still owed: PR #40's
  wider real-time signal tier (`signal-queue`, `signal-cache` read-through,
  `/api/signals/drain` + `/live`) still has no mobile counterpart, and PR #46
  adds a fourth portal-only `lib/shared/` file (`holdfold-map.ts`), not portable
  as-is since mobile's Hold/Fold client targets a different backend with an
  incompatible verdict shape.

The blended **~63%** (down from ~66%) reflects the earlier de-drift batch
progress, minus PR #77's two effects: a new required cross-surface domain that
exists on one surface, and two more unadopted `lib/shared/` modules. The blended
number sat at ~66% from 2026-08-08 through PR #75 (a run of portal-only infra
PRs that moved neither denominator); PR #77 is the first since then to move it,
downward, because it is feature work rather than infra.

The historical ~66% reflected the four completed items of the original
`/sync-pr` de-drift batch (see `docs/sync-pr-large-scale-run.md`) plus a fifth,
follow-on item — adopting `signal-policy.ts`/`live-price.ts` — done once the
drift gate made "adopt before it drifts" enforceable. The drift-detection CI
gate now runs on **both** repos (mobile PR #33 added the mobile-side job;
portal PR #52 added the portal-side one), covering 8 shared-core files.
Remaining work (AI Council convergence decision, observability/backtest ports,
Hold/Fold backend unification) is backlog, not batch scope. The portal still
pulls ahead on the signal/Hold-Fold data plane; the risk lives in the gap
between the two denominators.

## Domain parity matrix

| Domain | Mobile | Portal | Shared module | Status |
|--------|--------|--------|---------------|--------|
| **Auth (Clerk)** | `@clerk/clerk-expo` | `@clerk/nextjs` | — (SDK differs by design) | ✅ Aligned — same provider + entitlement key |
| **Subscription/billing** | `subscription.ts`, `PaywallScreen`, `useSubscription` | `subscription.ts`, `stripe.ts`, `dashboard/billing`, `upgrade` ([[entity-billing]]) | `lib/subscription.ts` **byte-identical (mobile PR #29)** | ✅ Synced — re-synced after PR #45 drift |
| **Retention** | `retention.ts`, `useStreak`, `TrialExpiryBanner` | `retention.ts`, `/api/retention` | `lib/retention.ts` **identical** | ✅ Synced |
| **Portfolio** | `portfolio.ts`, `PortfolioScreen`, `usePortfolio` | `portfolio.ts`, `/api/portfolio`, `dashboard/portfolio` | `lib/portfolio.ts` **identical** | ✅ Synced ([[entity-portfolio-intelligence]]) |
| **SSE transport** | `shared/sse.ts` | `shared/sse.ts` | **identical** | ✅ Synced |
| **Signals / Digest** | `digest.ts`, `signalCard.ts`, `DigestScreen` | `digest.ts`, `signalCard.ts`, `/api/signals`, `dashboard/signals` | `digest.ts`, `signalCard.ts` **byte-identical (mobile PR #30 + portal PR #51)** | ✅ Synced — was 🟡 Partial (open-issue #6, resolved); portal-only signal data plane depth is a separate axis ([[entity-signal-data-plane]]) |
| **Signal cache / queue** | `signal-policy.ts` present, unconsumed | `signal-queue.ts`, `signal-policy.ts`, `signal_cache`, `/api/signals/drain` ([[decision-pending-signals-queue]]) | `signal-policy.ts` **byte-identical (mobile PR #32)** | 🟡 Partial — module shared, feature still portal-only |
| **Real-time price tier** | `live-price.ts` present, unconsumed | `live-price.ts`, `live-price-db.ts`, `live_prices`, `/api/signals/live` ([[entity-live-price-tier]]) | `live-price.ts` **byte-identical (mobile PR #32)** | 🟡 Partial — module shared, feature still portal-only |
| **Nu AI chat** | `nuai.ts`, `NuAIScreen`, `useNuAI` | `nuai.ts`, `/api/nuai`, `dashboard/nuai` | `nuai.ts` **diverged** | 🟡 Partial |
| **Hold/Fold** | `clients/holdfold.ts`, `HoldFoldScreen` — different backend, incompatible verdict shape | `/api/holdfold`, `dashboard/holdfold`, `holdfold-cache`, `/api/brief` (PR #46) | `lib/shared/holdfold-map.ts` in `lib/shared/` but portal-only (PR #46) | 🟡 Partial — portal has cache + shared mapper ([[entity-holdfold-cache]]) |
| **Daily Brief / Market Briefing** | `BriefingScreen` — live council prompt from `getMarketOverview()` + `getMacroPulse()` + `getSignals()` | `/api/brief` — one-shot LLM completion grounded on scoped market data + Hold/Fold verdicts (PR #46) | none | 🔴 Divergent — different data (mobile: full sections + macro; portal: brief-only + verdicts), different output shape (council prose vs. 4-sentence structured brief) |
| **Shared prefs** | `shared/prefs.ts` (SecureStore) | `shared/prefs.ts` (localStorage) | **byte-identical except the storage-backend seam** (confirmed, PR #50 assessment) | ✅ Aligned — same seam class as Auth SDK |
| **Shared signal filters** | `shared/signalFilters.ts` | `shared/signalFilters.ts` (PR #50) | **byte-identical except the import-path seam** (mobile's `@/` alias is unconfigured — separate bug, see `docs/findings-neon-and-stray-files.html`) | ✅ Synced — was 🟡 Partial (quote-style drift), reconciled by portal PR #50 |
| **Feedback** | `feedback.ts` | `/api/feedback`, `lib/feedback` | none | 🟡 Present both, unshared |
| **Push** | `pushNotifications.ts` | `/api/push` | none | 🟡 Present both, unshared |
| **Referral / share** | `shareSheet.ts` | `/api/referral`, `dashboard/share` | none | 🟡 Present both, unshared |
| **AI Council** | `clients/council.ts` composer → ai-text RAG backend | 6-seat OpenRouter deliberation, server-side ([[entity-ai-council]]) | none | 🔴 Divergent architectures |
| **Cookie consent / privacy rights** | — (mobile `analytics.ts`+`sentry.ts` run *without* a consent gate) | `ConsentBanner`+`ConsentPreferences` in root layout, `nu_consent` cookie, `/api/consent`, `/api/legal-consent`, `/api/privacy/{export,profile,delete}`, `consent_records`+`legal_consent_events` (PR #77) | `lib/shared/consent.ts`, `lib/shared/legal-consent.ts` — **portal-only so far, but portable now** (no backend/schema dep mobile lacks; only the prefs storage seam) | ⬅️ Portal-only — **required port**, not optional: GDPR/CPRA bind the mobile app too ([[concept-sync-requirements]] §new) |
| **Public council demo + share cards** | — | `/api/council/public`, `/api/og/verdict/[ticker]`, `/verdict/[ticker]` (PR #43) | none (reuses `lib/openrouter.ts`) | ⬅️ Portal-only, unauthenticated growth surface |
| **Backtest** | — | `/api/backtest`, `backtest.ts` ([[entity-backtest-engine]]) | — | ⬅️ Portal-only |
| **Watchlist store** | (folded into `usePortfolio`) | `watchlist-store.ts` | — | ⬅️ Portal-only |
| **Onboarding** | `OnboardingScreen` | — | — | ➡️ Mobile-only |
| **Analytics / Sentry** | `analytics.ts`, `sentry.ts` | — | — | ➡️ Mobile-only |
| **Schwab health** | `schwab-health.ts` | — | — | ➡️ Mobile-only |

Legend: ✅ synced · 🟡 partial · 🔴 divergent · ⬅️ portal-only · ➡️ mobile-only.

## Contradictions / tensions

> ⚠️ Contradiction: `lib/shared/` is meant to be the single source of truth, but
> `prefs.ts` and `signalFilters.ts` differ between repos *inside that very
> folder* on documented seams — and PR #46 added `holdfold-map.ts`, portal-only
> with no mobile counterpart. `signal-policy.ts` + `live-price.ts` (PR #40) were
> the same standing-drift-invitation pattern until mobile PR #32 adopted them
> verbatim, resolved by "claim the module before mobile grows its own copy," per
> [[concept-sync-requirements]]. `holdfold-map.ts` can't follow the same path —
> mobile would first need to switch its Hold/Fold backend and verdict schema to
> match portal's.

> ⚠️ Contradiction: mobile ships `analytics.ts` + `sentry.ts` (client tracking)
> with **no consent gate**, while the portal (PR #77) now blocks all
> non-necessary tracking until the user opts in and honors GPC/DNT. The two
> surfaces share one Clerk identity and one user base, so a user who opts out on
> the web is still tracked on the app. Until mobile adopts `lib/shared/consent.ts`
> and gates its analytics init (see [[concept-sync-requirements]] §"Cookie
> consent / privacy rights", priority #6), the *product* is non-compliant even
> though the portal in isolation is not.

> ⚠️ Contradiction: the mobile wiki's
> `gcp3-mobile/docs/wiki-mobile/concept-backend-is-source-of-truth.md`
> argues for one canonical adapter, yet `digest.ts` / `signalCard.ts` exist as two
> independently-evolved copies. Mobile's `overview.md` open-issue #6 flags exactly
> this divergence.

> ❓ Open question: the AI Council is the flagship feature and is the *least*
> synced — portal runs a self-contained 6-seat OpenRouter debate while mobile taps
> a RAG backend. Is convergence a goal, or are these deliberately different products
> (deep desktop deliberation vs. lightweight mobile tap-in)? Decision not recorded.

> ⚠️ **Portal PR #77 (2026-08-29) assessed — a cross-surface *obligation* domain lands web-only, plus two portal-only `lib/shared/` modules. Headline drops ~66% → ~63%.** Added cookie/tracking-consent infrastructure (`ConsentBanner` + `ConsentPreferences` in the root layout, the `nu_consent` first-party cookie via `POST /api/consent`, `consent_records` + `legal_consent_events` tables), a ToS/Privacy checkbox gating Clerk sign-up (`LegalConsentGate` → `/api/legal-consent`), and the data-subject-rights endpoints the privacy policy already promises (`/api/privacy/export|profile|delete`). Two things move the number. **First**, `lib/shared/consent.ts` and `lib/shared/legal-consent.ts` are new pure modules written to be mirrored but not yet ported — portal now carries **15** `lib/shared/` modules to mobile's **5**, the same standing-drift shape as `signal-policy.ts`/`live-price.ts` before mobile PR #32, and portable today (consent has no backend/schema dependency mobile lacks). **Second**, consent capture is a genuine cross-surface obligation — GDPR/CPRA bind the mobile app too — so it enters the feature-domain denominator as a real gap: mobile runs `analytics.ts` + `sentry.ts` with **no** consent gate, and portal is now the only surface that asks. See [[concept-sync-requirements]].

> ⚠️ **Portal PR #78 (2026-08-29) assessed — auth hardening + DSAR rights + analytics/attribution scaffolding, headline ~63% → ~62%.** Builds on PR #77's branch. Three parity-relevant facts. **First**, one new `lib/shared/` module — `attribution.ts`, the pure first-party acquisition model (`nu_attrib` cookie, UTM/gclid/fbclid/referrer, 90-day first-touch), written to be mirrored, and mobile PR #39 does exactly that. **Second**, the auth-hardening work is structurally portal-only and should stay that way: `middleware.ts` edge-matcher coverage and the `lib/http-auth.ts` timing-safe bearer compare guard server routes mobile does not have. (`lib/http-auth.ts` is deliberately pure-JS, not `node:crypto`: the Edge Middleware bundle cannot load `node:crypto`, and `next build` surfaced that as an Ecmascript error *while still exiting 0* — a build-passes-but-is-broken shape.) **Third and most consequential**: the data-subject-rights surface (`/api/privacy/{export,profile,delete,rectify}`, the `privacy_requests` statutory-clock ledger) and the analytics consent gate (`lib/analytics.ts`, no-ops unless `nu_consent.analytics` is true) are web-only. Combined with mobile's un-gated tracking, the shared-identity product now has a **second** compliance asymmetry: a user can exercise GDPR access/erasure/rectification on web but has no mechanism on mobile, against the same account — a feature-domain gap, so that denominator moves too. `docs/privacy-register.md` is the shared input both surfaces' policies should generate from.

> ℹ️ **Portal PR #79 (2026-08-29) assessed — portal-only revenue fix + docs, headline unchanged at ~62%.** Repaired a live production defect: `STRIPE_PRICE_ANNUAL` held a placeholder string and no annual price existed on the Stripe account at all, so every annual checkout returned HTTP 500 from the placeholder guard in `app/api/stripe/checkout/route.ts` — silently, since monthly worked and nothing alerts on it. Both plans were consolidated onto a single Stripe product, because Stripe's in-place subscription update with proration only works within one product; across two it degrades to cancel-and-resubscribe. The consequent price change ($79 → $79.99) invalidated hardcoded UI copy in four `app/` files, corrected in the same PR. **No `lib/shared/` module touched and no new one added**, so the single-source denominator holds at 15 portal / 5 mobile. Neither does the feature denominator move: mobile has no Stripe checkout surface of its own — it defers to the portal for billing — so there is no counterpart to drift from. Same portal-only shape as #59/#64/#65/#67/#70. The portable content is documentary, not code: `docs/stripe-price-consolidation.md` records that Stripe prices can never be deleted (only archived, `active:false`), that archiving does **not** migrate existing subscribers off a price, and that `vercel env add` silently refuses to overwrite an existing variable — all three are operational facts that bite either surface.

> ℹ️ **Portal PR #85 (2026-08-30) assessed — CI/scheduler infra + docs only, headline unchanged at ~62%.** Adds the monthly bear/bull **followed-tickers cohort** ([[concept-followed-tickers-tracking]]): `docs/tickers-followed.md`, `select-followed-tickers.yml` (monthly — freezes the app's 10 strongest bearish + 10 strongest bullish signals from `/api/signals/top`), and `track-followed-tickers.yml` (weekday daily — scores the 20 through backtest + signal + council). Same portal-only shape as #59/#64/#65/#67/#70/#74: both workflows are orchestration shipped ahead of their `/api/pipeline/*` routes, touch no `lib/`, `lib/shared/`, or `app/` code, and mobile has no server-side cron layer, ticker universe, or backtest engine to compare against. Neither denominator moves — portal stays at 15 shared modules / mobile 5. The one portable idea is documentary: the *monthly-cohort-not-rolling-watchlist* design (freeze a call so it can be checked against reality; keep a flipped thesis rather than pruning it) — a data-methodology principle worth carrying if mobile ever grows its own signal-tracking surface, not shared code.

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
