# E2E — Next Steps

Current state of the Playwright suite and what's left, as of **2026-08-17**,
after the `auth.setup.ts` fixes landed on `feat/playwright-e2e-suite` (PR #64).

Supersedes the "Blockers" section of `playwright-todo.md` — that file's
blockers #1–#5 are now mostly closed (see below). Its **Optimization** and
**Future robust test ideas** sections are still current and not repeated here.

---

## Done since the last pass

- ✅ **Committed.** `e2e/`, `playwright.config.ts`, `e2e-resiliency.yml`,
  `scripts/nulogdash-merge-e2e.mjs`, `scripts/sync-e2e-secrets.sh` are all on
  the branch and in PR #64.
- ✅ **Clerk test user works end to end.** `npx playwright test
  --project=auth-setup` signs in and writes `playwright/.auth/user.json`.
  Four bugs fixed to get there — an OTP race on `/sign-in/factor-one`, two
  strict-mode selector violations, and an unnecessary
  `setupClerkTestingToken()` call. See the commit message for detail.
- ✅ **Dev-vs-live Clerk instance resolved.** `.env.local` had duplicate key
  pairs; the live pair was winning (dotenv is last-wins) and being synced to
  CI, where it failed *"Publishable key not valid."* Live pair removed; the
  suite now runs against the dev instance, which is where the test user lives.
- ✅ **`NULOGDASH_ADMIN_EMAILS` populated** and the admin dash confirmed
  rendering at `/dashboard/nulogdash` (HTTP 200), including the browser-tier
  row from `nulogdash-merge-e2e.mjs`.
- ✅ **12 GitHub Actions secrets synced** via `scripts/sync-e2e-secrets.sh`.
- ✅ **`ANTHROPIC_API_KEY` eliminated** — it was dead code end to end
  (no route read it, `@anthropic-ai/sdk` was unused, `lib/env.ts`'s field was
  never imported).
- ✅ **Two latent bugs fixed along the way:** `baseURL` used `??` against an
  env var that ships *empty* (so it never fell back, and every `page.goto()`
  failed); and eslint was linting Playwright's generated trace-viewer bundle
  into 3030 vendor errors because it doesn't read `.gitignore`.
- ✅ **Two workflow bugs fixed** once CI got far enough to hit them: the
  `auth` job's `timeout-minutes: 5` was a guess that a cold browser cache
  (~3min) blew straight through, killing sign-in and reporting it as
  *"cancelled"* — misleading enough to cost two debugging cycles. Raised to
  15. And the `report` job hard-failed on `Directory does not exist:
  all-blob-reports` whenever `e2e` was skipped; it now detects the empty case
  and says *"the e2e job never ran, check auth"* rather than printing a
  meaningless `0 passed · 0 failed`.

---

## Open — ordered by what unblocks the most

### 1. Turn off Clerk's new-device verification (recommended)

`auth.setup.ts` currently depends on `E2E_CLERK_TEST_EMAIL` being a reserved
Clerk `+clerk_test` address, which is exempt from email verification and
accepts the fixed code `424242`. That works, but it's a dependency on Clerk
keeping that behavior, and the OTP-typing step is the most fragile part of
the setup.

**Action:** in the Clerk dashboard for the **dev** instance, disable the
new-device / device-trust verification requirement. Then the OTP branch in
`auth.setup.ts` simply never fires (it's already conditional, so no code
change is needed — it will fall straight through to the `/dashboard` wait).

Leave the OTP branch in place regardless: it costs nothing when unused and
keeps the setup working if the requirement is ever re-enabled.

### 2. Provision the GCP Workload Identity Federation pool

`e2e-resiliency.yml`'s `e2e` job authenticates to GCP keylessly, and
`GCP_WIF_PROVIDER` / `GCP_SERVICE_ACCOUNT` don't exist yet.

```bash
bash scripts/sync-e2e-secrets.sh --provision-wif [gcp-project-id]
```

Creates the pool, an OIDC provider scoped to `adamaslan/nuwrrrld-portal`, and
a service account, then prints the two identifiers to push. **Still manual
afterwards:** grant that service account only the role the MCP identity-token
step needs (e.g. `roles/run.invoker` on `gcp3-backend`) — the script
deliberately grants nothing beyond `roles/iam.workloadIdentityUser`.

### 3. Three secrets still unset

All three are skipped by the sync script because they're placeholder or empty
in `.env.local`. **Where to get each is documented in `docs/stripe-todo.md`.**

| Variable | State | Blocks |
|---|---|---|
| `STRIPE_WEBHOOK_SECRET` | placeholder | `preflight`'s placeholder-detection test; webhook handling generally |
| `STRIPE_PRICE_ANNUAL` | placeholder | Same, plus `/api/health`'s Stripe check reports `not_configured` |
| `PORTAL_PUSH_SECRET` | empty | Nothing in the current suite — only needed if `refresh-signals.py` or another internal caller is actually deployed |

After filling any of them: `bash scripts/sync-e2e-secrets.sh`.

Note `preflight` currently **fails** on the first two, and because `health`,
`auth-setup`, and `frontend` all declare `dependencies: ["preflight"]`, a
local full-suite run stops there. That's the gate working as designed, but it
does mean the frontend tier can't run locally until these are real.

### 4. Two pre-existing CI failures, unrelated to this suite

Neither is caused by the Playwright work; both predate it and are listed so
they aren't mistaken for regressions.

- **`shared-drift-check`** — `lib/subscription.ts` has drifted from
  `gcp3-mobile`'s copy. This PR never touches that file (`git diff origin/main
  -- lib/subscription.ts` is empty). Fixing it means reconciling the two
  repos, which is a cross-repo decision.
- **`Cloudflare Pages`** — has failed on every PR since #37. Already
  investigated: `docs/cloudflare-pages-assessment.md` concludes the
  integration should be disabled via one Cloudflare API call (keep the
  project, turn off GitHub-triggered builds). Not a code problem.

### 4a. The real cause of the CI Clerk failures: a 1-character secret

Worth recording because the symptom pointed nowhere near the cause. CI kept
failing with *"Publishable key not valid"* while the identical key worked
locally. The key was fine — **the secret in GitHub was one character long.**

`scripts/sync-e2e-secrets.sh` (via `~/.claude/scripts/sync-secrets.sh`) used:

```bash
printf '%s' "$value" | gh secret set "$name" --body -   # WRONG
```

`gh secret set --body` takes the value as a literal **string**, so this stored
`-`. It reads stdin only when `--body` is omitted entirely:

```bash
printf '%s' "$value" | gh secret set "$name"            # correct
```

Fixed in the shared script, so it won't recur in other repos. Confirmed by a
throwaway workflow echoing `${#PK}`: 1 before, 58 after. **`gh secret list`
cannot catch this** — it shows the name exists, never that the value is
intact. If a synced secret ever behaves as though it's wrong, check its
length before suspecting the credential itself.

### 4b. `auth` has still never passed in CI

Verified working **locally** (writes `playwright/.auth/user.json`), but every
CI attempt so far died for a different reason than the last: bad Clerk keys,
then `cancel-in-progress` killing it mid-run, then the 5-minute timeout. All
three are fixed; the next run is the first real test of the sign-in flow on a
GitHub runner. Treat a green `auth` as the first genuine confirmation, and
don't assume the local pass generalizes until then.

### 5. Verify the browser tier reaches the admin dash from a real CI run

`scripts/nulogdash-merge-e2e.mjs` has been verified locally — the admin dash
renders its browser-tier row. What hasn't happened is a **CI** run merging
real `frontend`-tier results, since that tier has never completed. Once #1–#3
are done, run `npm run test:e2e:nulogdash` and confirm the dashboard shows
passing browser-tier features rather than the current all-fail state.

---

## Not blockers, but worth deciding

- **`docs/clerk-todos.md` has a stray `p` typo on line 1** (`p# Clerk`) —
  pre-existing, deliberately left out of PR #64 to keep that PR scoped. Trivial
  to fix in any commit that touches the file.
- **`lib/env.ts` is dead code.** It's a complete zod env schema that nothing
  imports — every route reads `process.env` directly. Either wire it up (it
  would have caught the empty-`NULOGDASH_BASE_URL` class of bug) or delete it.
  Its existence also makes `concept-test-strategy.md`'s claim that there is
  "no env schema module in this branch" stale.
- **`playwright-todo.md`'s Optimization section** still has live items worth
  doing — `data-testid` hooks, shard-count tuning, exercising the 6-day
  `STALE_AFTER_MS` re-auth path, and offline-safe variants of the two `ci`
  tests that need live network.

## See also

- `docs/e2e.md` — the operating manual (env contract, VS Code guide, CI rationale)
- `playwright-todo.md` — optimization items + 10 ranked future test ideas
- `docs/stripe-todo.md` — where to find the three unset secrets
- `docs/env-rotation.md` — credentials exposed to an agent context that need rotating
- `docs/wiki-portal/entity-playwright-e2e.md` — the wiki-side durable record
