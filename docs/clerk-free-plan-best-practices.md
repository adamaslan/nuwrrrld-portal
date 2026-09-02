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

### `allowed_origins`

```bash
clerk api /instance --instance prod
```

This is the CORS allowlist for the Frontend API. If your subdomain is
already listed here, requests from it are already permitted — full stop.
**Check this before assuming you need to change anything.** In this app's
case, `financial.nuwrrrld.com` was already present, likely set up correctly
when the instance was first provisioned, and no further Clerk-side domain
config was needed at all.

### Cross-domain session behavior (same eTLD+1, non-satellite)

Clerk's session cookie is scoped to wherever the Frontend API domain lives
(`clerk.<primary-domain>`). A subdomain that isn't the Frontend API domain
doesn't automatically share that cookie by browser rules alone — but Clerk
handles this transparently for same-eTLD+1 subdomains without requiring the
paid satellite feature. This is different from genuinely separate root
domains (`example.com` and `unrelated-app.com`), which is the case satellite
domains actually exist for.

**Practical takeaway:** if your production app's domain is a subdomain of
the domain your Clerk instance is configured for, check `allowed_origins`
first. You may already be done.

---

## 3. `POST /instance/change_domain` is not "add a domain" — don't reach for it here

This is the mistake that cost the most time in this session, worth stating
plainly so it isn't repeated.

`/instance/change_domain` **renames the instance's single primary domain.**
It is for the case where you are migrating your whole Clerk instance from
one root domain to another (`old.com` → `new.com`) — not for adding a
second domain, a subdomain, or anything alongside the existing one.

Symptoms if you call it expecting it to "add" a subdomain instead of
replace the primary:

- Returns `HTTP 202 Accepted` — looks like it worked.
- The instance's `updated_at` timestamp changes — also looks like it worked.
- **But `GET /domains` never shows the new domain, and no new DNS/CNAME
  records are issued.** It silently does nothing, because the target domain
  in this scenario (a subdomain of the *existing* primary) doesn't represent
  a valid "new primary" in the way the endpoint expects, and there's no
  error surfaced back to tell you that.

If you're trying to solve "my app is on a subdomain and I'm not sure Clerk
knows about it," the answer is §2, not this endpoint. Reserve
`change_domain` for an actual full-domain migration, and expect real
downtime when you use it for that — Clerk's own docs are explicit:

> "Changing the domain can result in temporary downtime depending on your
> DNS provider's propagation times. After changing the domain, you must
> update your DNS records, generate new SSL certificates, update your
> Publishable Key, and adjust redirect URLs for any social connections."

---

## 4. The verified free-plan sequence: dev → prod, no code changes

If your production domain is a subdomain of Clerk's configured primary
domain (§2 applies) and you're on the free plan (§1 applies), the entire
cutover is a **key swap, nothing more**. No `clerkMiddleware` changes, no
`ClerkProvider` prop changes, no new Clerk Dashboard domain config —
assuming `deploy status` already reports complete (see §5).

```bash
# 1. Confirm the production instance is fully provisioned
clerk deploy status --mode agent
# Expect: "complete": true, dns/ssl/mail all "complete", oauth.complete: true

# 2. Confirm the subdomain is already allowed (§2) — if so, skip straight to keys
clerk api /instance --instance prod
# Look for your subdomain in allowed_origins

# 3. Pull live keys to a scratch file, never straight into chat or a command line
clerk env pull --instance prod --file /tmp/clerk-prod.env

# 4. Push to your hosting platform's production env (see secrets-sync skill
#    for the file→CLI pattern that never routes a value through an LLM)
vercel env rm NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --yes
vercel env rm CLERK_SECRET_KEY production --yes
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production < /tmp/pk.txt
vercel env add CLERK_SECRET_KEY production < /tmp/sk.txt
gh secret set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY < /tmp/pk.txt
gh secret set CLERK_SECRET_KEY < /tmp/sk.txt
shred -u /tmp/pk.txt /tmp/sk.txt /tmp/clerk-prod.env   # or: rm -P on macOS

# 5. Redeploy — env changes don't apply to existing deployments
vercel deploy --prod --yes

# 6. Verify against the live site, not just the CLI
curl -s https://<your-prod-domain>/api/health | jq '.clerk'
# Expect: {"status": "ok", ...}
```

`vercel env add` fails if the key already exists for that environment —
`rm` first, as above, rather than trying `env add --force` (not a flag Vercel
CLI 48.x supports for this command as of writing).

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
Worth replicating in any project doing this migration:

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

```bash
# Read-only — safe to run any time
clerk doctor --json
clerk deploy status --mode agent
clerk api /instance --instance prod        # check allowed_origins
clerk api /domains --instance prod         # check current primary domain

# Mutating — confirm with the user first, always --dry-run when unsure
clerk api /instance/change_domain -X POST --dry-run --instance prod \
  -d '{"home_url":"https://your-new-primary.com"}'
# ^ Only for an actual primary-domain migration. NOT for adding a subdomain
#   alongside an existing primary — see §3.

clerk env pull --instance prod --file /tmp/clerk-prod.env
```
