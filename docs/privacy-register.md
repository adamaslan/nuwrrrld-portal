# Privacy register — cookies, processors, retention, legal bases

**Status: engineering source of truth. NOT yet reflected in the shipped policy.**

Phase 7 of [docs/todo-auth-cookies-tracking.md](todo-auth-cookies-tracking.md)
asks for four things the current [app/privacy-policy/page.tsx](../app/privacy-policy/page.tsx)
lacks: a named cookie table, a named processor list, a retention table, and a
legal basis per purpose. This file is those four things, written from what the
code **actually does** as of this commit.

It deliberately stops short of rewriting the policy page. Plan §7 requires a
qualified pre-launch review before the policy changes, and the policy is a legal
document — an engineer's read of GDPR/CPRA is not sufficient to ship one. Use
this register as the input to that review, then generate the policy sections
from it.

**Do not let this file drift from the code.** If you add a cookie, a processor,
or a retention job, update the matching row here in the same PR.

---

## 1. Cookies and local storage we set ourselves

| Name | Purpose | Category | Duration | Party | HttpOnly |
|---|---|---|---|---|---|
| `nu_consent` | Stores the user's per-category consent choices + version | `strictly_necessary` (it records the choice itself) | ~400 days | first | no — client tag-gating must read it |
| `nu_attrib` | First-touch acquisition source (UTM / gclid / fbclid / referrer) | `analytics` | 90 days | first | no |
| `__session` | Clerk authenticated session | `strictly_necessary` | Clerk-managed | first | yes |
| `__client_uat` | Clerk session freshness hint | `strictly_necessary` | Clerk-managed | first | no |

No other cookies are set by application code. There are **no** third-party
cookies, no ad pixels, and no analytics vendor cookies at this commit.

## 2. Processors

| Processor | Purpose | Data categories | Region | DPA | Notes |
|---|---|---|---|---|---|
| Clerk | Authentication, session, user metadata | identifiers, auth events | US | *verify* | Holds email, referral codes, streak state |
| Neon (Postgres) | Primary application database | identifiers, behavioral, financial | *verify* | *verify* | The only store for financial fields |
| Vercel | Hosting, edge, runtime logs | request metadata, IP | US/edge | *verify* | Logs must never contain prompt bodies or holdings |
| Stripe | Billing and subscriptions | identifiers, payment | US | *verify* | 7-year statutory billing retention |
| OpenRouter | LLM routing for council/NuAI | user prompt text, portfolio context | varies by upstream | **verify — highest priority** | See §5 |
| Anthropic | LLM inference (via OpenRouter or direct) | user prompt text | US | **verify** | See §5 |
| Finnhub | Market data | none (ticker symbols only) | US | n/a | No user data leaves to Finnhub |
| Resend | Transactional + digest email | email address | US | *verify* | |
| Modal | Scheduled hydration/drain jobs | none (ticker symbols only) | US | n/a | Holds `PORTAL_PUSH_SECRET` |

`*verify*` = a DPA is assumed but has **not** been confirmed in writing by
anyone on this project. Confirming these is a Phase 7 task, not an engineering
one.

## 3. Retention

Target state from plan §5.3. **The enforcement job does not exist yet** — do not
publish this table in the policy until it does, or the policy will over-promise
exactly the way §6 already does.

| Class | Target retention | Enforced today? |
|---|---|---|
| Raw analytics events | 14 months | n/a — no analytics vendor yet |
| Session / auth logs | 90 days | no — Vercel default |
| AI prompts & council messages | 12 months, then delete or anonymise | **no** |
| Aggregated profile attributes | life of account + 30 days | no |
| Consent records | life of account + 6 years (evidentiary) | partially — never deleted |
| DSAR ledger (`privacy_requests`) | life of account + 6 years | yes — outside the erasure cascade by design |
| Billing records | 7 years (tax/legal) | yes — Stripe, excluded from erasure |

## 4. Legal basis per purpose (GDPR Art. 6)

| Purpose | Basis |
|---|---|
| Authenticate a user, maintain a session | Contract (Art. 6(1)(b)) |
| Provide signals, council, portfolio features | Contract |
| Billing and subscription management | Contract + legal obligation (tax) |
| Store consent choices | Legal obligation (Art. 7(1) — proving consent) |
| Product analytics | **Consent** (Art. 6(1)(a)) — `analytics` category |
| First-party acquisition attribution | **Consent** — `analytics` category |
| Advertising / conversion tracking | **Consent** — `marketing` category (nothing ships yet) |
| Security, abuse prevention, rate limiting | Legitimate interest (Art. 6(1)(f)) |
| Transactional email | Contract |
| Digest / retention email | Consent or legitimate interest — **needs the review's call** |

## 5. The LLM question (plan §5.4, flagged as the underrated one)

`app/api/council/*` and `app/api/nuai/*` transmit **user prompt text and
watchlist-derived context** to OpenRouter, which routes to upstream model
providers. This is the largest outbound flow of user-authored content in the
system.

What must be established before the policy can state anything about it:

- [ ] Does the OpenRouter account have zero-retention terms in writing?
- [ ] Do the upstream providers in the free-model chain (`lib/openrouter.ts`)
      each disclaim training on API inputs? The chain changes — a model swap can
      silently change the answer.
- [ ] Is there a signed DPA with OpenRouter?

Until those are answered, the policy should say plainly that prompts are sent to
third-party model providers, rather than implying a guarantee that has not been
contracted.

## 6. What the current policy says that the code does not do

Tracked so the review has the list:

- §8 promises access / correction / deletion / restriction / portability. Access,
  deletion, portability and rectification now exist
  (`/api/privacy/{export,profile,delete,rectify}`). **Restriction** still has no
  mechanism.
- §9 "analytics (if enabled)" — no analytics vendor is enabled. The hedge should
  become a statement of fact either way.
- §6 "reasonable period" retention — replace with §3 above **only once the
  enforcement job exists**.
- §11 international transfers rely on bare consent, a weak Art. 49 derogation.
  Should move to SCCs via the processors' DPAs (§2).
- §12 "continued use constitutes acceptance" — weak under GDPR. The versioned
  re-consent flow built in Phase 1.4 is the stronger mechanism; the policy
  should describe that instead.
