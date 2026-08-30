# Top 25 Things to Ship This App to Paying Clients

**Written:** 2026-08-30
**Scope:** `nuwrrrld-portal` (Next.js 16 web portal at `financial.nuwrrrld.com`)
**Framing:** "I should have money on it" — every item below is judged by one
question: *does this stand between a stranger's credit card and a working
product?* Nice-to-haves that don't touch that path are excluded.

This is not a generic checklist. Each item was verified against the actual
repo state on 2026-08-30 — 42 API routes, 24 unit test files, a 34-test
Playwright suite, 7 GitHub Actions workflows, and the open blockers in
`docs/known-bugs.md`, `docs/pipeline-todo-blockers.md`, and
`docs/session-handoff.md`.

---

## How to read this

Items are grouped into four tiers. **The tiers are the schedule.** Tier 1 is
non-negotiable before you accept a single dollar; Tier 4 is what separates a
product people tolerate from one they renew.

| Tier | Meaning | Items |
|---|---|---|
| **1 — Revenue blockers** | Money literally cannot be collected, or is collected and lost | 1–6 |
| **2 — Trust blockers** | It works, but a bad day becomes an invisible outage | 7–13 |
| **3 — Product truth** | The thing you're selling has to actually produce output | 14–19 |
| **4 — Retention & polish** | Why they pay you again next month | 20–25 |

A rough effort marker is on each: **S** (under an hour), **M** (a session),
**L** (multi-session or blocked on someone else).

---

# Tier 1 — Revenue Blockers

Nothing else on this list matters until these six are done. Each one is a way
to take someone's money and fail to deliver, or to deliver and fail to get
paid.

### 1. Set a real `STRIPE_WEBHOOK_SECRET` — **S**, blocked on Stripe dashboard access

**Status:** placeholder (`whsec_placeholder_*`) in `.env.local` today.

This is the single most expensive open item in the repo. Until it holds a real
`whsec_...` value, `app/api/webhooks/stripe/route.ts` logs a `CONFIG_ERROR` and
**rejects every event Stripe sends**. Concretely: a customer completes
checkout, Stripe charges their card, and the portal never learns about it. They
pay, and stay on the free tier. There is no louder failure than that, and it
produces no error the customer can see — they just get nothing and email you.

`docs/stripe-todo.md` has the exact retrieval path. Note its warning: the
signing secret is displayed exactly once at endpoint creation, and **Roll
secret** invalidates the old value immediately — don't roll unless you're
prepared to update `.env.local`, Vercel, and GHA secrets in the same window.

### 2. Create and set `STRIPE_PRICE_ANNUAL` — **S**, blocked on Stripe dashboard access

**Status:** unset. `lib/stripe.ts`'s `PRICES.annual` resolves to `''`.

The pricing page advertises an annual plan ("Best value — save 34%", per the
snapshot evidence in `known-bugs.md` item 1). Selecting it sends an empty
price ID to Stripe Checkout, which errors. You are advertising a plan you
cannot sell.

This also cascades: `/api/health`'s `checkStripe()` reports Stripe as
`not_configured`, which fails `e2e/health/dependencies.spec.ts` and disables
the entire `preflight-billing` Playwright tier by design. Fixing one env var
turns a whole test tier back on.

**Decide the price before creating it.** Stripe price objects are immutable —
changing the amount later means archiving and recreating, and archiving only
affects new subscriptions, not existing ones. Getting this wrong locks in a
number you'll have to grandfather.

### 3. End-to-end verify one real paid signup — **M**

Not a unit test. An actual card (Stripe test mode first, then a real one in
live mode) through the complete loop:

checkout → webhook received → Clerk `publicMetadata.subscription_status` set to
`active` → `tierFromStatus()` maps it to `tier: 'pro'` → the three gated routes
(`/dashboard/nuai`, `/dashboard/signals`, `/dashboard/portfolio`) render instead
of redirecting to `/pricing`.

There is a trap here documented the hard way in `known-bugs.md` item 1:
`subscription_status` has **no `'pro'` value**. The valid set is
`free | trialing | active | past_due | canceled | paused`, and
`tierFromStatus()` (`lib/subscription.ts:88`) derives the tier from it.
Writing `subscription_status: 'pro'` is silently rejected by
`isSubscriptionStatus()` and falls back to `'free'` — producing a paying
customer with no access and no error anywhere. Assert on the *rendered gated
page*, never on the metadata write succeeding.

### 4. Verify the cancellation and downgrade path — **M**

The reverse of item 3, and the one nobody tests until a chargeback arrives.
Confirm that `customer.subscription.deleted` and `invoice.payment_failed` are
in the event list on the Stripe endpoint and are handled in the route's event
switch, and that a canceled subscriber actually loses access at period end
rather than immediately (charging someone through the 28th and cutting them off
on the 3rd is a refund request) or never (giving away the product is worse).

`past_due` deserves an explicit decision: `tierFromStatus()` currently maps it
to `pro`, meaning a failed payment keeps full access. That's a defensible
grace-period choice — but make it a *choice*, with a bounded window, not an
accident.

### 5. Add a billing-failure surface in the UI — **M**

Right now a customer whose card expires has no in-app signal. Stripe emails
them; your app says nothing. Given `/dashboard/billing` and
`/api/stripe/portal` already exist, this is mostly a banner: when
`subscription_status` is `past_due`, render a persistent, dismissible-per-
session notice linking to the Stripe customer portal.

This is the highest-ROI churn fix on the list. Involuntary churn from expired
cards is typically a large share of total churn, and it's the only churn cause
that's purely a UI problem.

### 6. Decide `PORTAL_PUSH_SECRET` — generate it or delete the dependency — **S**

**Status:** unset. Two internal callers authenticate with it: the
`refresh-signals.py` push into `POST /api/signals/refresh`, and unauthenticated
internal reads of `GET /api/signals/digest`.

The decision, per `docs/stripe-todo.md`, is genuinely binary and shouldn't be
deferred again:

- **If either caller is real** → `openssl rand -hex 32`, set it in both this
  app's env and the caller's, and you're done.
- **If neither is deployed** → this is dead config. `/api/signals/refresh`
  rejects pushes with `CONFIG_ERROR`, and `/api/signals/digest` falls back to
  requiring a Clerk session, which is the correct behavior anyway. Delete the
  placeholder so it stops appearing in every secrets audit as an open item.

Leaving it a placeholder is the only wrong answer, because it makes
`sync-e2e-secrets.sh` report a permanent false blocker.

---

# Tier 2 — Trust Blockers

The app works. These are the items that determine whether a *bad day* is a
five-minute fix or a customer discovering your outage before you do.

### 7. Add error monitoring — **M**

**Verified gap:** grepping `lib/` and `app/` for `sentry|posthog|datadog|
opentelemetry` returns **nothing**. There is no error reporting in this
codebase at all.

You have 42 API routes and no way to know when one of them throws in
production. Today, the detection mechanism for a broken paid feature is a
customer emailing you — which means your mean-time-to-detect equals your
customer's patience.

Sentry's Next.js SDK is the shortest path (it instruments both server routes
and client components, and captures the release/commit automatically). The
threshold to clear here is low: *any* alerting beats none. Wire it, trigger one
deliberate error, confirm it lands.

### 8. ~~Add `error.tsx`, `global-error.tsx`, and `not-found.tsx`~~ — **DONE 2026-08-30**

**Shipped** on `fix/error-boundaries-and-limits`. All three now exist at the
app root, styled with the existing `globals.css` tokens, surfacing `error.digest`
as a support reference code.

**The trap this hit, worth recording:** Next.js 16 renamed the error
component's retry prop from `reset` to **`unstable_retry`**. Writing these from
memory produces a retry button that silently does nothing. Verified against
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`
in the installed version — which is exactly why `AGENTS.md` says to read those
docs before writing code.

*Original finding, for the record:* `find app -name "error.tsx" -o -name
"global-error.tsx" -o -name "not-found.tsx"` returned **zero files**.

Every unhandled render error in this app currently shows the default Next.js
error screen. In production that's a blank-ish page with no branding, no
recovery action, and no support path — on a page the customer is paying to
see.

Three files, maybe forty lines total: a root `app/error.tsx` with a retry
button, `app/global-error.tsx` for the layout-crash case, and `app/not-found.tsx`
for bad URLs (relevant given `app/verdict/[ticker]` and
`app/dashboard/holdfold/[ticker]` accept arbitrary path segments — any typo'd
ticker is a 404 today).

Since this repo runs **Next.js 16**, check
`node_modules/next/dist/docs/` for the current error-boundary conventions
before writing them — per `AGENTS.md`, this version's APIs may differ from what
you'd write from memory.

### 9. Consolidate the two rate-limiter implementations — **S** *(corrected 2026-08-30)*

**This item originally claimed 41 of 42 routes were unprotected. That was
wrong, and the correction is worth more than the original claim.**

A full inventory of all **44** route files (the count was also stale — PR #81
added routes) found the exposure is far smaller than a naive grep suggests,
because most routes authenticate by a mechanism the grep didn't look for:

| Protection | Routes |
|---|---|
| Clerk session (`auth()` / `currentUser()`) | 29 |
| Bearer secret (`PORTAL_PUSH_SECRET`, `CRON_SECRET`, `LAUNCH_REMIND_SECRET`) | 8 |
| Webhook signature (Svix / Stripe `constructEvent`) | 2 |
| **Genuinely unauthenticated** | **4** |

And all four unauthenticated routes are already defended appropriately:

- `/api/council/public` — IP-hashed quota (1/day), cache-first, ticker-only
  input (no free-text prompt from an anonymous caller, closing prompt
  injection), free-tier models only.
- `/api/council/sample` — 6-hour in-process cache.
- `/api/health` — no secrets in its response body.
- `/api/signals/card` — pure string templating, no DB and no model call.

**What is actually left, and it's small:** there are *two* rate-limiter
implementations. `lib/rate-limit.ts` is a proper sliding-window limiter with
bounded-memory sweeping, used by the two privacy DSAR routes;
`app/api/nuai/route.ts` carries its own separate fixed-window version inline.
A fixed window permits a 2x burst across a boundary that a sliding window
does not, so the two behave differently under load.

The work is to delete the inline one and have `nuai` call the shared limiter —
a consolidation, not a rollout. Note that `/api/council/deliberate` has a
*daily quota* (free 5 / pro 25) but no per-minute burst limit, which is a
defensible gap to close at the same time.

**Method lesson worth keeping:** the original claim came from grepping file
*contents* for a pattern and equating "no match" with "no protection." Auth
mechanisms that don't share a common substring are invisible to that. Enumerate
the routes and check each one's actual mechanism.

### 10. Put a real uptime check on `/api/health` — **S**

The route exists and already reports dependency status (it's what catches the
Stripe misconfiguration in item 2). Nothing is watching it.

An external HTTP monitor pinging it every few minutes, alerting to somewhere you
actually read, converts your existing health endpoint from a debugging tool into
a detection system. This is the cheapest item on the entire list and it pairs
with item 7 to cover both halves of "something broke": in-process exceptions
(Sentry) and out-of-process death (uptime check).

### 11. Provision the GCP WIF pool so CI can actually gate merges — **L**, blocked on `gcloud` IAM access

**Status:** all four `e2e` CI shards fail immediately at "Authenticate to GCP
(keyless)" because `GCP_WIF_PROVIDER` is empty.

You have a 34-test Playwright suite that cost real effort to build (PR #64, and
an eight-fix cascade documented in
`docs/wiki-portal/incident-2026-08-17-e2e-ci-cascade.md`). It is currently
decorative in CI — a suite that always fails for an environmental reason is
one people learn to ignore, which is worse than no suite, because it also
masks the real failures underneath.

→ `bash scripts/sync-e2e-secrets.sh --provision-wif`, then grant the printed
service account **only** `roles/run.invoker` on `gcp3-backend`. Resist granting
broader roles to make it work faster; a CI service account with excess IAM is a
finding on any client security review.

### 12. Resolve the two permanently-red CI checks — **M**

Two checks fail on every run for reasons unrelated to the code being reviewed:

- **`shared-drift-check`** — `lib/subscription.ts` has drifted from its
  `gcp3-mobile` counterpart. This is a genuine cross-repo decision (which repo
  owns the canonical tier logic?), not a lint failure to suppress. Note that
  it guards exactly the file whose semantics item 3's trap lives in — drift
  here means the two surfaces can disagree about who is a paying customer.
- **`Cloudflare Pages`** — one API call to disable the integration, per
  `docs/cloudflare-pages-assessment.md`.

Chronically red CI is a culture problem disguised as a config problem. Once
"some checks are always red" is normal, the day a real check goes red, nobody
looks.

### 13. Rotate the exposed `STRIPE_SECRET_KEY` — **S**, blocked on Stripe dashboard access

`docs/env-rotation.md` records this key as already exposed, separate from the
three unset values in item 1/2/6. A live Stripe secret key is a
create-charges-and-issue-refunds credential.

Rotate it, update Vercel and GHA, and — importantly — confirm the old key is
**revoked**, not merely superseded. A rotated-but-still-valid key is not
rotated. Note that PR #80 (`docs/redact-real-ids`, currently open) is scrubbing
real identifiers out of docs; the rotation is the other half of that cleanup and
should land near it.

---

# Tier 3 — Product Truth

Billing and reliability are table stakes. These six are about whether the thing
you're charging for actually produces its output.

### 14. Close the explain-quality gate — the single biggest product gap — **L**

This is the most important item in the document and the one least visible from
the outside.

The live pipeline run recorded in `docs/pipeline-todo-blockers.md` proved the
coverage claim is real: 54 symbols, 108 cards, **0 model calls**, 100% of the
active universe, written successfully. Then:

> `topCards()` (explain-eligible ranking) → **empty**

Every single one of the 54 ETF cards fails `isExplainable()`, which requires
`dataQuality >= 0.8` and zero missing fields. gcp3's ETF payload fills **1 of 5**
taxonomy inputs (`confluenceScore`); `rsi`, `macdCross`, `adx`, and
`volatilityPercentile` are never in scope for its ETF model. Every card lands at
`dataQuality: 0.20`.

**Read that consequence plainly: the AI-explanation feature — the thing behind
the paid tier — returns nothing for the entire current universe, today,
permanently, until one of two paths ships.**

The two paths, from the blockers doc, still undecided:

- **(a)** Extend gcp3 to compute RSI/MACD/ADX/volatility for its 54 ETFs. It
  already has `features_rsi.py` and friends — they're just not wired into the
  ETF path. Lower ceiling, much shorter runway.
- **(b)** Ship the Modal stock lane and accept ETF cards stay coverage-only
  forever — real coverage, never explainable.

**Decide this before selling the AI tier, not after.** Everything else on this
list is fixable after a customer complains. This one means the customer's
complaint is "the product does nothing," which is unrecoverable.

### 15. Merge and deploy the pipeline code — **M**

`app/api/pipeline/` and the rest of the pipeline were discovered **untracked in
git** — never committed, never deployed. So
`https://financial.nuwrrrld.com/api/pipeline/hydrate-universe` **404s in
production** right now. PR #66 carries the code.

Two things block on this merge rather than on any secret: the universe
hydration, and the Yahoo portfolio import
(`scripts/seed-yahoo-portfolio.mjs`, 680 US tickers, dry-run verified but never
run for real).

Worth internalizing as a process lesson too: code can be complete, tested, and
*absent from production* with nothing surfacing the discrepancy. A deploy-time
check that the expected routes exist would have caught it.

### 16. Verify the universe is more than 54 ETFs — **M**

Directly downstream of items 14 and 15. A financial signals product whose
entire coverage is 54 ETFs has a narrow addressable market — most retail
customers arrive with individual tickers in hand.

Once hydration runs for real (item 15) and the 680-ticker Yahoo import lands,
confirm the actual live universe size and re-run the coverage measurement. The
number you can honestly quote to a prospect is the one from a real run, not a
design doc. `docs/max-coverage-simplest-path.md` and
`docs/modal-vs-gcp-signal-coverage.md` hold the reasoning; the run holds the
truth.

### 17. Define behavior when upstream data is stale or missing — **M**

Financial data feeds fail. The pipeline runs on a schedule
(`afternoon-pipeline.yml`, `hydrate-universe.yml`, `precompute-ai.yml`), so
between runs the app serves whatever it last stored.

A paying customer must never see a stale signal presented as current. Every
card and verdict needs a visible as-of timestamp, and content past some staleness
threshold needs an explicit "data is from {date}" treatment rather than silent
display.

The regulatory-adjacent framing matters here: showing a three-day-old BUY signal
with no date, to someone who acts on it, is the kind of thing that turns a
support ticket into a liability. `docs/api-failure-mitigation-build-options.md`
covers the upstream-failure options; this item is specifically about the
*user-visible* contract.

### 18. Test the AI fallback chain under real failure — **M**

`__tests__/openrouter-fallback.test.ts` and `__tests__/precomputed-ai.test.ts`
exist, and `e2e/frontend/nuai-fault-injection.spec.ts` exercises fault
injection. Good foundation. Two caveats from the handoff's trap list apply
directly:

- **`route.fulfill()` cannot simulate a stalled stream** — it always completes
  the response. To actually stall, the handler must never call
  `fulfill`/`continue`/`abort`. A "timeout test" built on `fulfill` is testing
  nothing.
- **`getByRole("alert")` matches Next.js's own `#__next-route-announcer__`**, an
  always-empty hidden element present on every page — it made a broken
  assertion look like a passing one once already.

Re-audit the fault-injection tests against both traps before trusting them as
evidence that degradation works.

### 19. Make the disclaimer legally load-bearing — **S**

`app/api/disclaimer/`, `__tests__/disclaimer.test.ts`, `/terms-of-service`,
`/privacy-policy`, and a consent API all exist — the pieces are there.

What matters for a financial product taking money: the disclaimer must be
**acknowledged and recorded**, not merely displayed. Confirm the consent record
persists per user with a timestamp and version, that a changed disclaimer
re-prompts, and that "this is not financial advice" appears on the surfaces where
someone would actually act — the verdict and signal pages, not only the footer.

The audit-ledger work is already underway (the recent `fix(privacy)` commit
hardening IP validation in the DSAR ledger suggests the infrastructure exists);
this is about pointing it at the disclaimer.

---

# Tier 4 — Retention & Polish

These don't block launch. They determine month two.

### 20. Ship the transactional email path for real — **M**

`/api/retention/digest-email`, `/api/retention/trial-nudge`, and
`/api/launch/remind` exist and reference an email provider. Verify they
actually deliver: SPF/DKIM/DMARC configured on the sending domain, a real
send observed end-to-end, and bounces visible somewhere.

The trial-nudge in particular is directly revenue-linked — a 7-day trial with
no reminder email converts materially worse than one with, and you've already
built the endpoint.

### 21. Instrument the funnel — **M**

You have `/api/referral`, an attribution cookie (`nu_attrib`, recently hardened
against tampering), and a `/launch` page. What's missing is the ability to
answer "where did paying customers come from?"

Minimum viable: landing view → pricing view → checkout started → checkout
completed, with the attribution source attached. Without it, every future
marketing decision is a guess, and you'll spend money to find out what you
could have measured.

### 22. Get the frontend Playwright tier green and keep it green — **M**

Item 1 in `known-bugs.md` (the E2E user's Pro entitlement) is fixed but the
tier was **never re-run to confirm**. Item 3 — the portfolio-suggestions
failure — is explicitly suspected to be the same redirect-to-`/pricing` cause
and may already be resolved.

Re-run the tier. You may be one command from closing two known bugs, and you
currently don't know which of your recorded failures are real.

### 23. Audit mobile/responsive on the paid surfaces — **M**

A meaningful share of financial-app traffic is mobile, and the paid dashboards
(`/dashboard/signals`, `/dashboard/portfolio`, `/dashboard/nuai`) are the
data-dense pages most likely to break at 375px — tables and charts are exactly
what overflow.

There's an accessibility harness already present (`jest-axe`,
`@types/jest-axe`), so the tooling instinct exists; extend it to viewport
checks on the three routes behind the paywall first.

### 24. Write the client-facing onboarding path — **S/M**

A new paid user currently lands on a dashboard. What's the first thing they
should do? Add tickers to a watchlist (`/api/portfolio/watchlist` exists), or
import a portfolio (the Yahoo import from item 15)?

An empty dashboard on day one is the most common cause of a trial that never
converts. Even a static three-step checklist that disappears once each step is
done beats an empty state.

### 25. Consolidate the documentation before a client ever sees the repo — **S**

There are four root-level `TODO*.md` files, plus `nextphase.md`, `nu1.md`,
`LANDING-REVAMP.md`, `LANDING-PHASE3-4.md`, and ~13 pre-existing untracked docs
classified in `docs/docs-inventory.md` (three of which are personal notes
unrelated to this repo).

Per the archive-never-delete policy in `~/.claude/CLAUDE.md`: move superseded
docs to `docs/archive/` with an `ARCHIVED:`/`REASON:` header, keep one live
roadmap, and get the untracked files committed, archived, or gitignored.

Two practical reasons beyond tidiness: (a) the handoff records a real trap —
**don't `git add docs/`**, because it sweeps in those 13 files and trips the
secrets hook on a `whsec_placeholder_*` string — so this mess actively slows
every commit; and (b) if a client ever gets repo access, four contradictory
TODO files is the first thing they'll read.

---

## The honest short version

If you do only five things:

1. **`STRIPE_WEBHOOK_SECRET`** (#1) — you are currently unable to record a payment.
2. **`STRIPE_PRICE_ANNUAL`** (#2) — you are advertising a plan you cannot sell.
3. **Decide the explain-quality path** (#14) — the AI feature returns nothing for the entire universe.
4. **Error monitoring** (#7) — no Sentry/equivalent anywhere, so a broken paid feature is detected by customer email. *(#8, the error boundaries, is now done — see the changelog below.)*
5. **Consolidate the two rate limiters** (#9) — smaller than this doc first claimed; read the corrected item before acting on it.

Items 1, 2, and 13 all block on the same Stripe dashboard session. Do them in
one sitting.

---

## Changelog

### 2026-08-30 — first `/fixy` pass over this list

Branch `fix/error-boundaries-and-limits`. Verified green: `tsc --noEmit` clean,
`eslint` clean on all touched files, 522 tests passing, `next build` succeeds.

**Shipped**

- **Item #8 — error boundaries.** `app/error.tsx`, `app/global-error.tsx`,
  `app/not-found.tsx`. Uses Next.js 16's `unstable_retry` (not the older
  `reset`); surfaces `error.digest` as a support reference code.
- **A bug not previously on this list — response amplification on
  `/api/signals/card`.** The public `ticker` query param was unbounded and
  echoed into the SVG response through `escapeXml`, which expands `&` to
  `&amp;` — 5x per character. Measured: a 200KB query string produced a **1MB**
  response from an unauthenticated, uncached endpoint. Bounded to
  `MAX_TICKER_LENGTH = 12`, which takes that same input to 60 bytes.

**Corrected**

- **Item #9** was wrong. It claimed 41 of 42 routes were unthrottled; a full
  44-route inventory found only **4** are genuinely unauthenticated, and all
  four are already appropriately defended. The item now describes the real
  (much smaller) task: consolidating two rate-limiter implementations. The
  original claim came from grepping file contents for `rateLimit` and reading
  "no match" as "no protection" — invisible to bearer-secret and
  webhook-signature auth.

**Still open from Tier 1/2:** items #1–#6 (all blocked on Stripe/Clerk
dashboard access), #7 (error monitoring), #10 (uptime check), #11–#13.

---

## Cross-references

| Topic | Doc |
|---|---|
| Stripe secrets, exact retrieval steps | `docs/stripe-todo.md` |
| Key rotation | `docs/env-rotation.md` |
| Open bugs with status | `docs/known-bugs.md` |
| Pipeline blockers + the live run evidence | `docs/pipeline-todo-blockers.md` |
| Last session's state and traps | `docs/session-handoff.md` |
| Coverage design reasoning | `docs/max-coverage-simplest-path.md`, `docs/modal-vs-gcp-signal-coverage.md` |
| E2E follow-ups | `docs/e2e-next-steps.md`, `playwright-todo.md` |
| Cloudflare Pages CI failure | `docs/cloudflare-pages-assessment.md` |
