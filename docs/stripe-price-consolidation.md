# Stripe price consolidation — annual checkout was broken in production

Found and fixed 2026-08-29, verified against the live Stripe API.

> Identifiers are written as `<PLACEHOLDER>` throughout. Real product and price
> IDs live in the Stripe dashboard and in `.env.local` / Vercel project env
> vars — never in a doc, a commit, or a chat transcript.

---

## The bug

`STRIPE_PRICE_ANNUAL` was the literal placeholder string — 24 chars, not
matching Stripe's `price_[A-Za-z0-9]{24,}` format, containing the substring
`placeholder`. At that moment **no annual price existed on the Stripe account at
all**, so this was not a copy-paste slip; the object was never created.

**What a user hit.** `/dashboard/upgrade` is a live page advertising annual
billing and rendering `CheckoutButton plan="annual"`. Clicking it calls
`POST /api/stripe/checkout`, where the guard at
[`app/api/stripe/checkout/route.ts:58`](../app/api/stripe/checkout/route.ts#L58)
matched `priceId.includes('placeholder')` and returned **HTTP 500**
`price not configured for plan: annual`.

Every annual upgrade attempt failed. Silently — monthly worked fine, nothing
alerts on this, and the guard degraded cleanly to a 500 rather than sending a
malformed ID to Stripe, so the account looked healthy from outside.

---

## The fix

Both plans are now prices on the **single** product `NuWrrrld_Monthly`
(`<STRIPE_PRODUCT_MAIN>` — formerly named "NuWrrrld Financial Pro"; same object,
renamed, so nothing referencing it broke).

**Why one product.** Stripe's subscription *update* flow — swapping a
subscription's price in place, with proration — works cleanly only within a
product. Across two products it degrades to cancel-and-resubscribe, which is
exactly what the upgrade page currently apologizes for: *"Your monthly
subscription will be cancelled and the annual plan starts immediately."* With
both prices on one product, that can become a true in-place upgrade later.

The tradeoff taken: the annual price became **$79.99** rather than a rounder $79,
because the consolidated price already existed at that amount.

### Live Stripe inventory (verified 2026-08-29)

| Product | Amount | State | Env var |
|---|---|---|---|
| `NuWrrrld_Monthly` `<STRIPE_PRODUCT_MAIN>` | $9.99/mo | **active** | `STRIPE_PRICE_MONTHLY` ✅ |
| `NuWrrrld_Monthly` `<STRIPE_PRODUCT_MAIN>` | $79.99/yr | **active** | `STRIPE_PRICE_ANNUAL` ✅ |
| `NuWrrrld_Monthly` `<STRIPE_PRODUCT_MAIN>` | $10.00/mo | archived | — (was the monthly) |
| `Nuwrrrld_Yearly` `<STRIPE_PRODUCT_YEARLY_OLD>` | $79.00/yr | active, **redundant** | — |

> **Stripe prices can never be deleted** — only archived (`active: false`).
> Archiving blocks new checkouts on that price; existing subscriptions on it keep
> billing normally and are unaffected. It is reversible.

---

## Pricing copy — reconciled

The UI hardcoded the old annual figures, which the $79.99 price invalidated.
Corrected in four files (`app/pricing/page.tsx`, `app/dashboard/upgrade/page.tsx`,
`app/dashboard/page.tsx`, `app/dashboard/billing/page.tsx`):

| Figure | Was | Now |
|---|---|---|
| Annual price | $79 | **$79.99** |
| Annual per-month | $6.58 | **$6.67** |
| Savings | $40.88 | **$39.89** |
| Savings % | 34% | **33%** |
| Monthly, monthly/yr | $9.99, $119.88 | unchanged (now genuinely correct) |

$119.88/yr stays right because the monthly is now actually $9.99 — the prior copy
happened to state the correct figure against a $10.00 live price.

---

## Handling secrets

No price ID or key was ever rendered into a chat transcript. Values moved
**file → CLI over stdin**, and verification compared checksums rather than
printing:

```bash
vercel env rm STRIPE_PRICE_MONTHLY production --yes
grep '^STRIPE_PRICE_MONTHLY=' .env.local | cut -d= -f2- | tr -d '"\n' \
  | vercel env add STRIPE_PRICE_MONTHLY production
```

`vercel env add` will **not** overwrite an existing variable — it must be removed
first. Both production vars already existed but were stale (61 and 72 days old,
predating the current prices), so adding without removing would have silently
kept the old values.

---

## Still to do

- [ ] **Archive the redundant `Nuwrrrld_Yearly` product** (`<STRIPE_PRODUCT_YEARLY_OLD>`).
      Its $79/yr price cannot be archived on its own — Stripe refuses with *"this
      price cannot be archived because it is the default price of its product."*
      Archive the **product** in the dashboard and the price goes inactive with
      it. Nothing references either any more.
- [ ] **Migrate or grandfather the existing $10.00/mo subscriber(s).** Archiving
      that price does **not** move anyone off it — they keep billing at $10.00
      until their subscription is explicitly updated to the $9.99 price.
- [ ] **Preview/development have no `STRIPE_PRICE_*` vars.** Harmless today
      (checkout 500s there on the guard rather than charging anything), but a
      preview deploy cannot exercise checkout. Add test-mode price IDs if that
      path needs testing off production.
- [ ] Verify via `GET /api/health` — `checkStripe()` explicitly flags an unset or
      placeholder price, so it should read `ok` rather than `not_configured`.
- [ ] Walk `/dashboard/upgrade` → checkout end to end against live Stripe. Not
      done here: completing it creates a real checkout session on a live account.
