---
date: 2026-09-02
type: entity
tags: [auth, clerk, sessions, oauth, billing]
sources: [middleware.ts, lib/env.ts, app/api/health/route.ts, docs/clerk-dev-to-prod.md, docs/clerk-free-plan-best-practices.md, PR#96]
---

# entity: Clerk

## What it is

Identity provider for the whole app — sessions, sign-in/sign-up UI, social
OAuth, and the `publicMetadata` entitlement model [[entity-billing]] reads
from. Runs on Clerk's **free/Hobby plan** (confirmed both by
[[decision-self-implemented-totp-over-clerk-pro]], which documents MFA being
paid-gated, and directly in the Dashboard during the 2026-09-02 production
cutover, where satellite domains showed as a paid-only feature).

One Clerk application ("NuWrrrld Financial", `app_3F0z8TMHrk9edG0A41z3yNTles9`)
with two instances:

- **Development** (`ins_3F0z8RjA81olOCoXwLggiGvrqsX`) — `pk_test_`/`sk_test_`,
  used for local dev and the E2E suite (`e2e/auth.setup.ts` depends on the
  reserved `+clerk_test` address and fixed OTP `424242`, both dev-instance-only
  features).
- **Production** (`ins_3F16mRsfWlS41NinEiWfi4frXgo`) — `pk_live_`/`sk_live_`,
  configured with primary domain `nuwrrrld.com`, live on `financial.nuwrrrld.com`
  since 2026-09-02.

`middleware.ts` wraps every route in `clerkMiddleware`, splits protected
routes (`/dashboard`, most of `/api/*`) from public/internal-secret/
webhook-signed routes — see `docs/API-ROUTE-AUTH.md` for the full
classification table.

## Where used

- `middleware.ts` — edge-level route protection, `auth.protect()`.
- `app/api/webhooks/clerk/route.ts` — syncs user/org events (see
  [[entity-billing]] for the subscription metadata this writes).
- `app/api/health/route.ts` — dependency health check; flags a dev key
  (`pk_test_`) running under `VERCEL_ENV === "production"` as `degraded`. This
  guard is what caught the pre-cutover misconfiguration on 2026-09-02.
- `lib/nulogdash.ts` — `canPerformAdminAction` reads `user.twoFactorEnabled`,
  permanently `false` on this plan per
  [[decision-self-implemented-totp-over-clerk-pro]].
- `lib/env.ts` — `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`
  required at boot via zod schema.

## Known failures

- **Satellite domains are unavailable on this plan.** An attempt to wire
  `financial.nuwrrrld.com` as a satellite of `nuwrrrld.com` during the
  2026-09-02 cutover found the Dashboard gates satellite domains behind a
  paid tier — confirmed directly, not inferred. See
  [[decision-clerk-subdomain-without-satellite]].
- **`POST /instance/change_domain` silently no-ops when misused.** Called
  expecting it to register `financial.nuwrrrld.com` alongside the existing
  primary domain; it returned `HTTP 202` and moved the instance's
  `updated_at`, but `GET /domains` never reflected a change and no new DNS
  records were issued. The endpoint renames the single primary domain — it
  is not additive. No error was surfaced to explain the no-op. See
  [[decision-clerk-subdomain-without-satellite]] for the full account and the
  fix that actually worked (`allowed_origins` was already correct).
- MFA is unavailable on this plan (Pro-gated), permanently blocking the
  nulogdash admin console's mutation gate until
  [[decision-self-implemented-totp-over-clerk-pro]] ships.

## Open questions

- `docs/clerk-todos.md` P0/P1 items (webhook hardening, admin audit trail)
  remain open — unrelated to the domain/key work in PR#96.
- Whether `nuwrrrld.com` (the separate "NUWRRRLD - Futuristic Display" app at
  the apex domain, unrelated to this portal) will ever need its own Clerk
  integration is unresolved; as of 2026-09-02 it has none, and Clerk's
  production instance's primary-domain config (`nuwrrrld.com`) is not
  actually served by any app that uses it — only the `financial.` subdomain,
  via `allowed_origins`, does.

## See also

- [[entity-billing]] — the Clerk/Stripe entitlement model this identity layer
  backs
- [[decision-self-implemented-totp-over-clerk-pro]] — the other major
  free-plan limitation hit on this Clerk instance
- [[decision-clerk-subdomain-without-satellite]] — the 2026-09-02 production
  cutover: what was tried, what silently failed, what actually worked
- `docs/clerk-free-plan-best-practices.md` — the standalone how-to this
  cutover produced
- `docs/clerk-dev-to-prod.md` — the general dev→prod procedure
- `docs/API-ROUTE-AUTH.md` — the full route auth classification table
