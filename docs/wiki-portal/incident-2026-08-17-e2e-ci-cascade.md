---
date: 2026-08-17
type: incident
tags: [ci, e2e, playwright, clerk, secrets, github-actions, debugging]
sources: [../../.github/workflows/e2e-resiliency.yml, ../../e2e/auth.setup.ts, ../../playwright.config.ts, ../../scripts/sync-e2e-secrets.sh, ../../e2e/preflight/credentials.spec.ts, PR#64]
---

# Incident: Five Stacked Failures Kept the E2E `auth` Job Red, Each Masking the Next

## Date & severity

**2026-08-17** — Severity: **Low** for the product (no user impact, no bad code
merged, no secrets leaked), **high as a process lesson**. The cost was time:
five CI round-trips, each fixing a real bug and revealing another, because
every error message pointed at the wrong layer.

## What happened

PR #64 added the Playwright suite ([[entity-playwright-e2e]]). Its `auth` job —
sign in a Clerk test user once, save `storageState` for the `frontend` tier —
failed on every attempt, for a **different reason each time**:

1. **Wrong Clerk instance.** `.env.local` held two key pairs, a `pk_test_`/
   `sk_test_` dev pair and a `pk_live_`/`sk_live_` production pair. dotenv is
   last-wins, so the *live* pair was active locally and got synced to CI.
   Symptom: `Error: Publishable key not valid.`
2. **Test user existed in the wrong instance.** After switching to the dev
   pair, the user itself had been created in production. Symptom: sign-in
   rejected valid credentials.
3. **Concurrency cancellation.** `cancel-in-progress: true` (correct, and
   deliberately added) killed a run mid-flight when a docs commit landed
   seconds later. Symptom: `auth: cancelled` — read as "someone cancelled
   this", not "a newer push superseded it".
4. **Job timeout set by guess.** `timeout-minutes: 5`, chosen without
   measuring. Installing Playwright browsers on a cold cache alone took
   **2m48s**. Symptom: also `cancelled` — GitHub reports a timeout kill
   identically to a manual cancel, which is what made #3 and #4
   indistinguishable and cost two cycles.
5. **A one-character secret.** The root cause of the *original* symptom.
   See below.

Underneath all of that sat a sixth issue: the `auth` job's `env:` block passed
only the four Clerk vars, but `playwright.config.ts`'s `webServer` boots the
real `next dev`, and `lib/db.ts` calls `neon(process.env.DATABASE_URL!)` at
module scope (reachable from `app/page.tsx` via `lib/track-record.ts`). Without
it the server threw on every request and never became ready. Symptom:
`Timed out waiting 120000ms from config.webServer` — which names nothing about
a missing variable.

## Root cause

The headline bug, and the one worth remembering:

```bash
printf '%s' "$value" | gh secret set "$name" --body -   # WRONG
```

**`gh secret set --body` takes the value as a literal string.** It reads stdin
only when `--body` is omitted entirely. So this stored a secret whose value was
the single character `-`, for every variable the sync script pushed — and `gh`
reported success each time.

```bash
printf '%s' "$value" | gh secret set "$name"            # correct
```

This is why a Clerk key that was demonstrably valid (verified directly against
Clerk's API, HTTP 200) still produced *"Publishable key not valid"* in CI: the
value in CI was one byte long. Proven with a throwaway workflow echoing
`${#PK}` — **1 before the fix, 58 after**.

Two properties made it survive so long:

- **`gh secret list` cannot detect it.** It shows a name exists, never that the
  value is intact. Every audit of "are the secrets set?" came back clean.
- **The failure surfaced far from the cause,** in a third-party SDK's
  validation message, on a different machine, one layer below the code under
  test.

## Resolution

All six fixed on PR #64:

1. Removed the duplicate live Clerk pair from `.env.local`; kept the dev pair.
2. Created the test user in the dev instance (and later a reserved
   `+clerk_test` address, which is exempt from Clerk's new-device email-code
   challenge that a headless run can never satisfy).
3. Left `cancel-in-progress` as-is — correct behavior, just needs to be read
   correctly.
4. `timeout-minutes: 5 → 15`; `webServer.timeout: 120s → 180s`.
5. Fixed `~/.claude/scripts/sync-secrets.sh` (the shared script, so it cannot
   recur in other repos) and documented the trap in the `secrets-sync` skill.
6. Passed the full set of env vars `next dev` needs to boot, not just what the
   auth flow touches.

Also fixed along the way, both found by running things that had never been
run: `baseURL` used `??` against `NULOGDASH_BASE_URL`, which ships *empty* in
`.env.example` — and `??` only falls back on `null`/`undefined`, not `""`, so
`baseURL` became `""` and every `page.goto()` failed with "Cannot navigate to
invalid URL". And eslint was linting Playwright's generated trace-viewer
bundle into 3030 vendor errors, because eslint does not read `.gitignore`.

## Impact on design

- **A gate should block what depends on it, not everything.** The final
  blocker was `preflight` asserting *every* credential including Stripe, which
  made a Clerk sign-in test unrunnable behind a placeholder
  `STRIPE_WEBHOOK_SECRET`. Split into `preflight` (core: Clerk, OpenRouter,
  `DATABASE_URL`) and `preflight-billing` (Stripe, gating nothing else). See
  [[entity-playwright-e2e]].
- **Anything a dev server needs to *boot* belongs in the CI env block**, even
  when the test never touches it. Module-scope side effects (`neon()` at
  import time) mean an unrelated missing var breaks every page.
- **Verify length, not presence, after a bulk secret sync.** Presence checks
  are the ones that pass while the value is wrong.
- **Read a timeout as "check the logs above", not "too slow".** Both the
  `webServer` timeout and the job timeout surfaced problems that had nothing to
  do with duration.
- **Debug the whole path in one pass when errors keep misdirecting.** Five
  single-fix round-trips cost far more than one audit of the full boot chain
  would have. The round that finally moved things forward was the one that
  grepped *all* distinct errors from a run at once instead of taking the first
  one at face value.

## Resolution status

**Resolved 2026-08-17.** Run `32089144456`: `auth: success`, 5 tests in 23.1s,
`storageState` uploaded.

**Counting the causes.** Eight distinct causes were fixed in total. The title's
"five" counts only the chain that *masked each other* in the `auth` job's error
message (causes 1–5 in "What happened"). Separate from that chain sit three
more: the boot-env `DATABASE_URL` gap (the "sixth issue" above, fixed as item 6
in Resolution), plus the two below that surfaced after this page was first
written — **8 total (5 masking chain + 1 boot-env + 2 late)**, not seven.

7. **Clerk's redirect URL was never passed to CI.** Sign-in was *succeeding*
   and landing on `/` rather than `/dashboard`
   (`NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` is set in `.env.local`
   but wasn't in the workflow), while the test asserted that exact
   destination. A passing auth flow was reported as an auth failure for
   several runs. Fixed both by passing the var *and* by asserting the session
   instead of a URL — wait to leave `/sign-in`, then confirm `/dashboard`
   holds, which proves the session via `middleware.ts` regardless of landing
   spot.
8. **`--with-deps` apt-get time is unbounded in practice.** 2m48s in one run,
   >15min in the next, consuming the whole job budget so sign-in never ran.
   Fixed with step-level `timeout-minutes`, which matters more than the job
   budget: GitHub reports a timeout kill as `cancelled`, indistinguishable
   from a real cancel, and that ambiguity alone cost two debugging cycles.

## Open items

- ❓ **GCP WIF is now the top blocker.** With `auth` green, all four `e2e`
  shards start and immediately fail at "Authenticate to GCP (keyless)" —
  `GCP_WIF_PROVIDER` is empty because the pool was never provisioned. Run
  `bash scripts/sync-e2e-secrets.sh --provision-wif`.
- ❓ Clerk's new-device verification is currently worked around by using a
  `+clerk_test` address and typing the fixed code `424242`. Disabling the
  requirement on the dev instance would remove the most fragile step in the
  setup; the OTP branch is conditional and would simply stop firing.
- ❓ `GCP_WIF_PROVIDER` / `GCP_SERVICE_ACCOUNT` are still unprovisioned, so the
  sharded `e2e` job has never run at all.
- ❓ CodeRabbit has been rate-limited for this PR's entire lifetime and has
  **never actually reviewed it**, while still reporting a green check. A green
  bot check is not evidence of review here.

## See also

- [[entity-playwright-e2e]] — the suite this incident is about
- [[concept-test-strategy]] — the vitest layers this sits above
- `docs/e2e-next-steps.md` — the live checklist of what remains
- `docs/stripe-todo.md` — where the three unset billing values come from
- `docs/env-rotation.md` — the credentials exposed to an agent context earlier
  in the same session, unrelated to this cascade but rotated as a result
