# Isolated Stripe billing validation

## Status and scope

Offline coverage added: actual Stripe SDK signature verification, fake Stripe lookups and fake Clerk writes. This is not a real Stripe sandbox checkout or Pro activation. Production stays untouched. No live subscription, config or money action is authorized by these instructions.

Fix: all exceptions processing webhook events now return HTTP 500, including failed customer.subscription.created/updated/deleted entitlement sync. Previously those paths returned 200 after logging a failure, losing Stripe retries. Re-delivery can retry the absolute metadata update. This is not exactly-once delivery or complete event-order protection.

## Ready now, no account access

```sh
npx vitest run --project unit __tests__/stripe-webhook.test.ts __tests__/stripe-checkout.test.ts __tests__/subscription.test.ts __tests__/subscription-admin.test.ts
```

The signature fixtures in the test are deliberately fake, not credentials. Missing/invalid signatures do not write metadata; signed trialing/active/past_due map to Pro; canceled/paused map to Free. Checkout and subscription sync failure/redelivery recovery are covered. Duplicate same-state delivery converges but still performs the write twice.

## Isolated environment, before actual integration

Use the provided stripe-sandbox.env.example as a private local config template. The app loads .env.local normally. Do not overwrite an existing environment or commit the configured file. An owner/developer must provide an already authorized Stripe sandbox and nonproduction Clerk instance/test user. Test Stripe with production Clerk is unsafe: this webhook changes Clerk metadata. Never send sandbox events to production. This test preparation does not provision accounts, prices or webhook destinations.

Once that isolated config exists:

```sh
node --env-file=.env.local scripts/stripe-sandbox-preflight.mjs
```

The preflight refuses live key shapes, production env/live app domain, missing nonproduction Clerk key shapes and missing signing secret. It makes only two read-only Stripe price lookups, requiring active recurring test prices. It logs no keys. A pass is NOT proof of Clerk key pairing, actual deployment config, correct webhook secret pairing or event delivery. Confirm those privately in the isolated accounts before test mutation. Never run the repository's production billing preflight as a sandbox isolation guarantee: it permits live keys.

For a local app, Stripe's authenticated CLI can forward **sandbox** events to localhost:3000/api/webhooks/stripe. Use the signing secret for that exact listener, not a different deployed endpoint. Follow the current CLI help for selecting the sandbox; do not use live mode. A deployed preview instead needs its own sandbox webhook destination/signing secret. No CLI login or destination setup has been performed by this PR.

## Actual integration checklist (not yet executed)

- Confirm isolated app URL, sandbox API objects, nonproduction Clerk instance and disposable test identity.
- Complete actual sandbox Checkout using official test payment details. This creates test objects, never a live charge. Correlate checkout.session.completed and subscription events with the same customer and Clerk test identity. Verify trial/Pro metadata and access through a genuine Pro-gated route, not just the success URL.
- Invalid/missing signature must return 400 without entitlement changes. Correct signature must deliver successfully. Simulate transient Clerk failure: delivery must return 500; replay and confirm recovery, including cancellation/revocation.
- Cancel before completing checkout: no new subscription entitlement. Test declines and 3DS using Stripe's official test values.
- Use sandbox test clocks for trial ending, renewal and failed renewal. Expected policy: past_due keeps Pro; canceled/paused becomes Free. Immediate cancellation and cancel-at-period-end have different timing; check both.
- Deliver the same event again and verify stable final state. Deliberately reordered events need a separate freshness/race test. This PR does not add a durable event ledger or prevent an older event overwriting newer state. Do not certify out-of-order safety based on the duplicate test.
- Record sandbox/preview identity (no secrets), event IDs/types, response codes, resulting test-user tier, actual gated-route result, failure/recovery and cleanup state. Do not forward real user/account data.

## Remaining limits

The local environment used to prepare this PR has no Stripe credentials/prices/signing secret. No authentic sandbox integration ran. Production health currently passes, but health only checks config presence plus API reachability, not successful checkout/signature/entitlement sync. Sandbox-only mode is a preflight safety check, not an app-wide production safety feature.

Sources: https://docs.stripe.com/testing/overview ; https://docs.stripe.com/billing/testing ; https://docs.stripe.com/webhooks . Stripe recommends actual test subscriptions for correlated lifecycle verification; synthetic CLI trigger fixtures alone do not match real customer/subscription state.
