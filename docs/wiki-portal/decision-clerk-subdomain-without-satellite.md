---
date: 2026-09-02
type: decision
tags: [auth, clerk, dns, production, deployment]
sources: [docs/clerk-free-plan-best-practices.md, docs/clerk-dev-to-prod.md, PR#96]
---

# decision: use `allowed_origins`, not satellite domains, for financial.nuwrrrld.com

## Decision

Production Clerk auth for this app (served at `financial.nuwrrrld.com`) does
**not** use Clerk's satellite-domain feature. It relies on
`financial.nuwrrrld.com` already being present in the production instance's
`allowed_origins` (confirmed via `GET /instance`), which was sufficient on
its own — no Clerk-side domain configuration change was needed. The
2026-09-02 cutover from `pk_test_` to `pk_live_` was therefore a pure key
swap: Vercel + GitHub Actions secrets updated, redeploy, verified via
`/api/health`.

## Date

2026-09-02

## Context

Clerk's production instance (`ins_3F16mRsfWlS41NinEiWfi4frXgo`) is configured
with primary domain `nuwrrrld.com`. This portal app, however, is served at
`financial.nuwrrrld.com` — the apex domain runs a **separate, unrelated app**
("NUWRRRLD - Futuristic Display") with no Clerk integration and no
`/sign-in` route (confirmed 404).

The first instinct was to treat this as a multi-domain problem and reach for
Clerk's satellite-domain feature (`isSatellite: true` in `clerkMiddleware`,
a `signInUrl` pointing at a primary app's `/sign-in`). That path turned out
to be doubly wrong:

1. **Satellite domains are gated behind a paid Clerk plan.** This app runs
   free/Hobby (see [[decision-self-implemented-totp-over-clerk-pro]] for the
   MFA instance of the same constraint). Confirmed directly in the
   Dashboard — the Domains page only exposes one domain slot on this plan.
2. **Even if it were available, satellite mode requires a real primary.**
   Clerk's docs specify the satellite's `signInUrl`/`signUpUrl` must point at
   the primary app's actual sign-in pages. `nuwrrrld.com/sign-in` returns
   404 — the apex app has no such pages. Satellite mode would have pointed
   users at a page that doesn't exist.

## Alternatives considered

- **Add `financial.nuwrrrld.com` as a satellite domain.** Rejected: not
  available on this plan, and would not have worked regardless (no primary
  sign-in page to redirect to).
- **`POST /instance/change_domain` with `financial.nuwrrrld.com` as the new
  home_url.** Attempted. Returned `HTTP 202 Accepted` and moved the
  instance's `updated_at` timestamp, but `GET /domains` never showed the
  change and no new CNAME records were issued — an **instance-specific silent
  no-op**. Note this is not evidence that `change_domain` rejects subdomains:
  Clerk does support Primary/Secondary subdomain applications through it
  (`is_secondary: true` for Secondary). The likely cause here is that the
  request wasn't shaped as such a change and the root already resolved, so
  there was nothing to do — but Clerk surfaced no error saying so. Left
  `nuwrrrld.com` unchanged as primary. No production impact — verified live
  before and after (and via `clerk deploy status`: DNS/SSL/`complete: true`
  unchanged) that `financial.nuwrrrld.com` kept serving normally. Takeaway:
  if this endpoint is ever used for real, verify with `GET /domains` +
  `deploy status` rather than trusting the `202`.
- **Add Clerk to the apex app too, then use it as a real satellite
  primary.** Considered, rejected as disproportionate: the apex app is
  unrelated to this portal, and building out Clerk there just to satisfy a
  paid feature this app doesn't have access to anyway is out of scope.
- **Check `allowed_origins` first** (chosen, after the above). `GET
  /instance` showed `financial.nuwrrrld.com` already listed alongside
  `nuwrrrld.com` and `www.nuwrrrld.com` — almost certainly set correctly
  when the instance was first provisioned, well before this session. Nothing
  further was needed on the Clerk side.

## Consequences

- **Zero code changes.** No `clerkMiddleware` or `ClerkProvider` changes —
  the app was never actually a satellite candidate; it's a normal
  single-domain Clerk consumer whose origin happens to be a subdomain of the
  instance's nominal primary domain.
- Production cutover reduced to: `clerk env pull --instance prod` → Vercel
  env update → GitHub Actions secret update → redeploy → verify
  `/api/health`. Fully scripted, no DNS/SSL work required (the primary
  domain `nuwrrrld.com`'s DNS/SSL/mail were already `complete` per
  `clerk deploy status`).
- `nuwrrrld.com` (Clerk's nominal primary domain) is not actually served by
  any app that uses this Clerk instance — the apex site is unrelated, and
  only `financial.nuwrrrld.com` uses it, via `allowed_origins`. This is a
  slightly unusual but working configuration; revisit only if the apex app
  ever needs its own auth.
- Documented as a reusable pattern in
  `docs/clerk-free-plan-best-practices.md` §2–3, since the
  `change_domain`-no-op trap in particular has no clear error message and
  would likely be hit again without a written record.

## Validated by

Two kinds of evidence, kept distinct:

**Key-shape checks** (config guard — prove the env var flipped, not that
auth works):
- `curl https://financial.nuwrrrld.com/api/health` → `clerk.status: "ok"`
  (was `degraded` with `"using a Clerk Development instance key (pk_test_...)
  in production"` before the fix)
- `curl https://financial.nuwrrrld.com/sign-in` → HTML served with a
  `pk_live_...` publishable key
- `clerk deploy status --mode agent` → `complete: true` throughout,
  unaffected by the failed `change_domain` attempt

**Completed sign-in** (proves the flow actually works): not separately
captured at cutover time — the key-shape checks above were treated as
sufficient. If revisiting, run a real incognito sign-in on
`financial.nuwrrrld.com` (email/password + each social provider → lands on
`/dashboard`, session survives reload, sign-out works) and record the
result here.

## See also

- [[entity-clerk]] — full entity page, the paid-plan constraint list
- [[decision-self-implemented-totp-over-clerk-pro]] — the other free-plan
  boundary hit on this same Clerk instance
- `docs/clerk-free-plan-best-practices.md` — standalone how-to guide this
  decision produced
- `docs/clerk-dev-to-prod.md` — general dev→prod procedure, now marked
  complete for this app
