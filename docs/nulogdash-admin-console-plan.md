# nulogdash Admin Console — Plan

A plan for turning the static prototype at `docs/nulogdash-admin.html` into
a real internal admin console at `app/dashboard/nulogdash-admin/` (exact
route TBD — see Open decisions). This doc is a plan only; nothing here is
implemented yet.

This is a different scope from `docs/nulogdash-dashboard-plan.md`. That plan
covers `/nulogdash`, the feature-level E2E sweep tool and its single results
page (`app/dashboard/nulogdash/page.tsx`). This plan covers a broader
internal admin surface — users, signals, integrations, billing, audit — of
which the `/nulogdash` results page becomes one report among several. Build
`/nulogdash` first; this console can embed or link its page rather than
duplicate it.

## Why the HTML prototype isn't enough

`docs/nulogdash-admin.html` is static markup with `alert()`/`confirm()`
stand-ins for every action (see the hardening pass in this file's history —
defensive JS was added, but there is still no real data or backend behind
any button). It's useful as a layout reference, not a deployable page: no
auth, no data fetching, no real mutations, and it lives in `docs/` rather
than `app/`, so it isn't even served by the Next.js app.

## Gating

Reuse the pattern already in `app/dashboard/beta/page.tsx` and
`lib/nulogdash.ts` (`isNulogdashAdmin`): Clerk `auth()`/`currentUser()` to
get the session email, checked against an env-var allowlist
(`NULOGDASH_ADMIN_EMAILS` or a new `PORTAL_ADMIN_EMAILS`). Redirect
unauthenticated users to sign-in with a `redirect_url`; `notFound()` (not a
403 page) for authenticated-but-not-allowlisted users, matching how
`app/dashboard/nulogdash/page.tsx` already handles it — don't invent a
second internal-access convention.

### Same app, not a separate deployment

**Decision: this console stays inside `nuwrrrld-portal`. Do not split it
into its own app.**

The case for splitting is network isolation — a separate origin you can put
behind a VPN, an IP allowlist, or a separate SSO tenant. That isolation is
mostly illusory here: the console needs Clerk sessions, Neon, the Stripe
customer records via `lib/subscription.ts`, and the signal pipeline. A
separate deploy would still reach the same database, so a compromise of
either surface reaches the same data. What splitting reliably *does* buy is
two Clerk configs to keep in sync, duplicated auth wiring, and a second
deploy target — new failure modes in exchange for a boundary that doesn't
actually hold.

Staying in-app also inherits protections already in place: server
components mean admin queries never ship to the client bundle, and a gate
that throws or misreads env fails closed on the server rather than
rendering an empty shell. `notFound()` over a 403 keeps the route's
existence unconfirmed.

Revisit this decision only if one of these becomes true:

- Admin access needs to be restricted by network (VPN/IP allowlist) in a
  way Vercel/Cloudflare middleware on this app can't express.
- Non-engineering staff need console access without portal user accounts.
- The console needs a materially different availability guarantee than the
  customer-facing app (e.g. it must stay up to diagnose an outage *of* the
  portal — a real argument, and the strongest one for splitting later).

### Email check hardening — DONE

The gate in `lib/nulogdash.ts` previously read
`user.emailAddresses[0].emailAddress`, which carried two defects. Both are
now fixed and pinned by `__tests__/nulogdash-admin.test.ts`:

1. **Unverified emails were accepted.** If the Clerk instance permits
   sign-up before email confirmation, someone could register an address
   matching the allowlist and pass without ever proving they own it. The
   gate now requires `verification.status === "verified"`.
2. **`[0]` is not the primary email.** A user with multiple addresses can
   reorder them; index zero carried no guarantee. The gate now resolves the
   address via `primaryEmailAddressId`.

`isNulogdashAdmin` now takes the Clerk user object rather than a bare email
string. That is deliberate: passing a string let the caller resolve the
address itself, which is precisely how both defects were reachable. Keep
that signature — a future caller that "just needs the email" is the
regression to watch for.

The allowlist fails closed: an unset or whitespace-only
`NULOGDASH_ADMIN_EMAILS` yields an empty list and denies everyone. Keep
that property — a typo'd env var should lock admins out, never let
strangers in.

### Second factor for mutating actions — app side DONE, Clerk side pending

An env-var email allowlist is a single string comparison away from full
admin access. That is an acceptable risk for a read-only test-sweep report.
It is **not** acceptable for `Impersonate`, `Disable`, or `Reset PW`, where
an admin account compromise becomes a compromise of every user account.

`lib/nulogdash.ts` therefore exposes two checks, and the distinction is
load-bearing:

| Check | Requires | Use for |
|---|---|---|
| `isNulogdashAdmin(user)` | allowlisted + primary + verified email | rendering read-only reports |
| `canPerformAdminAction(user)` | all of the above **plus** `twoFactorEnabled` | every mutating server action |

Splitting them keeps the failure mode humane: an admin who hasn't enrolled
MFA still reaches the console and sees a notice explaining why the buttons
are missing, rather than an unexplained `notFound()`.

**Every mutating server action must call `canPerformAdminAction`, not
`isNulogdashAdmin`.** The page-level gate is not sufficient for an action —
server actions are independently addressable.

Still pending, and tracked in `docs/clerk-todos.md`: MFA must actually be
enabled in the Clerk dashboard and enrolled by each admin. Until then
`twoFactorEnabled` is `false` for everyone and `canPerformAdminAction`
denies universally — correct, but vacuous.

Treat **Impersonate as the highest-risk action in the console** — higher
than `Deploy Config` — because it converts one compromised session into
arbitrary user access, and it is the action least likely to look anomalous
in logs. It should additionally require step-up reverification at the moment
of use, not merely an MFA-enrolled session.

## Section-by-section: prototype nav → real report

The prototype's sidebar nav (`Overview`, `Signals`, `Users`, `Integrations`,
`Settings`, `Audit`) maps to real, queryable data already in the codebase:

| Nav item | Real data source | Notes |
|---|---|---|
| Overview | `getLatestRun()` (`lib/nulogdash.ts`) + counts from Neon | Summary tiles: latest `/nulogdash` pass/fail, active user count, uptime proxy (last successful health check from `app/api/health/route.ts`) |
| Signals | Signal pipeline output (see `lib/openrouter.ts`, signal routes under `app/api/signals/`) | Recent signals table — read-only, no live actions from this page |
| Users | Clerk Backend API (user list, session status) + `lib/subscription.ts` for plan/tier | Impersonate/disable/reset actions need real Clerk Backend API calls, not `alert()` — see Actions below |
| Integrations | Env-derived: OpenRouter, Stripe, Clerk, GCP backend connectivity | A live status check per dependency, similar in spirit to `/local-check`'s preflight gates |
| Settings | App config surface (feature flags, admin allowlist) | Lowest priority — start read-only |
| Audit | New: an `admin_actions` log table | Every mutating admin action (below) must write a row here before this tab has real content |

Add a new nav item: **`/nulogdash` results** (or fold the existing
`app/dashboard/nulogdash/page.tsx` in as an iframe/embedded route) so the
E2E sweep report lives inside the same console instead of a separate,
unlinked URL.

## Reports (the "lots of reports" part)

Read-only pages, each backed by a real query, no invented data:

1. **`/nulogdash` run history** — once the Neon `nulogdash_runs` table from
   the other plan exists, a trend view: pass-rate over time per feature, not
   just latest run.
2. **Subscription/billing report** — active subscriptions, trial-to-paid
   conversion, churn, sourced from `lib/subscription.ts` + Stripe (test mode
   in dev). Cross-reference `docs/wiki-portal/entity-billing.md` for the
   billing domain model already documented.
3. **Signal delivery report** — digest send success/failure, sourced from
   whatever the signal pipeline already logs (`locrun` skill / Firestore, per
   `docs/wiki-portal/entity-signal-data-plane.md`).
4. **Council/Nu AI usage report** — request volume, latency, error rate per
   OpenRouter model tier, useful for catching the free-tier model-chain
   fallback behavior described in
   `docs/wiki-portal/decision-free-tier-model-chain.md`.
5. **Audit log report** — every admin action taken from this console
   (see below), filterable by actor/date/action type.

Each report is a server component doing a direct read (Neon/Clerk/Stripe),
no client-side polling, matching the "always fresh" pattern already used in
`app/dashboard/nulogdash/page.tsx` (`export const dynamic = "force-dynamic"`).

## Actions (the mutating buttons)

The prototype's `Reindex Signals`, `Create Backup`, `Deploy Config`,
`Impersonate`, `Disable`, `Reset PW` buttons are currently `alert()` stubs.
Each one is a real integration, not a UI task:

- **Impersonate / Disable / Reset PW** → Clerk Backend API calls
  (`@clerk/backend`), server actions gated by the same admin check as the
  page itself.
- **Reindex Signals** → whatever triggers the signal pipeline today
  (check `locrun` skill / `automation/functions/daily_analysis` for the
  existing entry point before adding a new one).
- **Create Backup** → likely a Neon branch/snapshot
  (`mcp__Neon__create_branch` is already available in this environment) or a
  documented manual DB backup step — needs a decision, see below.
- **Deploy Config** → out of scope for a v1 console; this is the highest-risk
  button in the prototype (it maps to "apply configuration to production")
  and should not be wired up until there's a real audit trail and
  confirmation flow, not a `confirm()` dialog.

Every action writes an `admin_actions` row (actor email, action, target,
timestamp, result) before or immediately after executing, so the Audit
report has real content from day one rather than being retrofitted.

## Portfolio: full feature test coverage

The portfolio surface is the largest untested area in the app — 5 API
routes and 2 libs with **zero** test files today (`npm test` covers none of
them). The admin console's Overview and billing reports read portfolio
data, so this coverage is a dependency of this plan, not a side quest.

### Current surface

| Unit | Path | Tested |
|---|---|---|
| Health score | `app/api/portfolio/health/route.ts` (GET) | ✗ |
| AI health analysis | `app/api/portfolio/health-ai/route.ts` (POST) | ✗ |
| Optimizer suggestions | `app/api/portfolio/suggestions/route.ts` (GET) | ✗ |
| Watchlist list/add | `app/api/portfolio/watchlist/route.ts` (GET, POST) | ✗ |
| Watchlist remove | `app/api/portfolio/watchlist/[ticker]/route.ts` (DELETE) | ✗ |
| Grade helper | `lib/portfolio.ts` (`gradeFromScore`) | ✗ |
| Watchlist persistence | `lib/watchlist-store.ts` (get/add/remove) | ✗ |
| Portfolio UI | `app/dashboard/portfolio/PortfolioClient.tsx` | ✗ |

### What to test, by risk

**Tier 1 — security and correctness (write these first).** Each is a real
failure mode already visible in the code, not hypothetical:

- **Cross-user cache leak.** `health/route.ts` keys its module-level cache
  as `${userId}:${sortedTickers}`. Assert that two different `userId`s with
  an identical ticker set get separate entries — a regression to a
  ticker-only key would serve one user's score to another. This is the
  single highest-value test in the portfolio surface.
- **Ticker-set invalidation.** Same cache: changing the watchlist must not
  serve the score computed for the previous set. The sorted-join means
  `["A","B"]` and `["B","A"]` are correctly the same key — pin that too.
- **401 on every route when unauthenticated.** All five routes check
  `userId` — one test each, cheap, and catches an accidentally-dropped
  guard.
- **Empty watchlist returns 204, never a score.** `health/route.ts`
  deliberately returns 204 so gcp3's `DEFAULT_PORTFOLIO` fallback can't be
  presented as the user's own. Pin it — a regression here shows users a
  confident score for a portfolio they don't hold.
- **Entitlement gate on `health-ai`.** It calls `hasEntitlement("nu_ai",
  tier)`. Assert a free-tier user gets the gated response and a paid tier
  proceeds; `__tests__/subscription.test.ts` already covers the tier logic
  itself, so this only needs the route-level wiring.
- **`MCP_BACKEND_URL` unset → 503, not a hardcoded host.** The comment in
  `health/route.ts` says "fail-closed: don't fall back to a hardcoded
  external host." Pin the 503.

**Tier 2 — behavior.**

- `gradeFromScore` boundaries (the A/B/C/D/F cutoffs, plus out-of-range and
  non-integer input).
- Watchlist add: duplicate ticker, case normalization (`aapl` → `AAPL`,
  matching the `upper` handling in the DELETE route), invalid/empty ticker,
  and whatever cap `addToWatchlist` enforces.
- Watchlist remove: removing a ticker not on the list, and removing another
  user's ticker (must not succeed).
- Upstream failure handling: the 8s `AbortController` timeout in
  `health/route.ts` — assert a hung MCP backend produces a clean error
  response, not a hang.

**Tier 3 — UI.** `PortfolioClient.tsx` component tests via the existing
`components` vitest project: loading state, the 204/empty-watchlist state,
an error state, and a11y via the `jest-axe` matcher already registered in
`test/setup.ts`.

### How to write them

Follow `__tests__/stripe-checkout.test.ts` — it is the only existing
route-handler test and establishes the pattern: `vi.mock` on
`@clerk/nextjs/server` to control `auth()`, `vi.mock` on the data layer
(`@/lib/watchlist-store`), and a stubbed `fetch` for the MCP backend.
Import the route's exported `GET`/`POST`/`DELETE` directly and assert on
the returned `NextResponse` status and JSON body.

Route and lib tests go in `__tests__/` (the `unit` project, node
environment). `PortfolioClient` tests sit beside the component as
`app/dashboard/portfolio/PortfolioClient.test.tsx` (the `components`
project, jsdom) — matching where `HoldFoldClient.test.tsx` and
`NuAIChat.test.tsx` already live.

Do **not** add these to the `live` project. Portfolio tests must run in the
default `npm test` with no network and no real MCP backend; the module-level
cache in `health/route.ts` and `suggestions/route.ts` persists across tests
in a file, so reset modules between cases (`vi.resetModules()`) rather than
letting one test's cached entry satisfy the next.

### Acceptance

`npm test` covers all 5 portfolio routes and both libs, including the
cross-user cache-isolation case, with no test requiring a live MCP backend
or network access.

## Open decisions before building

- **Route path**: `app/dashboard/nulogdash-admin/` (mirrors the prototype's
  name) vs. a more general `app/dashboard/admin/` if this console is meant
  to grow beyond nulogdash-branded reports. Recommend the general path if
  billing/signals/audit reports are in scope, since none of those are
  nulogdash-specific.
- **Admin allowlist**: reuse `NULOGDASH_ADMIN_EMAILS` as-is vs. a broader
  `PORTAL_ADMIN_EMAILS` now that scope exceeds the E2E sweep. Recommend
  renaming/broadening now rather than after users exist in the narrower list.
- **Backup action**: define what "Create Backup" actually triggers (Neon
  branch snapshot vs. documented manual process) before wiring the button —
  an admin button that silently no-ops or does something unexpected is worse
  than not having the button.
- **Deploy Config**: decide whether this console should ever perform
  production deploys, or whether it should only ever link out to the actual
  deploy system (GitHub Actions / Cloudflare) with an audit-logged click,
  never trigger one directly.

## Build phases

0. ~~**Prerequisite:** fix the email-verification and primary-email defects
   in `lib/nulogdash.ts`.~~ **Done** — see Gating. Every phase below
   inherits that gate.
1. Stand up the gated route + Overview tab only, reusing the
   `isNulogdashAdmin`/`app/dashboard/beta` pattern, with the `/nulogdash`
   results report as its first real embedded report.
2. Add Users (read-only list first, mutating actions second) and Audit
   (append-only log, populated by phase 1's actions once they exist).
3. Add Signals and Integrations reports (read-only).
4. Add the remaining reports (billing, Council/Nu AI usage) as their
   underlying data sources are confirmed stable.
5. Settings and any write-side config changes — lowest priority, last.

## Acceptance criteria

- The console is reachable only by allowlisted admin emails; a
  non-allowlisted authenticated user gets `notFound()`, not a rendered page
  with empty data.
- The admin check matches the user's **primary, verified** email — not
  `emailAddresses[0]` — and an unset allowlist denies everyone.
- No mutating action (`Impersonate`, `Disable`, `Reset PW`, …) ships before
  MFA is enforced for allowlisted admins.
- Every report reads real data — no page ships with hardcoded prototype
  numbers (`12.4k`, `1.2k`, `99.99%`, etc. from the HTML mockup).
- Every mutating action writes an `admin_actions` audit row before
  completing, and the Audit report can show it.
- `Deploy Config` (or any equivalent production-deploy action) is either
  absent from v1 or requires an explicit, separately-decided confirmation
  flow beyond a browser `confirm()` dialog.
