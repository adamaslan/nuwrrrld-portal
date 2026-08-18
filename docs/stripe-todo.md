# Stripe — Open TODOs

Three variables from `.env.example`'s Stripe block are still placeholder or
empty in `.env.local`, and are what `bash scripts/sync-e2e-secrets.sh`
skips on every run. This doc says exactly where each one comes from — no
values here, only where to find/create them.

Related: `docs/env-rotation.md` (why `STRIPE_SECRET_KEY` needs rotating
separately from this — already exposed, unrelated to the three below),
`playwright-todo.md` blocker #4 (why these matter for the GHA secrets sync),
`lib/stripe.ts` (`PRICES` — where `STRIPE_PRICE_MONTHLY`/`ANNUAL` are read).

---

## `STRIPE_WEBHOOK_SECRET`

**Where to find it:** Stripe Dashboard → **Developers → Webhooks**.

**If the endpoint doesn't exist yet** → **Add endpoint**:

1. Endpoint URL: `https://financial.nuwrrrld.com/api/webhooks/stripe`
2. Select the events `app/api/webhooks/stripe/route.ts` actually handles
   (check that file for the exact event-type switch before picking events —
   don't just select "all events").
3. After creating the endpoint, Stripe shows the **signing secret** once
   (`whsec_...`) — copy it immediately, it's not re-displayed later.

**If the endpoint already exists** (e.g. from an earlier session) → click
it → **Reveal secret**, next to the signing secret field. This retrieves the
existing value without changing anything.

Only use **Roll secret** if you've genuinely lost access to the value or
suspect it's compromised — it immediately invalidates the old secret, so
only do that once the new value is set everywhere that needs it
(`.env.local`, Vercel, GHA secrets) or webhook delivery breaks in between.

Either way, paste the result into `.env.local` as
`STRIPE_WEBHOOK_SECRET=whsec_...`.

**Why it's currently a placeholder:** `.env.example`'s own comment already
explains the failure mode — until this is a real `whsec_...` value (not
`whsec_placeholder_*`), `/api/webhooks/stripe` logs a `CONFIG_ERROR` and
rejects every event, so subscription sync silently breaks. This has been the
state since at least the incident this repo's Stripe checkout hardening work
addressed (`docs/wiki-portal/incident-2026-07-27-stripe-checkout-invalid-header.md`).

**Test/dev environments:** if you want to test webhooks locally instead of
against the live endpoint above, use the Stripe CLI instead:
```
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```
This prints its own `whsec_...` value scoped to that CLI session — use that
for local dev, the dashboard-created one for production/Vercel.

---

## `STRIPE_PRICE_ANNUAL`

**Where to find it:** Stripe Dashboard → **Product catalog → Products**.

1. Check whether an annual price already exists on the same product as
   `STRIPE_PRICE_MONTHLY` (the monthly price is already set —
   `price_1ThMVmRo4oSNMCPPFw8OoSNn`-shaped, per `.env.example`'s comment
   pattern for the monthly line). Open that product to see its price list.
2. **If an annual price doesn't exist yet**, create one: on the product →
   **Add another price** → Recurring → Yearly. `.env.example`'s comment
   notes the monthly price was $9.99 — decide the annual price point (a
   discount off 12× monthly is the usual pattern, e.g. $79/yr vs. $119.88
   at the monthly rate) before creating it, since price objects in Stripe
   are immutable once created (you'd have to archive and recreate to change
   the amount later, and archiving affects only new subscriptions, not
   existing ones).
3. Copy the price ID (`price_...`) it generates.
4. Paste into `.env.local` as `STRIPE_PRICE_ANNUAL=price_...`.

**Why it matters:** `lib/stripe.ts`'s `PRICES.annual` reads this directly
(`process.env.STRIPE_PRICE_ANNUAL ?? ''`). `app/api/health/route.ts`'s
`checkStripe()` already treats an unset or placeholder-shaped price as
`not_configured` and flags it by name — that's the `e2e/health/*` test
tier's own signal that this is still open, no separate discovery needed.

---

## `PORTAL_PUSH_SECRET`

**Not a Stripe secret** — grouped here because it's the same shape of
problem (a value you generate yourself, not one you copy from a dashboard).

**Where it comes from:** you generate it, there's no external source:
```
openssl rand -hex 32
```

**What it's for** (per `.env.example`'s own comment, lines 54–65): a
shared-secret bearer token — not a Clerk session — used by two internal,
non-user-facing callers:
1. A local `refresh-signals.py` script pushing a pre-computed signals digest
   into cache via `POST /api/signals/refresh`.
2. Any trusted internal caller of `GET /api/signals/digest` with no Clerk
   session, authenticating via `Authorization: Bearer <PORTAL_PUSH_SECRET>`.

**Set the same generated value in two places** — this app's env, and
wherever the calling script/service reads its own copy of
`PORTAL_PUSH_SECRET` from (check `refresh-signals.py`'s own env config for
its variable name, which may or may not match exactly).

**Why it's currently unset:** if neither of the two callers above is
actually in use yet (no `refresh-signals.py` deployment, no external caller
of `/api/signals/digest`), there may be nothing forcing this to be filled in
— `/api/signals/refresh` just logs a `CONFIG_ERROR` and rejects pushes,
`/api/signals/digest` falls back to requiring a normal Clerk session. Decide
whether either caller is actually needed before generating a value just to
satisfy the placeholder-detection check.

---

## After filling these in

```bash
bash scripts/sync-e2e-secrets.sh --dry-run   # confirm all three would now push
bash scripts/sync-e2e-secrets.sh             # push to GHA secrets
```

Then re-check `docs/wiki-portal/entity-billing.md` and `docs/clerk-todos.md`
for anything downstream that assumed these were still unset — the wiki's
billing entity page may have known-failure notes tied to the placeholder
state that should close out once these are real.
