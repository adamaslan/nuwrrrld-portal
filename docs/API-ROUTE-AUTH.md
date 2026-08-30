# API route auth classification

Source of truth for how every route under `app/api/` is authenticated.
Produced by Phase 1.3 of [docs/todo-auth-cookies-tracking.md](todo-auth-cookies-tracking.md).

Keep this table in sync with `isProtectedApiRoute` in [middleware.ts](../middleware.ts).

## Buckets

| Bucket | How it's authed | In the middleware matcher? |
|---|---|---|
| **auth-required** | Clerk session. Handler calls `auth()`; middleware `auth.protect()` is defense-in-depth so a handler regression fails closed. | Yes |
| **internal-secret** | `Authorization: Bearer <secret>`, timing-safe compare via `lib/http-auth.ts`. No Clerk session is ever presented. | No — `auth.protect()` would 404 the legitimate server-to-server caller |
| **webhook-signed** | Provider signature (svix for Clerk, `stripe.webhooks.constructEvent` for Stripe). The signature *is* the auth. | No — by design |
| **public** | None. Landing page, health check, cookieless demo. | No |

## Routes

| Route | Method(s) | Bucket | Secret / mechanism |
|---|---|---|---|
| `/api/analyze` | POST | auth-required | Clerk |
| `/api/backtest/[symbol]` | GET | auth-required | Clerk |
| `/api/brief` | POST | auth-required | Clerk |
| `/api/consent` | GET, POST | public* | first-party consent cookie; optional Clerk association |
| `/api/council` | POST | auth-required | Clerk |
| `/api/council/deliberate` | POST | auth-required | Clerk |
| `/api/council/public` | POST | public | cookieless demo, ticker-only, IP-hash daily quota |
| `/api/council/sample` | GET | public | cached SPY sample for the landing page |
| `/api/disclaimer` | GET, POST | auth-required | Clerk |
| `/api/feedback` | POST | public* | accepts anonymous; associates `userId` when present |
| `/api/health` | GET | public | dependency health probe, no secrets returned |
| `/api/holdfold` | GET | auth-required | Clerk |
| `/api/launch/remind` | POST | internal-secret | `LAUNCH_REMIND_SECRET` |
| `/api/legal-consent` | GET, POST | auth-required | Clerk |
| `/api/nuai` | POST | auth-required | Clerk |
| `/api/pipeline/hydrate-universe` | GET, PUT, POST | internal-secret | `PORTAL_PUSH_SECRET` |
| `/api/pipeline/precompute-ai` | POST | internal-secret | `PORTAL_PUSH_SECRET` |
| `/api/portfolio/health` | GET | auth-required | Clerk |
| `/api/portfolio/health-ai` | POST | auth-required | Clerk |
| `/api/portfolio/suggestions` | GET | auth-required | Clerk |
| `/api/portfolio/watchlist` | GET, POST | auth-required | Clerk |
| `/api/portfolio/watchlist/[ticker]` | DELETE | auth-required | Clerk |
| `/api/privacy/delete` | POST | auth-required | Clerk + two-step HMAC token (`PORTAL_PUSH_SECRET`) |
| `/api/privacy/export` | GET | auth-required | Clerk |
| `/api/privacy/profile` | GET | auth-required | Clerk |
| `/api/push/register` | POST | auth-required | Clerk |
| `/api/referral` | GET, POST | auth-required | Clerk |
| `/api/retention/digest-email` | POST | internal-secret | `CRON_SECRET` |
| `/api/retention/streak` | GET, POST | auth-required | Clerk |
| `/api/retention/trial-nudge` | POST | internal-secret | `CRON_SECRET` |
| `/api/signals/[ticker]/chat` | POST | auth-required | Clerk |
| `/api/signals/card` | GET | public | shareable SVG card, query params only |
| `/api/signals/digest` | GET | auth-required **or** internal-secret | Clerk session, or `PORTAL_PUSH_SECRET` for the digest push pipeline |
| `/api/signals/drain` | GET, POST | internal-secret | `PORTAL_PUSH_SECRET` |
| `/api/signals/live` | GET (public), POST (secret) | mixed | POST: `PORTAL_PUSH_SECRET`; GET: public price read |
| `/api/signals/refresh` | GET (public), POST (secret) | mixed | POST: `PORTAL_PUSH_SECRET` |
| `/api/signals/top` | GET | auth-required **or** internal-secret | Clerk session, or `PORTAL_PUSH_SECRET` for the precompute batch |
| `/api/stripe/checkout` | POST | auth-required | Clerk |
| `/api/stripe/portal` | POST | auth-required | Clerk |
| `/api/stripe/subscription` | GET | auth-required | Clerk |
| `/api/webhooks/clerk` | POST | webhook-signed | svix signature (`verifyWebhook`) |
| `/api/webhooks/stripe` | POST | webhook-signed | `STRIPE_WEBHOOK_SECRET` (`constructEvent`) |

\* `public*` = deliberately reachable without a session, but reads/associates a
Clerk `userId` opportunistically when one is present. Not added to the matcher
because an `auth.protect()` there would break the anonymous path.

## Notes

- **Timing-safe compares (Phase 1.3):** every `Bearer <secret>` check now goes
  through `bearerTokenMatches()` in [lib/http-auth.ts](../lib/http-auth.ts)
  instead of a plain `===` / `!==` on the header string. A plain string compare
  short-circuits at the first differing byte and leaks the secret one byte at a
  time under latency measurement.
- **`/api/council/sample` and `/api/council/public`** match the broad
  `/api/council(.*)` matcher entry but are explicitly excluded from
  `auth.protect()` via `isPublicCouncilRoute`.
- **Webhooks are never in the matcher.** Adding them would make Clerk's
  `auth.protect()` intercept the provider's unauthenticated-but-signed POST.
  The signature check in the handler is the real gate.
