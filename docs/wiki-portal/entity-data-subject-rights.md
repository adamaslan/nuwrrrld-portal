---
date: 2026-08-29
type: entity
tags: [privacy, gdpr, ccpa, dsar, rights, erasure, portability, rate-limit, web-only]
sources: [../../app/api/privacy, ../../lib/privacy-requests-db.ts, ../../lib/rate-limit.ts, ../../lib/customer-profile-rules.ts, ../../lib/customer-profile.ts, ../../docs/privacy-register.md]
---

# Entity — Data-Subject Rights

## What it is

The four endpoints behind the promises `app/privacy-policy/page.tsx` §8 has been
making since before any of them existed, plus the ledger that makes the
statutory response clock provable.

| Endpoint | Right | Shape |
|---|---|---|
| `GET /api/privacy/export` | Access + portability (Art. 15, 20) | Full per-user JSON across every user-keyed table + Clerk metadata. Degrades per-section, never 500s. **Rate-limited 3/hour.** |
| `GET /api/privacy/profile` | Access to derived data (Art. 15, 22) | Plan, engagement counters, watchlist-derived interest tags, current consent, DSAR history, and `derived_profile` — the segments *with the rule that produced each one*. |
| `POST /api/privacy/delete` | Erasure (Art. 17) | Two-step. `{confirm:false}` returns the row-count blast radius plus a 15-minute HMAC token; only `{confirm:true, token}` cascades. Clerk account deleted last. Stripe deliberately retained (7-year billing). |
| `POST /api/privacy/rectify` | Rectification (Art. 16) | Logs a structured correction request; does **not** self-mutate. 202 + statutory deadline. Rate-limited 5/hour. |

## The ledger, and why it survives erasure

`privacy_requests` takes one append-only row per DSAR at receipt, carrying
`received_at` and `due_at` (received + 30 days — GDPR's window, tighter than
CCPA's 45). Without it, "we answered within the statutory period" is an
assertion; with it, it's a query.

The non-obvious design point: **`privacy_requests` is deliberately absent from
`USER_TABLES` in the delete route's cascade.** The record that a user asked to
be erased on a given date has to outlive the erasure it records, or the
compliance artifact destroys itself. It holds no personal data beyond the Clerk
`user_id`, so keeping it is not in tension with the erasure itself.

The delete route ledgers on **both** paths — the dry run and the confirmed
execute — because the clock starts when the user asks, not when they confirm. A
user who requests deletion and never returns still made a request.

## Rectification does not mutate

`/api/privacy/rectify` records the request instead of applying it. That looks
like a gap and is deliberate: most correctable data here is already self-service
(Clerk profile, watchlist, consent preferences), and a "rectification" that
silently writes would bypass the audit trail the right exists to create. The
endpoint's job is to make the request legible and clocked.

## Why rate limiting showed up here first

`/api/privacy/export` runs a query per user-keyed table on every call — the most
expensive thing a signed-in caller can trigger at will. `lib/rate-limit.ts` is a
dependency-free in-process sliding window: per-instance and best-effort, which is
honest about what it is on Vercel serverless. A hard cross-instance quota would
need Redis, and that dependency has not earned its place yet.

## Field classification, and the guard that enforces it

`lib/customer-profile-rules.ts` carries `FIELD_CLASS`, tagging every field
`identifier` | `behavioral` | `financial` | `derived`. `financial` fields
(holdings, position sizes, portfolio value) must never leave the primary
database — not to analytics, not to an ad payload, not into a log line.

`assertNoFinancialFields()` turns that from a comment into a runtime invariant:
it throws if a payload about to cross a boundary carries a field classified
`financial`. Comments describing a rule drift; a function that throws does not.

Segments (`power_user`, `at_risk_churn`, `trial_stalled`, `signal_only`,
`portfolio_active`, `ai_heavy`) each ship with their derivation string, because
Art. 15/22 lets a user ask *how* an automated inference about them was produced —
an undocumented segment is an unanswerable question. Nothing infers net worth,
income, creditworthiness, employment, or financial distress; those are
special-category-adjacent and disproportionate to what this product needs.

## Where used

- `app/privacy-policy/page.tsx` §8 — the promises these endpoints satisfy. The
  policy predates them by months; this entity is the code catching up to the
  document, not the other way round.
- `components/CookiePreferencesLink.tsx` / the footer — the consent half of the
  same user-facing surface ([[entity-consent-system]]).
- `docs/privacy-register.md` — the register a policy rewrite should generate from.
- Called directly by a signed-in user; nothing internal consumes them. There is
  deliberately no service-to-service caller: every endpoint requires a Clerk
  session, because an unauthenticated export endpoint is an account-takeover
  primitive rather than a privacy feature.

## Known failures

- **`node:crypto` in Edge-reachable code breaks the build silently.** The
  timing-safe compare in `lib/http-auth.ts` first used `node:crypto`, which
  `middleware.ts` transitively imports. `next build` printed an Ecmascript error
  for the Edge Middleware bundle **and still exited 0** — a passing build that
  was broken. Fixed by a pure-JS constant-time loop. Any future crypto in a
  middleware-reachable module hits this again.
- **The ledger write is fail-open.** `logPrivacyRequest()` swallows DB errors so
  a ledger outage cannot block a user's actual request. The tradeoff is real: a
  request served during a Neon outage is unrecorded, so the clock for it is
  unprovable. Serving the right and losing the record beats refusing the right.
- **Rate limiting is per-instance.** On Vercel serverless, a caller hitting
  several warm instances gets several times the nominal quota. It stops
  hammering within one instance, which is what it was built for — it is not a
  hard quota.

## Open questions

- Should **restriction (Art. 18)** get an endpoint, or is it better served by a
  documented manual runbook? It is the one §8 promise still with no mechanism.
- Should mobile proxy to these endpoints or link out to the portal
  ([[concept-sync-requirements]] #8)? Linking out keeps the cascade single-copy;
  proxying gives a better in-app experience. Not yet decided.
- The **retention enforcement job** does not exist. Until it does,
  `docs/privacy-register.md` §3 is a target, not a fact — and publishing it in
  the policy would repeat the exact over-promise this work set out to close.
- **Are the LLM providers' zero-retention terms actually contracted?** User
  prompt text reaches OpenRouter and its upstreams. Nobody on this project has
  confirmed the terms in writing; the free-model chain also changes, which can
  change the answer silently.

## Known gaps

- **Web-only.** `gcp3-mobile` has no DSAR path against the same Clerk identity —
  see [[concept-sync-requirements]] #8. This is a compliance asymmetry, not a
  feature gap.
- **Restriction (Art. 18)** is promised by the policy and still has no mechanism.
- **Retention enforcement does not exist.** `docs/privacy-register.md` §3 states
  targets; no job enforces them. The policy must not publish that table until one
  does, or it repeats the over-promise this entity was built to close.
- **No processor deletion propagation.** Erasure cascades across our own tables
  and Clerk; it does not call any processor's deletion API (there are none to
  call yet — no analytics or ad vendor is wired).

## See also

- [[entity-consent-system]] — the consent layer these rights sit alongside
- [[concept-mobile-web-parity]] — why web-only rights move the headline
- [[concept-sync-requirements]] — #8, giving mobile a rights path
- `docs/privacy-register.md` — cookie table, processors, retention, legal bases
- `docs/API-ROUTE-AUTH.md` — how these endpoints are guarded
