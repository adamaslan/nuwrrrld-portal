# What a Neon API key unblocks

Scope note up front: this is a **narrow** unblock with a **wide** second-order
effect. It fixes exactly one CI job. That job happens to be the only automated
check standing between the signal queue and production, and its permanent-red
status is currently degrading the trustworthiness of every other check in the
repo.

Written 2026-08-29, from the failing run
[`33272021874`](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/33272021874)
on `feat/auth-cookies-phase-1-3-6`.

---

## 0. Naming — read this first

The variable that unblocks anything is **`NEON_API_KEY`**, not `NEON_DB_API_KEY`.
Nothing in this repository reads `NEON_DB_API_KEY`; a grep across every `.ts`,
`.mjs`, `.js`, `.yml`, and `.json` returns zero hits. Setting it under that name
unblocks nothing, silently.

Two values are needed, and **both are currently empty** — a detail the earlier
write-up in [manual-setup-todo.md](manual-setup-todo.md) understated by
attributing the failure to the key alone:

| Name | Shape | Where it comes from |
|---|---|---|
| `NEON_API_KEY` | `napi_…` — an **account** API key | Neon console → Account settings → API keys → Generate |
| `NEON_PROJECT_ID` | `lingering-rain-31058530` (per the `.env.local` comment — verify) | Neon console → Project settings → General |

They are **GitHub Actions repo secrets**, not local env vars. Putting them in
`.env.local` accomplishes nothing — no local code path reads them. This is the
most common way this particular task gets marked done without being done.

`DATABASE_URL` is a different thing entirely (a Postgres connection string, not
an API key) and is already wired.

---

## 1. The failure, precisely

From the run log, the *delete* step — which runs `if: always()`, so it fires even
after the create step fails:

```
env:
  NEON_API_KEY:
  NEON_API_HOST: https://console.neon.tech/api/v2

  neonctl branches delete "ci-integration-33272021874" --project-id

ERROR: Cannot run interactive auth in CI
##[error]Process completed with exit code 1.
```

Note `--project-id` with no argument following it. Both secrets resolve empty,
so `neonctl` has neither credential nor target, falls back to an interactive
browser login, and dies on a headless runner.

**Failure history — five consecutive, across both open PRs:**

| Run | Branch | When | Duration |
|---|---|---|---|
| 33272021874 | `feat/auth-cookies-phase-1-3-6` (#78) | 19:53 | 41s |
| 33265254042 | `feat/auth-cookies-phase-1-3-6` (#78) | 17:17 | 34s |
| 33245019861 | `feat/auth-cookies-phase-1-3-6` (#78) | 09:14 | 42s |
| 33244501579 | `feat/auth-cookies-phase-1-3-6` (#78) | 09:01 | 32s |
| 33235144085 | `feat/consent-cookies-tracking` (#77) | 05:00 | 34s |

Every run dies in ~35 seconds without executing a single test. It is not flaky,
not intermittent, and not related to either PR's contents — it predates both.

---

## 2. What the job actually does when it works

[`.github/workflows/integration-tests.yml`](../.github/workflows/integration-tests.yml),
four steps that matter:

1. **Create an ephemeral Neon branch** — a real, isolated Postgres copy named
   `ci-integration-<run_id>`, via `neondatabase/create-branch-action@v5`.
2. **Migrate the schema onto it** — `node scripts/db-migrate.mjs`, applying all
   27 tables in [`lib/db/schema.sql`](../lib/db/schema.sql).
3. **Run the integration test** against that branch.
4. **Delete the branch** (`if: always()`, so it cleans up even on failure).

The branch is throwaway and isolated. **Production is never touched.** That
isolation is the entire point of using the API key rather than pointing CI at
`secrets.DATABASE_URL`.

---

## 3. Unblock #1 — the only real-Postgres coverage in the repo

[`__tests__/signal-queue.integration.test.ts`](../__tests__/signal-queue.integration.test.ts)
is the sole test that runs against actual Postgres. Everything else mocks the
database. It has four assertions, and each one covers a class of bug that
**type-checking and unit tests structurally cannot catch**:

| Test | What only a real database can prove |
|---|---|
| `enqueue dedups a rapidly-repeated ticker to one pending row` | The partial-unique-index / `ON CONFLICT` dedup actually holds under three back-to-back inserts. A mock always "dedups". |
| `claim flips the row to processing and is not re-claimable immediately` | `FOR UPDATE SKIP LOCKED` leasing works. This is the one that matters — a broken lease means **two workers process the same ticker simultaneously**, and no mock will ever reveal it. |
| `a failure under the cap requeues with a future next_attempt_at` | Backoff arithmetic evaluated by Postgres' clock, not JS's. Timezone and `now()` semantics live here. |
| `getQueueStats returns numeric counters` | Postgres returns numbers, not strings. `::int` casts are easy to drop and produce silent string-concatenation bugs downstream. |

The test guards itself with `describe.skipIf(!HAS_DB)`, so in the default unit
suite it **skips green**. That is a deliberate design choice with an unfortunate
consequence: *nothing anywhere reports that this coverage is missing.* The suite
passes. The queue looks tested. It is not.

### Why this specific code path

The queue is not a peripheral utility. Its consumers:

- [`app/api/portfolio/watchlist/route.ts:35`](../app/api/portfolio/watchlist/route.ts#L35)
  — `enqueueSignalRefresh(ticker, userId)` fires on **every watchlist add**, the
  primary user-facing write path.
- [`app/api/signals/drain/route.ts:50`](../app/api/signals/drain/route.ts#L50)
  — `claimPendingSignals(BATCH_SIZE)` is the worker that drains the queue.

A leasing bug here means duplicated upstream API calls (Alpaca/Finnhub quota
burn), duplicated writes, and users seeing stale or conflicting signals. This is
precisely the failure mode that only shows up under real concurrency against a
real database — which is the thing that has been dark for five runs.

---

## 4. Unblock #2 — schema migration verification, for free

Step 2 runs `scripts/db-migrate.mjs` against a **clean** branch. That makes it
the only place `lib/db/schema.sql` is exercised from empty on every relevant PR.

This matters right now specifically. [manual-setup-todo.md](manual-setup-todo.md)
§5 asks you to hand-verify that four new tables applied:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('consent_records','legal_consent_events',
                     'privacy_requests','user_attribution');
-- expect 4 rows
```

Those four are the tail of the schema (lines 402–476) and are exactly what PRs
#77 and #78 introduce. **A green integration job proves the migration applies
from scratch**, turning that manual SQL check into an automatic one.

Worth naming a limitation honestly: `db-migrate.mjs` is idempotent
(`IF NOT EXISTS` throughout) and also runs as a `prebuild` step, so a Vercel
deploy migrates too. What the ephemeral branch adds is the **clean-slate** case —
catching ordering bugs, missing dependencies between tables, and syntax that
happens to be tolerated when a table already exists.

---

## 5. Unblock #3 — the compounding cost of a permanently-red check

This is the effect that is larger than the job itself, and the one that does not
appear on any dashboard.

Five consecutive red runs on a check that has nothing to do with either PR's
contents trains everyone — human and agent — to read `integration ✗` as noise
and merge past it. The cost is not the missing coverage. **The cost is that when
this job eventually catches a genuine queue regression, that signal arrives in a
channel everyone has already learned to ignore.**

There is a second-order version of the same problem: because the failure is
infrastructural and identical on both PRs, it also masks the possibility that
one of them *would* fail this job on its merits. Nobody can tell, because the
job never reaches step 3.

---

## 6. Unblock #4 (optional, and worth doing) — get production out of CI

Two other workflows currently hand CI the **production** database:

- [`compile-grounding-pack.yml:29`](../.github/workflows/compile-grounding-pack.yml#L29)
  — `DATABASE_URL: ${{ secrets.DATABASE_URL }}`, runs weekly on a cron *and* on
  every push to `main` touching `corpus/`.
- [`e2e-resiliency.yml:113,216`](../.github/workflows/e2e-resiliency.yml#L113)
  — same, needed because `lib/db.ts` calls `neon(process.env.DATABASE_URL!)` at
  module scope, so `next dev` cannot boot without it.

`manual-setup-todo.md` §2 flags this, and it deserves restating plainly: once
`NEON_API_KEY` exists, these jobs *can* mint their own ephemeral branches instead
of operating on live user data. The grounding-pack job in particular does
`ON CONFLICT` upserts directly into production tables from a scheduled trigger.

This is **not required** to turn CI green — it is the strategic reason the key is
worth having beyond the immediate fix, and the reason not to shortcut the whole
problem by pushing production `DATABASE_URL` in as the CI secret.

---

## 7. What it does *not* unblock

Stated explicitly, because scope creep on "unblocks CI" is easy:

- **Nothing locally.** `npm run test:integration` already works today if you set
  `DATABASE_URL` to any Neon branch yourself. The key changes nothing about
  local development.
- **No product features.** No auth, payments, pipeline, or UI behavior depends on it.
- **Not the other five failing/blocked items** in `manual-setup-todo.md` — Clerk
  Production (§3), Stripe live-mode verification (§4), `CRON_SECRET` / `PORTAL_URL`,
  the GCP WIF pair, and the vendor DPAs are all independent.
- **Not the retention-enforcement job or GDPR Art. 18 restriction** (§7 there) —
  those are unwritten code, not blocked credentials.

---

## 8. Doing it

Two secrets, set once, at the repo level. Run locally so no value passes through
a chat session:

```bash
# paste the napi_… key when prompted; it is not echoed
gh secret set NEON_API_KEY

# verify this against Neon console → Project settings → General first
gh secret set NEON_PROJECT_ID --body 'lingering-rain-31058530'
```

Then re-run the failed job on either PR:

```bash
gh run rerun 33272021874 --failed
gh run watch
```

**Expected result:** the job runs ~2–4 minutes instead of ~35 seconds (it now
actually installs deps, migrates, and runs tests), and turns green on **both**
open PRs — #77 and #78 — from a single pair of secrets.

A caution carried forward from `manual-setup-todo.md`: `gh secret list` returned
14 rows early in that session and 0 rows minutes later. Verify the set landed
rather than trusting one listing.

---

## Summary

| | |
|---|---|
| **Effort** | Two dashboard values, one `gh secret set` pair. Minutes. |
| **Directly unblocks** | The `integration` CI job, currently red on 100% of runs. |
| **Restores** | The only real-Postgres coverage in the repo — queue dedup, `SKIP LOCKED` leasing, retry backoff, numeric casts. |
| **Adds** | Clean-slate schema migration verification, automating a manual SQL check. |
| **Fixes structurally** | A permanently-red check that is teaching everyone to ignore CI. |
| **Enables later** | Getting production `DATABASE_URL` out of two other CI workflows. |
| **Risk** | None to production. The branch is ephemeral and deleted via `if: always()`. |
