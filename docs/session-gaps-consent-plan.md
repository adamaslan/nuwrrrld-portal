# Consent/cookies implementation — Haiku delegation plan

PR: feat/consent-cookies-tracking (branch off origin/main, PR #76 predecessor merged)
Scope this PR: ~half the TODO — Phase 2 (consent infra) + Phase 1.4 (sign-up consent) + Phase 6 (privacy rights endpoints).
Deferred to follow-up PR: Phase 3 (analytics vendor), Phase 4 (ad pixels), Phase 5 (profile ML), Phase 7 (policy legal rewrite).

## Parent-only units (judgment / sensitive surface — NOT delegated)
- lib/shared/consent.ts .......... DONE (pure consent model, mobile-mirrorable)
- lib/db/schema.sql .............. consent_records + legal_consent_events tables (schema = sensitive)
- middleware.ts ................. GPC → force-deny analytics/marketing (auth/middleware = §4.3 forbidden surface)
- app/layout.tsx ............... mount <ConsentBanner/> (root layout wiring, review-sensitive)
- app/api/consent/route.ts ...... sets first-party cookie + writes DB row (cookie-issuing path)
- app/api/legal-consent/route.ts . records versioned ToS/Privacy consent event
- app/api/privacy/delete/route.ts  CASCADE delete across every user table (destructive — needs the confirm-gate treatment)

## Haiku-eligible units (mechanical, fully specified)
H1. lib/consent-db.ts — append-only store, EXACT disclaimer-db.ts pattern:
    - insertConsentRecord(userId, record: ConsentRecord): Promise<void>  — try/catch, fails open
    - getLatestConsentRecord(userId): Promise<ConsentRecord | null>       — try/catch, fails closed (returns null)
    - listConsentHistory(userId): Promise<Row[]>                          — for the privacy export
    Import `sql from "@/lib/db"`. No new deps. Mirror the header-comment style of lib/disclaimer-db.ts.

H2. lib/consent.ts — server read helpers (no DB):
    - getConsent(): Promise<ConsentRecord|null>  — `await cookies()` from next/headers, parseConsent()
    - readConsentFromRequest(req: NextRequest): ConsentRecord|null — req.cookies.get()
    - detectDoNotTrack(headers: Headers): "gpc"|"dnt"|null — Sec-GPC: "1" → gpc; DNT: "1" → dnt
    All from lib/shared/consent.ts helpers. Pattern: lib/disclaimer.ts split (pure vs io).

H3. components/consent.css — styles only. Match components/disclaimer.css token usage
    (dark-theme design tokens — grep disclaimer.css for the var() names, reuse them).
    Classes: .consent-banner, .consent-banner-actions, .consent-btn, .consent-btn-secondary,
    .consent-overlay, .consent-modal, .consent-category-row, .consent-toggle, .consent-footer-link.

H4. components/ConsentBanner.tsx — "use client". First-visit banner.
    - On mount: fetch GET /api/consent; if needsPrompt() → show banner.
    - Three buttons, EQUAL visual weight: "Accept all" / "Reject all" / "Manage".
    - Accept/Reject → POST /api/consent {choices, source}. "Manage" → opens <ConsentPreferences/>.
    - Honor navigator.globalPrivacyControl / doNotTrack: if set, auto-POST applyDoNotTrack and show a
      one-line "we're respecting your browser privacy setting" note instead of the choice buttons.
    Model after components/DisclaimerModal.tsx (useUser, useEffect fetch, cancelled flag).

H5. components/ConsentPreferences.tsx — "use client". Per-category modal.
    - Renders CATEGORY_INFO: a labelled toggle per category; strictly_necessary shown checked+disabled.
    - "Save preferences" → POST /api/consent {choices, source:"preferences"}.
    - Reachable from the banner AND from the footer link (props: open, onClose).

H6. components/CookiePreferencesLink.tsx — "use client". Footer button that opens ConsentPreferences.
    Mirror components/DisclaimerFooter.tsx's viewerOpen useState pattern exactly.

H7. app/api/privacy/export/route.ts — GET, authenticated. Assemble every row keyed to userId across:
    council_sessions, council_messages (via session), council_usage, nuai_usage, watchlist_items,
    disclaimer_acks, user_digest_cache, consent_records, legal_consent_events. Return JSON.
    Rate-limit note in a comment (real limiter deferred). Pattern: app/api/referral/route.ts auth guard.

H8. app/api/privacy/profile/route.ts — GET, authenticated. Return the derived view the user is entitled
    to see: plan/trial (from Clerk), streak state, usage counts, watchlist-derived interest tags,
    current consent state. Read-only aggregation, no new tables.

H9. __tests__/consent.test.ts — vitest. Cover lib/shared/consent.ts:
    buildConsent forces necessary on; acceptAll/rejectAll symmetry; parseConsent rejects malformed /
    coerces stored necessary:false → true; needsPrompt on version bump; applyDoNotTrack keeps prefs,
    kills analytics+marketing; isAllowed matrix.

## Contract every Haiku unit must honor
- TypeScript strict; `npx tsc --noEmit` clean.
- No new npm deps.
- Import shared model from "@/lib/shared/consent"; never re-define categories.
- Guarded DB helpers: try/catch, no throw across the boundary (disclaimer-db.ts asymmetry rule).
- "use client" only where hooks/browser APIs are used.
- Match neighbouring file header-comment density.

## Integration order (parent, after Haiku units land)
schema.sql → db:migrate → consent-db + consent.ts (H1/H2) → route.ts → components → layout mount → middleware GPC → tsc + vitest + build → PR.

---
## RESULT (2026-08-29)

Shipped on branch feat/consent-cookies-tracking:
- lib/shared/consent.ts, lib/shared/legal-consent.ts (pure, mobile-mirrorable)
- lib/consent.ts, lib/consent-db.ts, lib/legal-consent-db.ts (guarded, disclaimer-db asymmetry)
- lib/db/schema.sql: consent_records + legal_consent_events (migrated + verified live)
- app/api/consent/route.ts (GET/POST — the only nu_consent cookie write path; GPC/DNT override)
- app/api/legal-consent/route.ts (versioned ToS/Privacy events)
- app/api/privacy/{export,profile,delete}/route.ts (delete is 2-step HMAC-token confirm gate)
- components/ConsentBanner + ConsentPreferences + CookiePreferencesLink + LegalConsentGate + consent.css
- app/layout.tsx mounts <ConsentBanner/>; app/page.tsx footer gets the preferences link
- app/sign-up wraps <SignUp/> in <LegalConsentGate/>
- __tests__/consent.test.ts — 30 passing

Checks: tsc clean, eslint clean, next build clean, 485/485 non-live vitest pass.
The 22 failing tests are __tests__/live/*.live.test.ts (OpenRouter 404, pre-existing, no consent refs).

Middleware NOT changed: the GPC guarantee holds via (1) ConsentBanner client auto-POST on
detection, (2) /api/consent applyDoNotTrack override on write, (3) resolveConsent() on read.
Planting a cookie from clerkMiddleware would be redundant and risk clobbering Clerk's response.

DEFERRED to a follow-up PR (needs vendor DPAs / ad accounts / legal): Phase 3 analytics vendor
wiring, Phase 4 ad pixels + Consent Mode v2, Phase 5 customer-profile tables + segments,
Phase 7 privacy-policy legal rewrite, /api/privacy/rectify, real rate limiter on the export.
