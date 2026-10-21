# R01 — production release-gate audit

**Observed:** 2026-10-21, America/New_York. Initial production health payload timestamp: `2026-10-21T18:02:13.338Z`; fresh follow-up timestamp: `2026-10-21T18:42:24.591Z` (14:42 EDT).
**Source snapshot:** portal `origin/main` at `e2b7ba9`.
**Scope:** read-only Clerk, billing, monitoring, and privacy/retention release-gate evidence. No credentials were read; private account details observed in the browser were not recorded. No checkout, billing mutation, webhook POST, production setting, deployment, or database write was performed.

The extended `docs/nwf-production-audit-2026-10-14.md` referenced by the production-audit skill was not present in the Homebase checkout, but its remote-branch copy was available and reviewed. This is an R01-focused gate audit, not the skill's full route-by-route production audit. Browser viewport, network conditions, LCP/CLS, and rendering timings were not instrumented; no performance claims are made.

## Live evidence

Read-only `GET https://financial.nuwrrrld.com/api/health` snapshots returned overall `degraded` at both 18:02Z and 18:42Z:

| Check | Result | Meaning for R01 |
|---|---|---|
| Clerk | `ok` | The health route's narrow key check passed. This does not prove MFA, production session policy, sign-up, or cross-surface revocation. |
| Stripe | `not_configured` | The response says `STRIPE_WEBHOOK_SECRET` is unset or a placeholder and webhook events will 500. The route does not reveal secret values. This is a verified production billing blocker. |
| Neon | `ok` | A bounded read-only `SELECT 1` succeeded. This is not a backup/restore test. |
| Market backend (`mcp`) | `degraded` / unreachable at 18:02Z; `ok` at 18:42Z | The later point-in-time health snapshot reports `mcp: ok`. This does not establish sustained recovery; the health route did not disclose a backend hostname. |
| Ticker cards | `degraded` | Latest bar remains `2026-10-14`, five NYSE sessions old as of the 18:42Z probe. This is materially stale production data. |
| OpenRouter | `ok` | A model-catalog request succeeded; this does not settle vendor retention terms. |

The public `/pricing` page displayed `$9.99/month`, `$79.99/year`, a 7-day trial, and “Cancel anytime.” Those are displayed terms only; live-mode Stripe price IDs and checkout are unverified. The browser already had a persistent signed-in session: navigating `/` reached `/dashboard`. That confirms this browser's existing session can reach the dashboard, but does not verify a fresh sign-in, MFA, session lifetime, or signup. The page's private account details were not recorded.

## Gate status

| Gate | Evidence status | What remains |
|---|---|---|
| Clerk production login, MFA, and session policy | **BLOCKED** | Current health says `clerk: ok`, and an existing browser session reached `/dashboard`. No fresh login, MFA challenge, cookie attributes, session-expiry test, JWT-template review, or mobile revocation test was performed. Clerk dashboard configuration is not observable from this checkout. |
| Stripe webhook and production billing | **VERIFIED BLOCKER** | Production health reports the webhook secret is unset/placeholder. `app/api/webhooks/stripe/route.ts` fails closed with HTTP 500 until configured. The manual setup guide says portal and gcp3 endpoints require distinct signing secrets. Do not rotate or replace them without the required explicit owner confirmation. Live price IDs, paid signup, subscription sync, cancellation, and downgrade were not tested; no checkout or payment action was taken. |
| Error monitoring | **NOT CONFIGURED IN REPO; EXTERNAL STATE NOT CHECKED** | In source snapshot `e2b7ba9`, app error boundaries only log to `console.error`; no Sentry client/config was found in `package.json`, `next.config.ts`, or app source. Vercel and third-party monitoring dashboards were not inspected. |
| External uptime monitoring | **NOT CHECKED** | No monitor configuration was found in the app source and workflows checked. The Vercel/third-party monitoring dashboards and infrastructure configuration were not inspected. |
| Privacy/vendor/retention | **VERIFIED OPEN IN ENGINEERING REGISTER; OWNER/LEGAL GATES BLOCKED** | `docs/privacy-register.md` marks Clerk, Neon, Vercel, Stripe, OpenRouter, Anthropic, and Resend DPAs as unverified. It says the retention-enforcement job does not exist and prompt/message retention is not enforced. Qualified policy review and vendor-contract confirmation remain owner/legal decisions. |
| Stored production access settings | **NOT CHECKED** | Vercel, Clerk, Stripe, and Cloud Run dashboards were not accessed. No environment values were read. |

**Code-level MFA finding:** `canPerformAdminAction()` in `lib/nulogdash.ts`
requires Clerk's `twoFactorEnabled` only when `NULOGDASH_REQUIRE_MFA=true`.
The source comment says the owner left that switch off until admins enroll;
the self-owned TOTP path is still a design plan, not an implementation. The
production setting was not inspected, so this does not establish the currently
deployed admin mutation gate. It does establish that MFA enforcement is
conditional in code and needs explicit owner review.

## Safe next steps and acceptance evidence

1. Have the owner review the exact Clerk production instance, MFA availability,
   session lifetime/inactivity, JWT templates, and mobile-sharing decision in
   Clerk Dashboard. Also inspect the deployed `NULOGDASH_REQUIRE_MFA` setting
   and decide how to handle the currently unimplemented self-owned TOTP plan.
   Then test a fresh sign-in and session behavior with an authorized test
   account.
2. Repair Stripe only after the owner explicitly approves the specific endpoint-secret change and deployment. Verify the portal and gcp3 endpoints independently, then verify one test-mode paid signup and cancellation/downgrade using a designated test account. Do not use a live charge for this audit.
3. Have the owner identify the chosen external error and uptime monitors, verify alert delivery, and record their production targets without copying credentials into this report.
4. Resolve the DPA, LLM-retention, policy-review, and retention-enforcement decisions with the data owner and qualified counsel; update `docs/privacy-register.md` only after decisions are evidenced.
5. Re-run the public health check after approved changes. Current evidence can be reproduced with this read-only request:

```bash
curl --silent --show-error --max-time 20 https://financial.nuwrrrld.com/api/health \
  | jq '{ts, status, clerk: .clerk.status, stripe: .stripe.status, cards: .cards, mcp: .mcp.status}'
```

Expected before the Stripe gate is repaired: `stripe` is `not_configured`; the current response reports overall `degraded` and stale cards. The earlier market-backend failure returned `mcp: ok` on the 18:42Z follow-up; verify sustained availability separately. A successful health response alone is not acceptance evidence for MFA, billing lifecycle behavior, alert delivery, backups, or privacy decisions.

**R01 remains open.** The strongest current finding is the production Stripe webhook misconfiguration; no owner or production gate was changed.
