# Clerk on the Free Plan — Dev to Production, Without Satellites or Surprises

Everything below was learned the hard way promoting this app's login from
Clerk's Development instance to Production on 2026-09-02. It's the
free-plan-specific playbook: what's actually available, what silently
no-ops, and the order of operations that avoids downtime.

Related: `docs/clerk-dev-to-prod.md` (the general dev→prod procedure this
guide supersedes the domain-strategy section of), `docs/clerk-todos.md`
(feature-level auth TODOs), `docs/env-rotation.md` (general credential
rotation).

---

## 1. Know your plan before you touch domains

**Satellite domains are a paid Clerk feature.** Confirmed directly in the
Clerk Dashboard on this project's account: the Domains page shows satellite
domains gated behind a paid tier, with only the single primary domain
available on free.

This matters because Clerk's own docs describe multi-domain setups
(`isSatellite: true` in `clerkMiddleware`/`ClerkProvider`, a `signInUrl`
pointing at a separate primary app) as the standard way to share auth across
two different root domains or apps. **On the free plan, that path doesn't
exist.** If you go looking for it — as this session initially did — you'll
successfully write the middleware config, and it'll just never work because
the Dashboard won't let the satellite domain be added.

**Check your plan first**: Dashboard → your instance → Domains. If you only
see one domain slot, you're free-tier, and everything below applies.

---

## 2. The subdomain case: you probably don't need satellites at all

The scenario that prompted this guide: one Clerk application, one
production instance, and the app lives on a **subdomain** of the domain
Clerk is configured for (e.g. Clerk's primary domain is `example.com`, the
app actually serves `app.example.com`).

The instinctive fix — "add the subdomain as a satellite" — is usually both
unavailable (see §1) and unnecessary. Two fields do the real work, and
neither is gated by plan:

### `allowed_origins` — necessary, but not the whole story

```bash
clerk api /instance --instance prod
```

`allowed_origins` is the Backend-API origin allowlist that lets non-standard,
browser-like clients (Chrome extensions, Electron, Capacitor) call the
Frontend API. It is **not** Clerk's web subdomain control. For a browser app
on a subdomain, the setting that matters is **Dashboard → your instance →
Domains → Allowed Subdomains**: by default the Frontend API accepts requests
from any subdomain of the production root domain, and the allowlist narrows
that. Verify `financial.nuwrrrld.com` there.

In this app's case, `financial.nuwrrrld.com` was already listed in
`allowed_origins` (likely from initial provisioning) and the web flow works
today — but don't read that as "`allowed_origins` alone permits the web
flow." Check the Allowed Subdomains setting too, and don't assume no further
Clerk-side config is possible.

### `authorizedParties` — set it explicitly

`middleware.ts` does not currently pass `authorizedParties` to
`clerkMiddleware`. With a root domain configured, Clerk trusts every
subdomain of it by default, which widens the surface for subdomain
cookie-leaking and CSRF. Add an explicit allowlist scoped to the real app
origin:

```ts
clerkMiddleware({ authorizedParties: ["https://financial.nuwrrrld.com"] })
```

### Cross-subdomain session behavior (same eTLD+1, non-satellite)

Clerk does **not** widen the `__session` cookie across same-root subdomains.
The Frontend API lives on `clerk.<primary-domain>` and its `client` cookie
is same-site there; a different subdomain gets no session cookie by browser
rules. For a request from one subdomain to an API on another, the frontend
SDK must call `getToken()` and send the returned session JWT as a
`Bearer` token in the `Authorization` header. This is distinct from
**Satellite Domains**, the paid feature that exists for genuinely separate
root domains (`example.com` ↔ `unrelated-app.com`) via a primary/satellite
handshake.

This app avoids the problem entirely: the browser app and the Clerk
Frontend API are on the same root domain, and the app's own API routes are
same-origin with the app — so no cross-subdomain token handoff is needed
here.

**Practical takeaway:** if your production app's domain is a subdomain of
the domain your Clerk instance is configured for, verify it in **Allowed
Subdomains**, set `authorizedParties`, and only reach for `getToken()` +
`Bearer` if you actually call an API on a *different* subdomain.

---

## 3. `POST /instance/change_domain` is not "add a domain" — don't reach for it here

This is the mistake that cost the most time in this session, worth stating
plainly so it isn't repeated.

`/instance/change_domain` changes the instance's `home_url`. Clerk *does*
support pointing an instance at a subdomain through it — the Dashboard flow
prompts you to pick **Primary** (app on the subdomain, Clerk infra stays on
the root) or **Secondary** (both on the subdomain), and the API takes
`is_secondary: true` for the latter. So the endpoint is not inherently
"root-domains only."

What actually happened here: calling it with
`home_url: https://financial.nuwrrrld.com` on *this* instance returned
`HTTP 202 Accepted`, bumped the instance's `updated_at`, and then did
nothing observable —

- `GET /domains` never showed a change.
- No new DNS/CNAME records were issued.

That is an **instance-specific no-op**, not proof that subdomains are
invalid or that the endpoint can only rename one primary domain. The likely
cause is that the request wasn't shaped as a Primary/Secondary subdomain
change (no `is_secondary`, and the root already resolved), so Clerk had
nothing to do — but it surfaced no error saying so. If you do use this
endpoint, **verify afterward** with `GET /domains` and
`clerk deploy status --mode agent` (DNS/SSL) rather than trusting the 202.

For the narrow problem this guide is about — "my app is on a subdomain of
Clerk's existing primary and I just need requests from it allowed" — §2 is
the answer and `change_domain` is unnecessary. Reserve it for an actual
`home_url` change, and expect real downtime — Clerk's own docs are
explicit:

> "Changing the domain can result in temporary downtime depending on your
> DNS provider's propagation times. After changing the domain, you must
> update your DNS records, generate new SSL certificates, update your
> Publishable Key, and adjust redirect URLs for any social connections."

---

## 4. The verified free-plan sequence: dev → prod, no code changes

If your production domain is a subdomain of Clerk's configured primary
domain (§2 applies) and you're on the free plan (§1 applies), the cutover
for **this app's current feature set** is a **key swap, nothing more**: no
`clerkMiddleware` changes, no `ClerkProvider` prop changes, no new Clerk
Dashboard domain config — assuming `deploy status` already reports complete
(see §5).

That "nothing more" is scoped to what this app uses today (session auth,
social sign-in, the health check). It is **not** a universal free-plan rule.
In particular, if you have **Clerk webhooks** enabled, production needs its
own webhook endpoint, production URL, and signing secret — development
webhook settings do not carry over, and `CLERK_WEBHOOK_SIGNING_SECRET` must
be repointed. Anything with its own dev-instance configuration (webhooks,
JWT templates, custom OAuth apps per §5 of `clerk-dev-to-prod.md`) is extra
work beyond the key swap.

All `clerk` commands below were run with `clerk@3.2.0`; pin the same version
(`npx -y clerk@3.2.0 …`) so the flags match — see `clerk-dev-to-prod.md` §1.

```bash
# 1. Confirm the production instance is fully provisioned
npx -y clerk@3.2.0 deploy status --mode agent
# Expect: "complete": true, dns/ssl/mail all "complete", oauth.complete: true

# 2. Confirm the subdomain (§2): check allowed_origins AND Dashboard →
#    Domains → Allowed Subdomains
npx -y clerk@3.2.0 api /instance --instance prod

# 3. Pull live keys to a scratch file, then derive the two key files from it
#    (never straight into chat or a command line)
npx -y clerk@3.2.0 env pull --instance prod --file /tmp/clerk-prod.env
grep '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' /tmp/clerk-prod.env | cut -d= -f2- > /tmp/pk.txt
grep '^CLERK_SECRET_KEY='                  /tmp/clerk-prod.env | cut -d= -f2- > /tmp/sk.txt
grep -q '^pk_live_' /tmp/pk.txt && grep -q '^sk_live_' /tmp/sk.txt \
  || { echo 'keys are not pk_live_/sk_live_ — stop'; exit 1; }

# 4. Push to your hosting platform's production env (see secrets-sync skill
#    for the file→CLI pattern that never routes a value through an LLM).
#    `vercel env add --force` upserts — no `env rm` first.
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --force < /tmp/pk.txt
vercel env add CLERK_SECRET_KEY production --force < /tmp/sk.txt
gh secret set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY < /tmp/pk.txt
gh secret set CLERK_SECRET_KEY < /tmp/sk.txt
shred -u /tmp/pk.txt /tmp/sk.txt /tmp/clerk-prod.env   # or: rm -P on macOS

# 5. Redeploy — env changes don't apply to existing deployments
vercel deploy --prod --yes

# 6. Verify against the live site, not just the CLI
curl -s https://<your-prod-domain>/api/health | jq '.clerk'
# Expect: {"status": "ok", ...}
```

Plain `vercel env add` errors if the variable already exists for that
environment; `--force` makes it an upsert (add or overwrite), which is why
the block above uses it and skips the `env rm` step entirely. Use one
consistent flow — `vercel env add … --force` — in both this guide and
`clerk-dev-to-prod.md` §5.

---

## 5. Prerequisite: `deploy status` must already say `complete: true`

None of §2–4 helps if the production instance itself isn't finished
provisioning. Check first:

```bash
clerk deploy status --mode agent
```

Expect:

```json
{
  "complete": true,
  "domainStatus": { "dns": "complete", "ssl": "complete", "mail": "complete" },
  "oauth": { "complete": true, "pending": [] }
}
```

If this isn't `complete: true`, stop — go run `clerk deploy` (interactive,
requires a real terminal, walks you through DNS CNAMEs and per-provider
OAuth app credentials) before attempting any key swap. See
`docs/clerk-dev-to-prod.md` §2 for what that wizard actually involves; it's
unchanged by anything in this guide, since it's about the *primary* domain's
own setup, not the subdomain question this guide addresses.

---

## 6. Guardrails worth having before you do this

Two checks in this repo caught the pre-cutover state and confirmed the
post-cutover state, without needing a manual dashboard check each time.
Worth replicating in any project doing this migration — but note both check
key **shape only** (the `pk_live_` prefix), not that Clerk accepts the
credentials. They prove the env var changed; they do not prove sign-in
works. Pair them with a real authentication smoke test (below).

**A health-check dependency that flags a dev key in production:**

```ts
// simplified from app/api/health/route.ts
if (process.env.VERCEL_ENV === "production" && key.startsWith("pk_test_")) {
  return { status: "degraded", error: "using a Clerk Development instance key (pk_test_...) in production" };
}
```

**A production-only E2E assertion:**

```ts
// e2e/preflight/credentials.spec.ts
test.skip(process.env.VERCEL_ENV !== "production", "production-only guard");
expect(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY!.startsWith("pk_live_")).toBe(true);
```

Both turned green immediately after the redeploy in this session, which was
the actual confirmation the migration worked — faster and more reliable
than eyeballing the Dashboard.

---

## 7. What breaks if you have dev-only E2E fixtures

Not specific to the free plan, but relevant to any dev→prod cutover: if your
E2E suite depends on a Clerk `+clerk_test` reserved address or Clerk's fixed
test OTP (`424242`), **those only work against a Development instance.**
Production has no equivalent built-in bypass. Keep local dev and E2E on the
dev instance's keys; only production's hosted env (Vercel/GitHub) needs the
live keys. See `docs/clerk-dev-to-prod.md` §6 for the full reasoning.

---

## Quick reference

All commands pinned to `clerk@3.2.0` (the tested version — see
`clerk-dev-to-prod.md` §1).

```bash
# Read-only — safe to run any time
npx -y clerk@3.2.0 doctor --json
npx -y clerk@3.2.0 deploy status --mode agent
npx -y clerk@3.2.0 api /instance --instance prod   # allowed_origins (BAPI origin allowlist)
npx -y clerk@3.2.0 api /domains --instance prod    # current home_url / primary domain
# Also check Dashboard → Domains → Allowed Subdomains (not exposed via CLI)

# Mutating — confirm with the user first, always --dry-run when unsure
npx -y clerk@3.2.0 api /instance/change_domain -X POST --dry-run --instance prod \
  -d '{"home_url":"https://your-new-primary.com"}'
# ^ Changes the instance home_url. Supports Primary/Secondary subdomains
#   (add "is_secondary": true for Secondary). Unnecessary for the §2 case —
#   verify GET /domains + deploy status afterward, don't trust the 202.

npx -y clerk@3.2.0 env pull --instance prod --file /tmp/clerk-prod.env
```
