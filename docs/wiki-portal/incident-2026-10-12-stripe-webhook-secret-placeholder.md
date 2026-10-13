---
date: 2026-10-12
type: incident
tags: [stripe, billing, webhooks, production, PR#270]
sources: [app/api/webhooks/stripe/route.ts, app/api/health/route.ts, gcp3/backend/cloudbuild.yaml, PR#270]
---

# Incident — Stripe webhook receivers return 500 "not configured" (2026-10-12)

Severity: **P0 (latent)** — no completed checkout would ever grant
entitlement, but zero real customers had hit it yet (`GET /v1/events` → 0,
`GET /v1/subscriptions?status=all` → 0 at time of investigation).

## Date & severity

Reported 2026-10-12 as "Stripe is down." Not reproduced as a Stripe platform
issue — Stripe's own status page showed `All Systems Operational` throughout.

## What happened

A user-facing report of Stripe being broken. Investigation found the entire
*outbound* path (checkout session creation) healthy, but both Stripe webhook
receivers rejecting every delivery:

```
POST financial.nuwrrrld.com/api/webhooks/stripe        -> 500 {"error":"webhook not configured"}
POST {gcp3-backend-url}/webhooks/stripe -> 500 {"detail":"Webhook secret not configured"}
```

## Root cause

`STRIPE_WEBHOOK_SECRET` is still the placeholder value
(`whsec_placeholder…`) in both deployed environments — Vercel production for
the portal, and GCP Secret Manager for the `gcp3-backend` Cloud Run service.
Both receivers are written to fail closed on this exact condition
(`app/api/webhooks/stripe/route.ts:16-30`), returning a structured `500`
*before* attempting signature verification — which is why the response was a
config error (`webhook not configured`) rather than a signature error
(`invalid signature`, which a wrong-but-real secret would produce).

This directly **contradicts** the previous diagnosis in [[entity-billing]]'s
"Known failures," which stated no endpoint existed for the portal at all.
That was true at some earlier point; as of this incident, Stripe's
`GET /v1/webhook_endpoints` lists **two** endpoints, both `status=enabled` —
the portal's and the gcp3 backend's. `scripts/create-stripe-webhook.sh` was
evidently run since that bullet was written. The endpoint-provisioning gap is
closed; the secret-propagation gap is not.

Everything upstream of the webhook was confirmed healthy: live
`STRIPE_SECRET_KEY` valid (`GET /v1/balance`, `GET /v1/account` both 200,
`charges_enabled=true`), both `STRIPE_PRICE_MONTHLY`/`STRIPE_PRICE_ANNUAL`
active, production deployment current with `origin/main`. `/api/health`
reported `stripe: ok` throughout the incident — its `checkStripe()` validated
the key and both price IDs but never checked `STRIPE_WEBHOOK_SECRET`, so the
one check that would have caught this didn't exist.

A separate false lead surfaced during triage: unauthenticated probes of
`POST /api/stripe/checkout`, `POST /api/stripe/portal`, and
`GET /dashboard/billing` all returned `404`. This is **not a bug** —
`proxy.ts` lists those routes in `isProtectedApiRoute`/`isProtectedRoute`, and
Clerk's `auth.protect()` 404s an unauthenticated caller by design
(`proxy.ts:24-25`). Reproducing checkout requires a signed-in session.

## Resolution

**Code (PR #270, this repo):**
- `app/api/health/route.ts`'s `checkStripe()` gained a placeholder/unset check
  for `STRIPE_WEBHOOK_SECRET`, returning `not_configured` with an explicit
  error string — mirroring the existing `missingPrice` check a few lines
  above. This makes the exact failure in this incident self-reporting via
  `/api/health` going forward, instead of silently reading `ok`.

**Manual (outside this repo, not yet done as of this incident page):**
- Read the real signing secret for each endpoint from the Stripe Dashboard
  (the two endpoints have **different** secrets — the portal's and the gcp3
  backend's are not interchangeable) and push each into its respective
  deployed environment (Vercel production env var; GCP Secret Manager
  version + forced Cloud Run revision update, since `:latest` secret
  references resolve at instance start, not live).
- Full copy-paste remediation steps: `homebase/docs/stripe-down-nwf-2026-10-12.md`.

## Impact on design

- **`/api/health`'s Stripe check now covers the full lifecycle a transaction
  needs** — key validity, both price IDs, and the webhook signing secret —
  rather than only the outbound half. The inbound half (can Stripe tell us
  about the result of a checkout) had no health signal at all until this PR.
- Reinforces the pattern from [[incident-2026-07-27-stripe-checkout-invalid-header]]:
  a dependency that is reachable and authenticated can still be
  functionally dead for a *different* reason than connectivity, and health
  checks need one check per failure mode, not one check per dependency.
- [[entity-billing]]'s webhook-endpoint bullet is now split into a ✅
  resolved note (endpoint exists) and the current ⚠️ gap (secret
  placeholder), since the two were previously conflated under one
  diagnosis.

## Open items

- [ ] `STRIPE_WEBHOOK_SECRET` not yet rotated to a real value in Vercel
      production (manual step, owner-only).
- [ ] `STRIPE_WEBHOOK_SECRET` not yet rotated to a real value in gcp3's GCP
      Secret Manager, and the Cloud Run revision not yet forced to pick it up
      (manual step, owner-only).
- [ ] Once both are done: `curl https://financial.nuwrrrld.com/api/health`
      should show `stripe: "ok"`; a bogus-signature `POST` to each webhook
      route should return `400 invalid signature`, not `500`; then a live,
      signed-in checkout → `/dashboard/billing` click-through confirms
      entitlement sync end-to-end.
- ❓ Whether the two webhook endpoints' secrets were ever set correctly and
  later reverted, or never set since `scripts/create-stripe-webhook.sh` ran,
  was not determined — `GET /v1/events` returning 0 recent events is
  consistent with either.

## See also

- [[entity-billing]] — the Clerk + Stripe entity this incident updates
- [[incident-2026-07-27-stripe-checkout-invalid-header]] — the prior Stripe
  production incident on this same entity, same root-cause *shape*
  (deployed env var never reached the running environment) but a different
  variable
- `homebase/docs/stripe-down-nwf-2026-10-12.md` — full investigation + the
  step-by-step remediation doc (code + manual steps)
