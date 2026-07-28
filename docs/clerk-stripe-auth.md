# Clerk Auth & Stripe Billing

How authentication (Clerk) and subscription billing (Stripe) are wired into the
NuWrrrld portal, and the CLI commands to inspect, configure, and debug them.

- **Clerk** (`@clerk/nextjs@^7.5.2`) — identity, sessions, route protection.
- **Stripe** (`stripe@^22.2.1`, API `2026-05-27.dahlia`) — subscriptions, trials, billing portal.
- **The join point:** Clerk is the **source of truth for entitlements**. Stripe
  webhooks write subscription state into **Clerk user `publicMetadata`**; the app
  reads that metadata to gate features. There is no separate billing DB.

---

## 1. The big picture

```
Browser ──▶ middleware.ts (Clerk edge auth) ──▶ page / API route
                                                     │
                              auth() / currentUser() │ reads publicMetadata
                                                     ▼
                                       lib/subscription.ts (hasEntitlement)

Stripe event ──▶ /api/webhooks/stripe ──▶ syncSubscriptionToClerk()
                                                     │
                                       clerkClient().users.updateUserMetadata()
                                                     ▼
                                    Clerk publicMetadata.subscription_*  ← source of truth
```

Key files:

| Concern | File |
|---|---|
| Edge auth / route protection | `middleware.ts` |
| Clerk provider | `app/layout.tsx` (`<ClerkProvider>`) |
| Sign in / up | `app/sign-in/[[...sign-in]]/page.tsx`, `app/sign-up/[[...sign-up]]/page.tsx` |
| Stripe client | `lib/stripe.ts` |
| Entitlement model | `lib/subscription.ts` |
| Checkout | `app/api/stripe/checkout/route.ts` + `app/pricing/CheckoutButton.tsx` |
| Billing portal | `app/api/stripe/portal/route.ts` + `app/dashboard/billing/ManageBillingButton.tsx` |
| Subscription read API | `app/api/stripe/subscription/route.ts` |
| Stripe webhook (sync) | `app/api/webhooks/stripe/route.ts` |
| Clerk webhook (observability) | `app/api/webhooks/clerk/route.ts` |

---

## 2. Clerk auth

### Where it plugs in
- `app/layout.tsx` wraps the app in `<ClerkProvider>`.
- `middleware.ts` runs `clerkMiddleware`. Two matchers:
  - `isProtectedRoute` → `/dashboard(.*)` — `auth.protect()` at the edge.
  - `isProtectedApiRoute` → `/api/signals/digest`, `/api/portfolio/health`,
    `/api/holdfold` — defense-in-depth on top of each handler's own check.
    `/api/signals/digest` has one exception: internal server-to-server calls
    bearing `Authorization: Bearer $PORTAL_PUSH_SECRET` pass through.
- Inside routes: `const { userId } = await auth()` (401 if null) and
  `currentUser()` to read `publicMetadata`.

### Env (see `.env.example`)
```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=/dashboard
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=/dashboard
```

### Clerk CLI (`clerk` binary — the `clerk-cli` skill)

```bash
# Health-check config / keys resolution
clerk doctor

# Pull instance env keys into the local project
clerk env pull

# List / inspect users
clerk api GET /users --query 'limit=10'
clerk api GET /users/USER_ID

# Read a user's subscription metadata (the entitlement source of truth)
clerk api GET /users/USER_ID | jq '.public_metadata'

# Manually set a user's tier (e.g. comp a Pro seat) — mirrors what the
# Stripe webhook writes; keys must match lib/subscription.ts exactly
clerk api PATCH /users/USER_ID \
  --data '{"public_metadata":{"subscription_status":"active","subscription_tier":"pro"}}'

# Deploy verification
clerk deploy status
```

> Prefer the `clerk` CLI over raw `curl` to the Clerk API — it resolves keys,
> app/instance targeting, and formatting automatically.

Raw-HTTP equivalent (if the CLI isn't installed):
```bash
curl -s https://api.clerk.com/v1/users/USER_ID \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" | jq '.public_metadata'
```

### Clerk webhook
`app/api/webhooks/clerk/route.ts` verifies signatures with `verifyWebhook`
(uses `svix`) and currently only **logs** events. Stripe customer creation is
lazy (on first billing action), so no user-created handler is needed yet.

---

## 3. Stripe billing

### Entitlement model — `lib/subscription.ts`
Single-sourced across web + mobile. Highlights:

- Tiers: `free` | `pro`. Statuses: `free | trialing | active | past_due | canceled | paused`.
- `tierFromStatus()` → `active`/`trialing`/`past_due` map to **pro**; everything else **free**.
- `FEATURE_TIER_MAP` gates features (`nu_ai`, `signals_digest`,
  `portfolio_suggestions`, `watchlist_alerts`, `morning_briefing`, etc.).
- `hasEntitlement(feature, tier)` is the one gate used everywhere.
- Trial: `TRIAL_DAYS = 7`, expiry derived from Stripe's `trial_end`, never a local timer.

Example gate (`app/api/nuai/route.ts`):
```ts
const status = (user?.publicMetadata?.subscription_status as SubscriptionStatus) ?? "free";
const tier = tierFromStatus(status);
if (!hasEntitlement("nu_ai", tier)) {
  return NextResponse.json({ error: "upgrade_required", upgradeUrl: "/pricing?source=nuai" }, { status: 403 });
}
```

### Env (see `.env.example`)
```bash
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=      # from `stripe listen` or the dashboard endpoint
STRIPE_PRICE_MONTHLY=       # real price_… id, not a placeholder
STRIPE_PRICE_ANNUAL=
```
`lib/stripe.ts` lazily builds the client and reads `PRICES.monthly/annual`.
Checkout and the webhook both **loudly log `CONFIG_ERROR`** if a price or the
webhook secret is unset/placeholder.

### The three Stripe routes

1. **Checkout** — `POST /api/stripe/checkout`
   - Requires Clerk auth. Body `{ plan: "monthly" | "annual" }`.
   - Creates a `mode: 'subscription'` Checkout Session with a **7-day trial**
     (`trial_period_days: TRIAL_DAYS`), stamps `clerk_user_id` into session +
     subscription metadata, attaches an existing `stripe_customer_id` if present.
   - Returns `{ url }`; `CheckoutButton.tsx` redirects the browser there. 401 → sign-in.

2. **Billing portal** — `POST /api/stripe/portal`
   - **Lazy customer provisioning:** creates the Stripe customer on first use,
     writes `stripe_customer_id` back to Clerk `publicMetadata`.
   - Returns a `billingPortal` session `url`; `ManageBillingButton.tsx` redirects.

3. **Subscription read** — `GET /api/stripe/subscription`
   - Reads `publicMetadata` and returns a `SubscriptionState` (status, tier, trialEnd).

### The webhook — `POST /api/webhooks/stripe` (the sync engine)
Verifies the `stripe-signature` with `STRIPE_WEBHOOK_SECRET`, then handles:

- `customer.subscription.created | updated | deleted` → `syncSubscriptionToClerk()`
- `checkout.session.completed` → stamps `clerk_user_id` on the Customer, then syncs.
  Returns **500 on failure so Stripe retries** (missed entitlement sync is unrecoverable).
- `invoice.payment_failed` → logged; `past_due` arrives later via `subscription.updated`.

`syncSubscriptionToClerk()` resolves the Clerk user via the customer's
`clerk_user_id` metadata and writes `subscription_status`, `subscription_tier`,
`trial_end`, `stripe_*_id`, `current_period_end` into `publicMetadata`.

### Stripe CLI

```bash
# Auth
stripe login

# Forward live events to the local webhook — prints the whsec_… to use as
# STRIPE_WEBHOOK_SECRET during dev
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Fire test events at the running handler
stripe trigger checkout.session.completed
stripe trigger customer.subscription.updated
stripe trigger customer.subscription.deleted
stripe trigger invoice.payment_failed

# Inspect config / objects
stripe prices list --limit 10          # get the price_… ids for STRIPE_PRICE_*
stripe products list
stripe customers list --limit 5
stripe customers retrieve cus_XXX       # check metadata.clerk_user_id
stripe subscriptions list --status trialing
stripe events list --limit 10           # recent webhook deliveries
stripe events resend evt_XXX            # replay a failed sync
```

Create the production webhook endpoint (or via the dashboard: Developers →
Webhooks → Add endpoint → `https://financial.nuwrrrld.com/api/webhooks/stripe`):
```bash
stripe webhook_endpoints create \
  --url https://financial.nuwrrrld.com/api/webhooks/stripe \
  --enabled-events customer.subscription.created \
  --enabled-events customer.subscription.updated \
  --enabled-events customer.subscription.deleted \
  --enabled-events checkout.session.completed \
  --enabled-events invoice.payment_failed
```

### `publicMetadata` schema (the contract)
Written by the webhook, read by the app. Keys are `subscription_`-prefixed to
avoid collisions (`SubscriptionMetadata` in `lib/subscription.ts`):

| Key | Type | Source | Notes |
|---|---|---|---|
| `stripe_customer_id` | string | webhook / lazy portal provisioning | links Clerk ↔ Stripe |
| `stripe_subscription_id` | string? | `syncSubscriptionToClerk` | current sub |
| `subscription_status` | `SubscriptionStatus` | Stripe `sub.status` | drives the gate |
| `subscription_tier` | `free`\|`pro` | `tierFromStatus()` | derived, denormalized |
| `trial_end` | number? (unix s) | Stripe `trial_end` | never a local timer |
| `current_period_end` | number? (unix s) | `sub.items[0].current_period_end` | renewal boundary |

### Status → tier mapping (`tierFromStatus`)

| Stripe status | Effective tier | Access |
|---|---|---|
| `trialing` | pro | full (7-day trial) |
| `active` | pro | full |
| `past_due` | pro | **retained** — Smart Retries in flight |
| `canceled` | free | locked |
| `paused` | free | locked |
| `free` / none | free | base features only |

> Access is deliberately generous on `past_due`: a failed renewal charge keeps
> Pro until Stripe exhausts retries and flips the sub to `canceled`.

---

## 4. End-to-end lifecycle

1. User signs up via Clerk (`/sign-up`) → lands on `/dashboard`.
2. Clicks upgrade → `POST /api/stripe/checkout` → Stripe Checkout (7-day trial).
3. Stripe fires `checkout.session.completed` + `customer.subscription.created`.
4. `/api/webhooks/stripe` stamps `clerk_user_id` on the customer and calls
   `syncSubscriptionToClerk()` → writes `subscription_tier: 'pro'` to Clerk.
5. App reads `publicMetadata` via `currentUser()`; `hasEntitlement()` unlocks Pro features.
6. Trial ends / card fails / cancels → Stripe emits `subscription.updated` →
   webhook re-syncs status (`active` / `past_due` / `canceled`) → tier recomputed.
7. User manages/cancels via `POST /api/stripe/portal` (Stripe-hosted portal).

---

## 5. Common debugging

```bash
# "Feature is locked but I'm subscribed" → check the metadata Stripe wrote
clerk api GET /users/USER_ID | jq '.public_metadata'
stripe customers retrieve cus_XXX | jq '.metadata'   # must have clerk_user_id

# Webhook not syncing → verify secret + replay
stripe listen --print-secret               # local dev secret
stripe events list --limit 5
stripe events resend evt_XXX

# Checkout 500 with CONFIG_ERROR → price id unset/placeholder
stripe prices list --limit 10              # confirm STRIPE_PRICE_MONTHLY/ANNUAL

# Verify env on Vercel
vercel env ls
```

**Gotchas**
- `publicMetadata` keys must match `lib/subscription.ts` **exactly**
  (`subscription_status`, `subscription_tier`, `trial_end`, `stripe_customer_id`).
- A subscription can't sync until the customer carries `clerk_user_id` — set on
  `checkout.session.completed`. Manual customers need it added by hand.
- `checkout.session.completed` failures return 500 **on purpose** (Stripe retries).
- Placeholder `whsec_placeholder*` / placeholder price ids trigger loud
  `CONFIG_ERROR` logs rather than silent drops.
- `publicMetadata` is client-readable — it holds tier/status only, never secrets.
  Server routes still re-derive the gate; never trust a client-sent tier.

---

## 6. Security & trust boundaries
- **Two webhook signatures, two libs:** Stripe verifies `stripe-signature` with
  `constructEvent`; Clerk verifies via `verifyWebhook` (svix). Both reject
  unsigned/forged payloads with 400 before any handler logic runs.
- **`PORTAL_PUSH_SECRET`** is a shared bearer secret, *not* a Clerk session —
  the only unauthenticated path into a protected API route (internal digest push).
- **Read the webhook body raw:** `await req.text()` (not `.json()`) — signature
  verification needs the exact bytes; parsing first breaks it.
- **Defense in depth:** middleware `auth.protect()` *and* the per-handler
  `auth()` check both run, so a handler-level regression fails closed.
- **Never** commit real Clerk/Stripe keys; `.env.example` ships blank/placeholders.

---

## 7. Local smoke test (CLI)

```bash
# 1. Terminal A — run the app
npm run dev

# 2. Terminal B — forward Stripe events, copy the printed whsec_… into .env.local
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# 3. Terminal C — drive the flow and watch Terminal A logs for the sync line
stripe trigger checkout.session.completed      # → "Synced subscription … pro"
stripe trigger customer.subscription.deleted   # → tier back to free

# 4. Confirm the write landed in Clerk
clerk api GET /users/USER_ID | jq '.public_metadata'
```
Expect a `Synced subscription <id> <status> <tier> to Clerk user <uid>` log line
from `syncSubscriptionToClerk` on success.
