# Known Bugs — last updated 2026-08-18

Bugs and gaps found while building and reviewing the Playwright suite (PR #64),
consolidated into one list. This is a status doc, not a to-do runbook — see
`docs/e2e-next-steps.md`, `playwright-todo.md`, and `docs/stripe-todo.md` for
the corresponding action items.

**Status after PR #65 (2026-08-18):** items 17/18/19 fixed; all others remain
open. Open blockers in priority order: item 1 (Clerk Pro metadata), item 14
(GCP WIF provisioning), item 2 (Stripe price IDs).

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

17. ~~**`docs/e2e-next-steps.md`'s blocker section overstates GCP WIF as the
    sole remaining blocker.**~~ — **fixed.** Header #2 re-scoped to "top
    blocker for the `e2e` shards" and the text now states `preflight-billing`
    stays red on Stripe regardless of WIF; the stale pre-split `preflight`
    dependency-graph paragraph was rewritten to reflect the actual split
    (Stripe gates `preflight-billing` only).
18. ~~**Incident doc's cause count doesn't add up.**~~ — **fixed.**
    `incident-2026-08-17-e2e-ci-cascade.md` now states the counting scope
    explicitly (title's "five" = the masking chain only) and totals **8**
    (5 masking chain + 1 boot-env + 2 late); the resolution-status items were
    renumbered 7 and 8 so they no longer collide with the boot-env "sixth
    issue."
19. ~~**`e2e/health/dependencies.spec.ts`'s EXPOSE test still has no real
    target to assert against.**~~ — **fixed.** Built the real banner:
    `app/dashboard/HealthBanner.tsx` is a client component that fetches
    `/api/health` on mount and renders `data-testid="health-banner"` (wired
    into `app/dashboard/page.tsx`) when any dependency is `down`/`degraded`.
    The EXPOSE test dropped `test.fail()` and the generic `role="alert"`
    fallback, now asserting `getByTestId("health-banner")` — a real
    end-to-end check of the outage path. (Closes the "no health-down banner
    in the UI" gap item 19 referenced — not item 15, which is the separate
    portfolio-entitlement design gap and remains open.)

## CI check state on `main` (after PR #65, 2026-08-18)

Same six checks red as at PR #64 merge — none caused by #64 or #65 diffs:

| Check | Status | Cause |
|---|---|---|
| `shared-drift-check` | fail | Item 12 — cross-repo drift, predates this work |
| `Cloudflare Pages` | fail | Item 13 — known-broken since PR #37 |
| `e2e` (shards 1–4) | fail | Item 14 — `GCP_WIF_PROVIDER` never provisioned |

`auth`, `test`, `report`, `Vercel`, `Vercel Preview Comments` pass.

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

## Open item summary (as of 2026-08-18)

Items that remain unfixed and require action outside a code PR:

| # | Item | What it blocks | Fix path |
|---|---|---|---|
| 1 | E2E test user has no Pro entitlement | All `frontend` tier tests | Clerk dashboard → set `publicMetadata.subscription_status: 'pro'` on the test user |
| 2 | `STRIPE_PRICE_ANNUAL` placeholder | `preflight-billing`; `/api/health` Stripe check | `docs/stripe-todo.md` |
| 3 | Portfolio-suggestions root cause unconfirmed | Diagnosis only | Re-run with item 1 fixed first |
| 12 | `lib/subscription.ts` cross-repo drift | `shared-drift-check` CI | Reconcile portal and mobile copies |
| 13 | Cloudflare Pages integration broken | Cloudflare CI check | Disable via Cloudflare API (see `docs/cloudflare-pages-assessment.md`) |
| 14 | GCP WIF pool never provisioned | All four `e2e` shards | `bash scripts/sync-e2e-secrets.sh --provision-wif` |
| 15 | Portfolio page gates on `nu_ai` entitlement, not portfolio-specific | Design clarity | Deliberate review; may be intentional |
| 16 | Clerk new-device verification worked around | Fragile OTP step in auth setup | Disable on dev Clerk instance |

Cross-reference `playwright-todo.md`'s Optimization/Future-test-ideas sections
for lower-priority items not listed here.
