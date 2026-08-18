# Known Bugs — as of 2026-08-18

A snapshot of every confirmed-real bug/gap found while building and reviewing
the Playwright suite (PR #64), consolidated into one list. This is a status
doc, not a to-do runbook — see `docs/e2e-next-steps.md`,
`playwright-todo.md`, and `docs/stripe-todo.md` for the corresponding action
items. No further testing or fixing was done after this snapshot was taken.

---

## Blocking the `frontend` Playwright tier

### 1. E2E test user has no Pro-tier entitlement

**The single largest blocker.** `/dashboard/nuai`, `/dashboard/signals`, and
`/dashboard/portfolio` are all entitlement-gated:

```
app/dashboard/nuai/page.tsx:23       hasEntitlement("nu_ai", tier)      → redirect /pricing?source=nuai
app/dashboard/signals/page.tsx:23    hasEntitlement("signals_digest", tier) → redirect /pricing?source=signals
app/dashboard/portfolio/page.tsx:63  hasEntitlement("nu_ai", tier)      → redirect /pricing?source=portfolio
```

New Clerk users default to `subscription_status: 'free'`
(`lib/subscription.ts:70`), and `'free'` fails all three checks. The E2E test
user (`E2E_CLERK_TEST_EMAIL`) has never had its `publicMetadata` set to a paid
tier, so every `frontend` test that navigates to one of these three routes
redirects to `/pricing` before its assertions ever run — confirmed by reading
the actual failure page snapshots, which showed pricing-page content
(`Start 7-day free trial`, `Best value — save 34%`) instead of the target
component.

**Concretely affects:** all of `nuai-fault-injection.spec.ts` (3 tests),
`signal-timing.spec.ts` (3 tests), and most of `portfolio-health.spec.ts`
(the tests hitting `/dashboard/portfolio` specifically — the ones asserting
only against `page.request` without a `page.goto()` are unaffected).

**Fix:** set the test user's `publicMetadata.subscription_status` to `'pro'`
via the Clerk dashboard or Backend API. Not done — flagged, not fixed, per
this session's stop instruction.

### 2. `STRIPE_PRICE_ANNUAL` still a placeholder

`e2e/health/dependencies.spec.ts`'s "every dependency is reachable" test
fails because `/api/health` reports Stripe `not_configured`:
`STRIPE_PRICE_ANNUAL is unset or a placeholder`. Documented in
`docs/stripe-todo.md` with exactly where to get a real value. Also blocks
`preflight-billing` entirely (by design — see item 6 below).

### 3. Portfolio-suggestions test failure — root cause not fully isolated

`portfolio-health.spec.ts`'s "DIAGNOSE: suggestions silently fail" test
navigates to `/dashboard/portfolio` and expects `.port-health-error` to
appear. It fails with "element not found." Given finding #1 above (the same
route is entitlement-gated), this is **very likely** the same redirect-to-
`/pricing` cause — but the specific error-context artifact that would confirm
this was overwritten by a later test run before I could re-check it, so this
is recorded as *likely*, not *confirmed*. Re-run
`npx playwright test -g "suggestions silently fail"` and inspect
`test-results/*/error-context.md` for the page snapshot to confirm.

---

## Real bugs fixed during CodeRabbit review (already resolved, listed for the record)

These were found and fixed in commit `7db2cc1` — listed here only so this
doc is a complete inventory of everything discovered this session, not
because they're still open.

4. ~~`auth-setup` captured the real Clerk test password into 7-day CI trace
   artifacts~~ — fixed, capture disabled for that project.
5. ~~Workflow-level `id-token`/`pull-requests: write` granted to every job
   including `auth`~~ — fixed, scoped to `e2e`/`report` only.
6. ~~The "stalled SSE" test used `route.fulfill()`, which completes the
   response immediately and never actually simulated a stall~~ — fixed to
   hold the route open indefinitely. (Now blocked by #1 above regardless.)
7. ~~`e2e/health/dependencies.spec.ts`'s known-failing EXPOSE test had no
   `test.fail()` despite being wired into required CI~~ — fixed. Also found
   `getByRole("alert")` was matching Next.js's own built-in
   `#__next-route-announcer__`, not real health-down UI, and the test had no
   auth session at all — both fixed.
8. ~~`nulogdash-merge-e2e.mjs`'s redaction set missed DB connection strings
   and email addresses~~ — fixed.
9. ~~Browser-tier Playwright rows were double-counted into nulogdash's
   "features not run" headline~~ — fixed, split before aggregating.
10. ~~`.nulogdash/` directory missing on a fresh checkout broke
    `refresh-free-models.spec.ts`~~ — fixed with `mkdir`.
11. ~~Fork PRs get no secrets; `auth` job would fail rather than skip~~ —
    fixed with an `if:` guard.

Full detail on all of these: see the `7db2cc1` commit message, or
`docs/wiki-portal/incident-2026-08-17-e2e-ci-cascade.md` for the earlier
seven-failure chain that got `auth` passing in the first place.

---

## Pre-existing CI failures, unrelated to any of the above

12. **`shared-drift-check` fails.** `lib/subscription.ts` has drifted from
    `gcp3-mobile`'s copy. Confirmed via `git diff origin/main --
    lib/subscription.ts` (empty) that this PR never touches that file — the
    drift predates this branch entirely. Fixing it means reconciling two
    repos, outside this PR's scope.
13. **`Cloudflare Pages` fails.** Documented, known-broken since PR #37
    (`docs/cloudflare-pages-assessment.md`) — the integration should be
    disabled via a Cloudflare API call, not a code fix.

---

## CodeRabbit findings against the fix commit itself (2026-08-18T03:25:19Z, unaddressed)

CodeRabbit completed a second, real review pass against `7db2cc1` (the
CodeRabbit-fix commit) — this one was not rate-limited. Three findings, none
merge-blocking, none fixed:

17. **`docs/e2e-next-steps.md`'s blocker section overstates GCP WIF as the
    sole remaining blocker.** It's the blocker for the 4 sharded `e2e` jobs
    specifically — the independent `preflight-billing` project is still red
    on the 3 unset Stripe values regardless of WIF. The doc also still
    describes the old, pre-split `preflight` dependency graph in one spot,
    contradicting the corrected description a few lines earlier.
18. **Incident doc's cause count doesn't add up.** `docs/wiki-portal/
    incident-2026-08-17-e2e-ci-cascade.md` claims two later fixes "bring the
    total to seven," but the doc already lists 6 causes plus a separately-
    numbered "sixth cause" (the missing `DATABASE_URL` in CI env) at an
    earlier point in the doc — by CodeRabbit's count the real total is 8,
    not 7, unless the boot-env issue was meant to be excluded from the
    count. Needs the counting scope stated explicitly and the title/summary/
    resolution-status made consistent.
19. **`e2e/health/dependencies.spec.ts`'s EXPOSE test still has no real
    target to assert against.** The fix in `7db2cc1` corrected the selector
    to `main [role="alert"], [data-testid="health-banner"]`, but neither
    `DashboardCockpit` nor `app/dashboard/page.tsx` renders either one —
    confirmed by CodeRabbit's own grep, and consistent with item 15's
    already-known gap (no health-down banner exists in the UI at all). The
    suggested fix is to build the real banner with a `data-testid` and drop
    the generic `role="alert"` fallback once it exists, rather than
    asserting against a selector nothing produces yet.

## CI check state at merge time (2026-08-18)

Six checks red when this PR merged, all traced to causes outside this PR's
diff:

| Check | Status | Cause |
|---|---|---|
| `shared-drift-check` | fail | Item 12 — predates this branch |
| `Cloudflare Pages` | fail | Item 13 — predates this branch, known since PR #37 |
| `e2e` (shards 1–4) | fail | Item 14 — `GCP_WIF_PROVIDER` never provisioned |

`auth`, `test`, `report`, `CodeRabbit`, `Vercel`, `Vercel Preview Comments`
all passed. Merged with the six above still red, per explicit instruction —
none of the six are within this PR's ability to fix (two are cross-repo/
infra-config issues, four need a one-time `gcloud` provisioning step this
session didn't run).

---

## Design gaps, not bugs exactly, but worth knowing

14. **GCP Workload Identity Federation pool never provisioned.**
    `GCP_WIF_PROVIDER`/`GCP_SERVICE_ACCOUNT` are empty, so all four `e2e`
    shards fail immediately at "Authenticate to GCP (keyless)" once `auth`
    passes. One command away: `bash scripts/sync-e2e-secrets.sh --provision-wif`.
15. **`/dashboard/portfolio` gates on the `"nu_ai"` entitlement, not a
    portfolio-specific one.** `app/dashboard/portfolio/page.tsx:63` calls
    `hasEntitlement("nu_ai", tier)` to gate the whole page, even though
    `lib/subscription.ts`'s `FEATURE_TIER_MAP` separately defines
    `portfolio_score: 'free'`. Not necessarily wrong (maybe intentional —
    the whole page bundles AI features), but worth a deliberate look rather
    than assuming it's accidental. Pre-existing, not touched this session.
16. **Clerk new-device email verification worked around, not disabled.**
    `e2e/auth.setup.ts` depends on `E2E_CLERK_TEST_EMAIL` being a reserved
    `+clerk_test` address (exempt from real verification, accepts the fixed
    code `424242`). Functional, but the most fragile step in the setup —
    disabling the requirement on the dev Clerk instance would remove it
    entirely. Not done.

---

## Stopped here

Per instruction, no further tests were run and no further fixes were made
after this snapshot. This list is the complete, current inventory —
cross-reference against `playwright-todo.md`'s Optimization/Future-test-ideas
sections for lower-priority items not repeated here.
