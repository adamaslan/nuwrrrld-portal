---
date: 2026-09-10
type: entity
tags: [nulogdash, admin, testing, coverage, clerk, mfa, inventory, sweep]
sources: [../../scripts/nulogdash-inventory.mjs, ../../scripts/nulogdash.mjs, ../../scripts/nulogdash-merge-e2e.mjs, ../../app/dashboard/nulogdash, ../../lib/nulogdash.ts, ../../e2e/frontend/nulogdash-admin.spec.ts, ../nulogdash-dashboard-plan.md, PR#118]
---

# Entity — nulogdash (admin console + feature sweep)

## What it is

The portal's **self-audit surface**: an inventory of every API feature, a runner
that exercises them, and an admin-only console that renders the result at
`/dashboard/nulogdash`. Four moving parts that are easy to confuse:

| Part | File | Job |
|---|---|---|
| Inventory | `scripts/nulogdash-inventory.mjs` | Cross-checks a hand-authored `FEATURE_META` table against a filesystem scan of `app/api/**/route.ts`. Emits `docs/nulogdash-inventory.json` + drift warnings |
| Sweep runner | `scripts/nulogdash.mjs` | Calls each inventoried feature against a running server, writes `.nulogdash/latest.json` |
| Browser merge | `scripts/nulogdash-merge-e2e.mjs` | Folds [[entity-playwright-e2e]]'s JSON reporter output in as `tier: "browser"` rows |
| Console | `app/dashboard/nulogdash/**` | Two tabs — the feature sweep, and the `pipeline_run_log` reader ([[entity-model-usage-log]]) |

**The inventory is the interesting half.** A route the filesystem scan finds but
`FEATURE_META` doesn't describe becomes a drift warning *and* an `undocumented-*`
row — so a new route can never silently fall outside the sweep. The inverse also
warns: a `FEATURE_META` key matching nothing on disk means a route was renamed or
deleted. That bidirectional check is the whole design.

**Four result states, and the distinction between two of them carries the
meaning.** `pass` / `fail` / `blocked` / `not_run`. `blocked` means a dependency
the sweep needs is absent (no session cookie, no `DATABASE_URL`) — the feature was
never exercised, so nothing is known about it. `fail` means it *was* exercised and
answered wrong. Conflating them is the failure mode this entity keeps hitting: see
known failure 1.

**Access is two gates, not one** (`lib/nulogdash.ts`):

- `isNulogdashAdmin(user)` — the user's **primary, verified** email is in
  `NULOGDASH_ADMIN_EMAILS`. Grants *read*. Fails closed: an unset or empty
  allowlist denies everyone, so a typo locks admins out rather than letting
  strangers in.
- `canPerformAdminAction(user)` — the above **plus `twoFactorEnabled`**. Required
  for anything that spends quota or writes a row. Deliberately split, because an
  env-var email allowlist is one string comparison away from full access: an
  acceptable risk for reading a report, not for reaching other users' accounts.

Both take the Clerk `User`, never a bare email string — a caller that resolves the
address itself can silently bypass both checks, which is how this went wrong
before. See [[decision-self-implemented-totp-over-clerk-pro]] for why MFA is
currently unreachable, and [[decision-nulogdash-browser-trigger-handshake]] for
what sits behind the second gate.

## Where used

- `npm run nulogdash` — inventory then sweep, against `NULOGDASH_BASE_URL`
  (default `http://localhost:3000`).
- `npm run test:e2e:nulogdash` — Playwright, then the browser-tier merge.
- `/dashboard/nulogdash` — the sweep console; `notFound()` for a non-admin,
  `MfaNotice` for an allowlisted admin without a second factor.
- `/dashboard/nulogdash/pipelines` — the run-log tab and the trigger controls
  ([[decision-nulogdash-browser-trigger-handshake]]).
- `e2e/frontend/nulogdash-admin.spec.ts` — the browser-level proof that both
  gates are actually *reached* (added PR #118, see below).
- `/nulogdash` — the Claude Code command wrapper ([[entity-dev-command-suite]]).

## Known failures

1. **A route missing from `FEATURE_META` reported `fail`, not `blocked` —
   13 routes, 21 failing sweep rows (2026-09-07, fixed PR #118).** Mind the two
   different counts, which are unrelated and coincidentally equal at 21: the
   2026-09-07 sweep showed **21 drift warnings** *and* **21 `fail` rows**. PR #116
   then closed 8 drift warnings, leaving **13** for PR #118 — which is what "all
   13 routes" below refers to. The `fail`-row count moved separately, 21 → 1.
   Six routes appeared to 404
   outright: `/api/analyze`, `/api/disclaimer`, `/api/legal-consent`,
   `/api/privacy/{delete,export,profile}`. The routes were fine. They sit inside
   `proxy.ts`'s `isProtectedApiRoute` matcher, and **Clerk answers an
   unauthenticated request to a protected API route with `404` rather than `401`**
   — by design, so the route's existence isn't leaked ([[entity-clerk]]). The
   cookieless sweep therefore saw a 404 page. `privacy/rectify` and `signals/top`
   are handler-guarded rather than proxy-matched and returned a plain `401` for the
   same net effect. In every case the true state was `blocked` (needs a session),
   but with no `FEATURE_META` entry the runner had no `auth: true` to key off.
   Fixed by describing all 13 routes. **The lesson is not "add the entries" — it
   is that an undocumented route defaults to the wrong state**, so drift shows up
   as a wall of red rather than as the honest "not covered" it actually is.
2. **`NULOGDASH_BASE_URL=` (empty) defeated its own default (fixed PR #117).**
   `process.env.NULOGDASH_BASE_URL ?? "http://localhost:3000"` — `??` only falls
   back on `null`/`undefined`, and `.env.example` ships the var with an empty
   value. Every probe failed with `Failed to parse URL from /api/health`, reporting
   53 false `blocked`. Now `?.trim() || …`. The same trap bit
   `playwright.config.ts`, which carries its own comment about it.
3. **The sweep has never exercised any authenticated feature.**
   `NULOGDASH_SESSION_COOKIE` is a hand-pasted Clerk `__session` value that nobody
   refreshes, so 38 of 59 features sit permanently `blocked` — including every
   AI surface (`nuai`, `council`, `brief`, `holdfold`, `portfolio-*`,
   `signals-*`). [[entity-playwright-e2e]] solved this same problem properly with
   `@clerk/testing`'s `clerkSetup()` and a cached `storageState`; the sweep runner
   has not adopted it.
4. **Two routes had to be *removed* from the sweep on safety grounds, not
   added.** `POST /api/privacy/delete` irreversibly deletes the test user's Clerk
   account (`clerkClient.users.deleteUser`) and every row they own across
   `USER_TABLES` — a routine sweep firing it would destroy the very account
   known failure 3 depends on. `POST /api/launch/remind` needs a
   `LAUNCH_REMIND_SECRET` bearer and has no user-facing form. Both were previously
   `undocumented-*` rows the runner *did* attempt. That the delete route was only
   ever saved by returning 404 to an unauthenticated probe is uncomfortably thin.

## Open questions

- ❓ Should the sweep runner adopt [[entity-playwright-e2e]]'s `storageState`
  instead of `NULOGDASH_SESSION_COOKIE`? The e2e suite already signs a dedicated
  test user in and caches the session for 6 days; the sweep re-solves the same
  problem worse, and known failure 3 is the cost. Nothing blocks this but the work.
- ❓ Should `undocumented-*` rows default to `not_run` rather than being probed
  at all? Probing an undescribed route is how the runner nearly fired
  `POST /api/privacy/delete`. The counter-argument is that silence hides new
  routes — but the drift warning already covers that, which is the point of the
  bidirectional check.
- ❓ Is `isNulogdashAdmin` reading an env var the right long-term gate? It is
  fail-closed and cheap, but rotating an admin means a redeploy, and the console
  cannot show *who* else is an admin.

## See also

- [[decision-nulogdash-browser-trigger-handshake]] — the two-action dry→live
  handshake behind `canPerformAdminAction`
- [[decision-self-implemented-totp-over-clerk-pro]] — why the MFA gate currently
  admits nobody
- [[entity-playwright-e2e]] — the browser tier that merges into the same run
  file, and the source of the auth pattern known failure 3 wants
- [[entity-model-usage-log]] — `pipeline_run_log`, what the pipelines tab reads
- [[entity-clerk]] — `proxy.ts` route protection, and the 404-not-401 behavior
  behind known failure 1
- [[concept-test-strategy]] — where this sits relative to the vitest layers
- [[entity-dev-command-suite]] — the `/nulogdash` command wrapper
- `../nulogdash-dashboard-plan.md` — the original design
