---
date: 2026-07-27
type: entity
tags: [billing, subscription, stripe, clerk, auth]
sources: [lib/subscription.ts, lib/stripe.ts, app/api/stripe/checkout/route.ts, app/api/stripe/portal/route.ts, app/api/webhooks/stripe/route.ts, app/api/webhooks/clerk/route.ts, middleware.ts, docs/clerk-stripe-auth.md, PR#45]
---

# entity: Billing / Auth (Clerk + Stripe)

## What it is

The portal's identity and billing stack. **Clerk is the source of truth for
entitlements** — there is no separate billing database. Stripe webhooks write
subscription state into Clerk `publicMetadata`; the app reads that metadata to
gate features via `lib/subscription.ts`'s `hasEntitlement()`.

- **Auth**: `middleware.ts` runs `clerkMiddleware`, protecting `/dashboard(.*)`
  and (defense-in-depth) `/api/signals/digest`, `/api/portfolio/health`,
  `/api/holdfold` — with one carve-out for internal server-to-server calls
  bearing `Authorization: Bearer $PORTAL_PUSH_SECRET`.
- **Billing**: `lib/stripe.ts` lazily constructs the Stripe client
  (`STRIPE_SECRET_KEY`, API version `2026-05-27.dahlia`) and exposes
  `PRICES.monthly`/`.annual`. Three routes: `POST /api/stripe/checkout`
  (7-day-trial Checkout Session), `POST /api/stripe/portal` (lazy customer
  provisioning + Stripe billing portal), `GET /api/stripe/subscription`
  (reads metadata for the client).
- **Sync engine**: `POST /api/webhooks/stripe` handles
  `customer.subscription.created|updated|deleted` and
  `checkout.session.completed`, calling `syncSubscriptionToClerk()` to write
  `subscription_status`/`subscription_tier`/`trial_end`/`stripe_*_id` into
  Clerk `publicMetadata`. Resolves the Clerk user via a `clerk_user_id`
  stamped on the Stripe Customer at `checkout.session.completed`.
- **Entitlement model**: `lib/subscription.ts` — `tierFromStatus()` maps
  `active`/`trialing`/`past_due` → `pro` (past_due is deliberately generous —
  retains access while Stripe Smart Retries are in flight), everything else →
  `free`. `FEATURE_TIER_MAP` gates individual features (`nu_ai`,
  `signals_digest`, `portfolio_suggestions`, etc.) through the single
  `hasEntitlement(feature, tier)` function used everywhere.
- **`parseSubscriptionMetadata()`** (added PR #45): validates
  `publicMetadata.subscription_status` against the known status union
  (degrades to `free` on anything unrecognized) and validates numeric
  timestamps, replacing untyped `as` casts at 3 call sites
  (`app/api/stripe/subscription/route.ts`, `app/api/nuai/route.ts`,
  `app/dashboard/page.tsx`).

Full architecture writeup with CLI debugging commands (Clerk CLI, Stripe CLI):
`docs/clerk-stripe-auth.md`.

## Where used

- Every feature gate in the app reads through `hasEntitlement()` — e.g.
  `app/api/nuai/route.ts` returns `403 upgrade_required` when the caller's
  tier doesn't cover `nu_ai`.
- `app/dashboard/page.tsx` reads tier to toggle the upgrade banner / annual
  billing switch banner.
- `app/pricing/CheckoutButton.tsx`, `app/dashboard/billing/ManageBillingButton.tsx`
  — the two client entry points into the checkout/portal routes.
- Mobile calls the portal's `/api/stripe/checkout` directly (authenticated,
  Clerk bearer token) rather than touching Stripe itself — see
  `gcp3-mobile/docs/wiki-mobile/entity-billing.md`, which documents the mobile
  side of this same Clerk-is-the-source-of-truth model.

## Known failures

- **[[incident-2026-07-27-stripe-checkout-invalid-header]]** — a malformed
  `STRIPE_SECRET_KEY` in production threw an unhandled exception inside
  `stripe.checkout.sessions.create`, producing a bodyless 500 that surfaced to
  users as a generic, undiagnosable "Could not start checkout" alert.
  Compounded by a second, independent misconfig: Clerk was serving a
  Development instance key (`pk_test_...`) on the production domain. Both are
  config/dashboard issues outside the codebase; the code-side fix (this PR)
  makes this failure class loud instead of silent, and `/api/health` now
  checks for both misconfigurations proactively.

## Open questions

- ❓ Whether the Clerk dev-instance key alone would have blocked signups,
  independent of the Stripe key issue, was never isolated — see the incident
  page's open items.
- ❓ No idempotency guard on `/api/webhooks/stripe` — Stripe's at-least-once
  delivery means `syncSubscriptionToClerk()` can re-run on a duplicate event.
  Writes are mostly idempotent (overwrite semantics), but
  `checkout.session.completed` re-stamps the customer and re-syncs on every
  redelivery; not yet a confirmed bug, just an unhardened edge.
- ❓ No CI/lint gate gating drift in `lib/subscription.ts` between this repo
  and mobile — see [[concept-mobile-web-parity]], which now flags this exact
  file as newly-drifted (PR #45 added `parseSubscriptionMetadata()` to the
  portal copy only).

## See also

- [[incident-2026-07-27-stripe-checkout-invalid-header]] — the production incident this entity page was written alongside
- [[concept-mobile-web-parity]] — the Subscription/billing matrix row, and the new `lib/subscription.ts` drift from this PR
- [[concept-sync-requirements]] — de-drift task for `lib/subscription.ts`
- `docs/clerk-stripe-auth.md` — full architecture + CLI reference
- `gcp3-mobile/docs/wiki-mobile/entity-billing.md` — the mobile sibling (thin client over this same portal-owned Stripe integration)
