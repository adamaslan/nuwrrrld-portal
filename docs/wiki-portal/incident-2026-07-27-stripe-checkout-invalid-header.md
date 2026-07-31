---
date: 2026-07-27
type: incident
tags: [stripe, clerk, billing, checkout, production, PR#45]
sources: [app/api/stripe/checkout/route.ts, app/api/stripe/portal/route.ts, app/api/health/route.ts, lib/subscription.ts, PR#45]
---

# Incident — Stripe checkout silently failing in production (2026-07-27)

Severity: **P0** — no user could complete a paid signup in production; the
failure was invisible (a generic alert with zero diagnostic content).

## Date & severity

Reported 2026-07-27 as "still can't actually sign up via Stripe." P0: blocks
all revenue-generating signups. Root-caused the same day via Vercel production
telemetry rather than local reproduction (the bug only manifested against the
production env var).

## What happened

Clicking a checkout button on `/pricing` (or "Manage subscription" on
`/dashboard/billing`) showed a generic **"Could not start checkout. Please try
again."** alert with no way to tell what went wrong — indistinguishable from a
network blip.

## Root cause

Two independent misconfigurations, found by querying Vercel's
`get_runtime_errors` for `/api/stripe/checkout` and curling the live
`/sign-in` page for the publicly-exposed Clerk key:

1. **Malformed `STRIPE_SECRET_KEY`.** Production logs showed
   `StripeConnectionError` wrapping `TypeError: Invalid character in header
   content ["Authorization"]` (`code: ERR_INVALID_CHAR`) — the classic
   signature of a stray trailing newline/whitespace character pasted into a
   Vercel env var value. Because `stripe.checkout.sessions.create(...)` in
   `app/api/stripe/checkout/route.ts` wasn't wrapped in try/catch, this threw
   an unhandled exception, and Next.js returned a bare 500 with **no JSON
   body**. `CheckoutButton.tsx`'s `res.json()` then failed, falling into its
   generic catch block.
2. **Clerk Development instance on the production domain.** The publishable
   key served from `financial.nuwrrrld.com/sign-in` was `pk_test_...`
   (a `*.clerk.accounts.dev` dev instance) rather than `pk_live_...`. Dev
   instances carry MAU/sign-up caps and aren't meant to back a live custom
   domain — an independent failure mode from #1, not yet confirmed to have
   directly blocked signups but flagged as a real misconfig regardless.

Neither failure mode was visible in `/api/health` before this incident — the
existing `checkStripe()` only confirmed `STRIPE_SECRET_KEY` was *set*, not
that it was well-formed, and there was no Clerk dependency check at all.

## Resolution

**Code (PR #45, this repo):**
- `app/api/stripe/checkout/route.ts` and `app/api/stripe/portal/route.ts` now
  wrap every Stripe SDK call in try/catch, returning `502` with a real
  `{ error }` message instead of an unhandled 500. `CheckoutButton.tsx` /
  `ManageBillingButton.tsx` surface that message in the alert.
- `app/api/health/route.ts` gained: a price-ID placeholder check (catches a
  bad `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_ANNUAL` before checkout is
  attempted) and a new `checkClerk()` dependency that flags a `pk_test_...`
  key running under `VERCEL_ENV=production` as `degraded`.
- `lib/subscription.ts` gained `parseSubscriptionMetadata()`, replacing
  untyped `as` casts on Clerk `publicMetadata` at 3 call sites
  (`app/api/stripe/subscription/route.ts`, `app/api/nuai/route.ts`,
  `app/dashboard/page.tsx`) — unrelated to the root cause directly, but
  motivated by the same audit (malformed/partial metadata should degrade
  safely, not propagate garbage).
- Regression test `__tests__/stripe-checkout.test.ts` mocks a Stripe SDK
  throw and pins that the route must return `502` JSON, not crash.

**Manual (outside this repo, not yet done as of this incident page):**
- Rotate `STRIPE_SECRET_KEY` in Vercel production from the Stripe Dashboard,
  verifying no trailing whitespace/newline.
- Promote a Clerk Production instance for `financial.nuwrrrld.com` in the
  Clerk Dashboard and swap `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` /
  `CLERK_SECRET_KEY` in Vercel to the `pk_live_`/`sk_live_` values.

Full step-by-step remediation: `docs/stripe-checkout-incident-fix-steps.html`.

## Impact on design

- **Every Stripe SDK call site now must have a try/catch** — this incident is
  the reason; a bare 500 with no body is worse than a slow response, because
  the frontend can't even alert the user meaningfully.
- **`/api/health` is now the first line of defense for billing/auth
  misconfig**, not just liveness — it validates *shape*, not just presence
  (secret key well-formed enough to authenticate; publishable key matches the
  deploy environment).
- This is the first Stripe/Clerk billing entity documented in this wiki —
  see [[entity-billing]] (new, this ingest).

## Open items

- [ ] `STRIPE_SECRET_KEY` not yet rotated in Vercel production (manual step, owner-only).
- [ ] Clerk Production instance not yet promoted (manual step, owner-only).
- [ ] Once both are done: `curl https://financial.nuwrrrld.com/api/health | jq` should show `stripe.status` and `clerk.status` both `"ok"`; then a live click-through of Pricing → Checkout confirms the fix end-to-end.
- ❓ Whether issue #2 (Clerk dev instance) *alone* would have blocked signups, independent of issue #1, was not isolated — both were fixed together at the config level, not individually tested in isolation.

## See also

- [[entity-billing]] — the Clerk + Stripe entity this incident lives under
- [[concept-mobile-web-parity]] — this PR incidentally drifted `lib/subscription.ts`, previously byte-identical with mobile (see the PR #45 assessment note there)
- `docs/clerk-stripe-auth.md` — full architecture reference (metadata schema, status→tier mapping, CLI debugging commands)
- `docs/stripe-checkout-incident-fix-steps.html` — the step-by-step remediation doc (code + manual steps)
