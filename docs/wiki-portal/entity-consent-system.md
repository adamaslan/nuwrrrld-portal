---
date: 2026-08-29
type: entity
tags: [consent, cookies, privacy, gdpr, ccpa, tracking, cross-surface, shared]
sources: [../../lib/shared/consent.ts, ../../lib/shared/legal-consent.ts, ../../lib/consent.ts, ../../lib/consent-db.ts, ../../lib/legal-consent-db.ts, ../../app/api/consent/route.ts, ../../app/api/legal-consent/route.ts, ../../app/api/privacy, ../../components/ConsentBanner.tsx, PR#77]
---

# Entity — Consent System

## What it is

The portal's cookie/tracking consent layer, the express legal-consent capture
at sign-up, and the data-subject-rights endpoints. Landed by PR #77 as the
first half of `docs/todo-auth-cookies-tracking.md` (Phases 2, 1.4, 6). Nothing
about analytics or ad tracking ships yet — this is the machinery that will
*gate* it.

Structurally a near-copy of [[entity-disclaimer-system]]: a pure logic module
with a hash/version identity, a `lib/*-db.ts` Neon store with an asymmetric
failure mode, a client component that checks server state, and an API route.

### Consent model — `lib/shared/consent.ts` (pure, mobile-mirrorable)

- Four categories: `strictly_necessary` (always on, cannot be refused),
  `preferences`, `analytics`, `marketing`. The last three default to **denied**
  until the user chooses.
- `buildConsent(desired, source)` is the single constructor. `acceptAll()` and
  `rejectAll()` both call it — that is what keeps them structurally symmetric,
  which `consent.css` then enforces visually (equal-weight buttons — a real
  EU/CPRA requirement, not a style choice).
- `applyDoNotTrack(base, "gpc" | "dnt")` forces `analytics` + `marketing` off,
  preserves `preferences`. California treats GPC as a binding opt-out.
- `CONSENT_VERSION` — a bump invalidates every stored record and re-prompts,
  same mechanism as `DISCLAIMER_HASH`.
- `parseConsent()` fails safe: anything malformed → `null` (caller treats the
  user as un-prompted, so no non-necessary category is allowed), and a stored
  `strictly_necessary: false` is coerced back to `true`.

### Storage

- **`nu_consent` first-party cookie** — the fast path and the *only* store for
  signed-out visitors. `SameSite=Lax`, `Secure` in prod, **not** `HttpOnly`
  (client tag-gating has to read it). ~400-day max-age.
- **`consent_records` table** — append-only, one row per consent *change*, for
  signed-in users. Survives a cookie clear and follows the account to
  `gcp3-mobile`. `insertConsentRecord()` fails **open**; `getLatestConsentRecord()`
  fails **closed** — same asymmetry rationale as [[entity-disclaimer-system]].
- `app/api/consent` `POST` is the single write path: sets the cookie, appends
  the DB row, and applies the GPC/DNT header override *after* the client's
  submitted choices so a privacy signal always wins.

### Express legal consent — `lib/shared/legal-consent.ts` + `legal_consent_events`

Versioned per-document (`tos`, `privacy`) acceptance records —
`{user_id, doc, doc_version, accepted_at, ip, user_agent}`, not a bare boolean.
`LegalConsentGate` wraps the Clerk `<SignUp/>` widget with a **required,
unticked** checkbox; once Clerk reports a session, the client `POST`s to
`/api/legal-consent`, which records the *current* versions from the shared
module (never a version supplied by the client). The item was first raised in
`docs/todo1.md`.

### Data-subject rights — `app/api/privacy/*`

- `GET /export` — full per-user JSON across every `user_id`-keyed table + Clerk
  metadata. Each section is independently try/caught; a failure degrades to
  `[]`/`null` with an `_errors` list. Never 500s.
- `GET /profile` — GDPR Art. 15 derived view (plan, engagement counts,
  watchlist-derived interest tags, current consent).
- `POST /delete` — **two-step**. `{confirm:false}` returns the per-table row
  counts that *would* be deleted plus a short-lived HMAC token (bound to the
  user + a 15-minute bucket, signed with `PORTAL_PUSH_SECRET`). Only
  `{confirm:true, token}` runs the cascade. Clerk account is deleted **last**,
  after the DB cascade; Stripe is deliberately left alone (7-year billing
  retention).

## Where used

- **Root layout** (`app/layout.tsx`) mounts `<ConsentBanner/>` — it renders the
  first-visit banner (Accept all / Reject all / Manage), or a GPC/DNT
  auto-honored note, or nothing if a current-version choice exists.
- **`app/page.tsx` footer** — `<CookiePreferencesLink/>` dispatches a
  `nu:open-consent-preferences` window event the mounted banner listens for.
- **`app/sign-up/[[...sign-up]]/page.tsx`** — `<LegalConsentGate/>` around
  `<SignUp/>`.
- **Not yet consumed by any tracking code** — Phase 3+ (`docs/todo-auth-cookies-tracking.md`)
  is where `isAllowed(record, "analytics")` starts gating real tags.

## Known failures

- **No middleware enforcement.** The GPC guarantee rests on three layers —
  `ConsentBanner` auto-POST on detection, the `/api/consent` write-time
  override, and `resolveConsent()` at read time. A caller that reads the
  `nu_consent` cookie directly without going through `resolveConsent()` would
  miss a GPC header that arrived on *this* request but hasn't been written to
  the cookie yet. Every server reader must use `resolveConsent()`, not
  `getConsent()` alone.
- **`/api/privacy/export` has no rate limit yet** — flagged in a code comment,
  deferred to the Phase 3 PR that introduces a limiter. An unauthenticated
  caller can't reach it (Clerk-gated), but an authenticated one can hammer it.
- **Delete token uses `PORTAL_PUSH_SECRET`** — reused rather than a dedicated
  secret. Fine for now (same trust boundary), but worth its own key if the
  endpoint's surface grows.
- **`legal_consent_events` unique index is `(user_id, doc, doc_version)`** — a
  user who somehow accepts, then the doc version is rolled *back*, would not
  re-record. Not a real scenario, noted for completeness.

## Open questions

- ❓ Should consent live in Clerk `publicMetadata` too (like referral codes),
  so it's readable wherever Clerk is, without a DB round-trip? Rejected for now
  — no append-only history, 8KB limit — but revisit if mobile adoption makes
  the DB-per-surface read a latency problem.
- ❓ The privacy policy (`app/privacy-policy/page.tsx`) still describes consent
  and rights loosely and pre-dates all of this. Phase 7 rewrites it to match;
  until then the page *under*-describes what's now implemented. See
  [[concept-sync-requirements]].
- ❓ `/api/privacy/rectify` (correction requests) is promised by the policy and
  not built — deferred to the follow-up PR.

## See also

- [[entity-disclaimer-system]] — the structural template (hash identity, Neon
  store, asymmetric failure, gating component)
- [[concept-mobile-web-parity]] — PR #77 adds the "Cookie consent / privacy
  rights" domain row and two portal-only `lib/shared/` modules
- [[concept-sync-requirements]] — §2 "Cookie consent / privacy rights" is the
  mobile port checklist; priority item #6
- [[concept-cache-then-degrade]] · [[concept-graceful-degradation]] — the
  fail-open/fail-closed asymmetry reused here
- [[entity-billing]] — why Stripe data survives a delete (7-year retention)
- `docs/todo-auth-cookies-tracking.md` — the full 7-phase plan; PR #77 is
  Phases 2 + 1.4 + 6
- `docs/session-gaps-consent-plan.md` — the Haiku delegation plan for PR #77
