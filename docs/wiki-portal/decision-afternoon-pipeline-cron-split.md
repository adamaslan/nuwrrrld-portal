---
date: 2026-08-14
type: decision
tags: [ci, cron, scheduler, gcp, zo-migration]
sources: [../../.github/workflows/afternoon-pipeline.yml, ../../.github/scripts/setup-schedulers.sh, PR#59]
---

# Decision: Split Scheduling Across GitHub Actions and GCP Cloud Scheduler, Not a Single Runner

## Decision

The pipeline that replaces Zo's Daily Engine is not one scheduler — it's split by host based on trigger semantics: **GitHub Actions** owns the 3:15 PM ET afternoon pre-close run (`afternoon-pipeline.yml`, weekday cron + `workflow_dispatch` with `dry_run`/`skip_market_check` inputs), while **GCP Cloud Scheduler** (provisioned by `.github/scripts/setup-schedulers.sh`, not yet run against the project) owns the market-clock-anchored jobs: open check (10:15 AM ET), main briefing (12:15 PM ET), post-close scorer (4:30 PM ET). Vercel's 2 free Hobby cron slots are reserved separately for pre-market warm and a weekly calibrator.

## Date

PR #59, 2026-08-14.

## Context

Zo ran everything through one automation runner. Rebuilding that as a single scheduler would recreate a single point of failure and ignore that the three target hosts have different constraints: GHA is free/unlimited on this repo and has first-class `gh issue create` + artifact upload for failure visibility, but its cron has ~minutes of jitter unsuitable for anything genuinely time-critical. GCP Cloud Scheduler is precise and has 3 free jobs — exactly enough for the three market-clock fires. Vercel Hobby caps at 2 jobs, once-daily.

The `afternoon-pipeline.yml` workflow itself calls four portal routes (`/api/pipeline/signals-refresh`, `/api/pipeline/council-run`, `/api/pipeline/theses-score`, `/api/pipeline/council-validate-distribution`) that **do not exist yet** — this PR ships the orchestration and the failure-notification path ahead of the routes it will call, so the workflow will 404 until a follow-up PR lands them. (These are the namespaced paths adopted after CodeRabbit's review; see the next paragraph for why the original `/api/signals/refresh`-style names were dropped.)

A YAML bug was caught during pre-commit validation before merge: the `notify` job's `gh issue create --body` heredoc had three lines with zero indentation inside a `run: |` block scalar, which terminates the literal block early in YAML and would have made the entire workflow file fail to parse in CI. Fixed by aligning all lines to the block's 10-space baseline before commit — see [[concept-test-strategy]] for why syntax validation runs before merge, not after a CI failure.

CodeRabbit's review of this PR then surfaced a more substantive finding: the workflow's original 4 trigger routes reused `/api/signals/refresh` — but that path **already exists** for an unrelated purpose (a local `refresh-signals.py` script pushes a pre-computed `DigestPayload` there, authenticated with `PORTAL_PUSH_SECRET`, not `CRON_SECRET`). Reusing the path would have made the afternoon pipeline silently 401 forever against a live, working endpoint rather than failing loudly against a route that simply doesn't exist yet. Fixed by namespacing all 4 pipeline-trigger routes under `/api/pipeline/*` instead — a path with no existing occupant. Also fixed in the same pass: the two EST/EDT schedule entries both fired every weekday with no DST gate (duplicate live runs an hour apart, each with real writes since `dry_run` defaults to `false` on a scheduled trigger — now gated on the actual America/New_York wall-clock hour); the post-close-scorer GCP job was missing `--time-zone` (would have fired at 16:30 UTC, not 4:30 PM ET); default `GITHUB_TOKEN` permissions were unscoped (now `contents: read` by default, `issues: write` only on the notify job); and curl calls weren't checked for non-2xx status, so a failed portal call would silently continue instead of failing the run (the distribution-check step's failure was explicitly swallowed with `|| echo ... non-fatal` — removed, since that check exists specifically to catch issue #12's uniform-HOLD regression).

## Alternatives considered

- **One GitHub Actions workflow for everything, including market-clock jobs.** Rejected — GHA scheduled-workflow start times can slip by several minutes under load, which is fine for a 3:15 PM pre-close buffer but not for a 9:45 AM open check meant to fire right after the bell.
- **Move everything to GCP Cloud Scheduler.** Rejected — GHA already has `gh issue create` for failure alerts and artifact retention for free; duplicating that on GCP is more code for no benefit, and GHA's free-tier concurrency is generous enough for the afternoon run's own retry/`concurrency: cancel-in-progress: false` guard.
- **Wait to ship the workflow until the 4 trigger routes exist.** Rejected for this PR — the routes are a separate, larger unit of work (see the zo-migration status doc in `homebase/docs/`), and holding the CI/scheduler infra hostage to that would leave the setup script and workflow sitting uncommitted indefinitely, which is what had already happened before this PR.

## Consequences

- The afternoon workflow is **merged but non-functional** until the 4 trigger routes ship — `gate` + secret-verification steps will pass, but `signals`/`council`/`theses`/`distribution` steps will 404. This is documented in the PR body's test plan as an explicit unchecked item, not silently accepted.
  - **Still true as of 2026-09-03** (PR #102, live probe): all 4 routes 404 in production and are absent from the repo — no follow-up PR has landed them in ~3 weeks. The secret-preflight step also still fails: `CRON_SECRET`/`PORTAL_URL` are unprovisioned not only on GitHub Actions but in `.env.local` too. Meanwhile the *sibling* pipeline routes have progressed — `precompute-ai` and `hydrate-universe` (PR #66) now return 401 (healthy), and the three `followed-tickers*` routes are deployed but return **503** to an unauthenticated request, throwing before the auth check. Full probe table: `docs/pipeline-route-status-issues.md`.
- `setup-schedulers.sh` has not been run against the GCP project — no GCP Cloud Scheduler jobs exist yet. Running it is still a manual follow-up step (`CRON_SECRET=<value> bash .github/scripts/setup-schedulers.sh`).
  - **Full census, 2026-09-04** (PR #107, `docs/scheduler-census.html`): of the 4 hosts this decision and its Modal counterpart name, cron is actually firing on two — GitHub Actions (10/10 scheduled workflows live) and Modal (1 of 6 apps deployed, `free-model-refresh`, weekly). GCP Cloud Scheduler remains at 0/3. The "2 free Vercel Hobby cron slots" mentioned above were never wired at all — no `crons` block exists in any `vercel.json` in the repo. Provisioning GCP would not currently help regardless: all 3 of its designed job targets (`/api/pipeline/signals-refresh`, `/api/briefing/run`, `/api/verdicts/score`) point at routes that don't exist in the codebase, the same failure shape as the GHA routes above.
- Three different hosts now need their own secrets/credentials kept in sync (`PORTAL_URL` + `CRON_SECRET` on GHA via `gh secret set`; the same `CRON_SECRET` used as the bearer token GCP Scheduler sends).
- Future model/pipeline changes that touch council or signals routes should also consider whether `afternoon-pipeline.yml`'s market-hours gate or `dry_run` contract needs updating.

## Validated by

- `npm run lint` clean, `npm test` — 128 passed / 4 skipped / 0 failed (neither new file is JS/TS, so this confirms no regression, not new coverage).
- YAML parse validated with `yaml.safe_load` after the indentation fix and again after the CodeRabbit-driven revision; `bash -n` on the setup script both times.
- CodeRabbit automated review (5 findings: 1 critical, 3 major, all addressed pre-merge).
- Not yet validated by an actual run — the 4 `/api/pipeline/*` routes it calls don't exist yet.

## See also

- [[concept-free-tier-resilience]] — the broader "assume the free tier degrades" posture this workflow's `dry_run`/gate/failure-issue pattern extends to the scheduler layer
- [[decision-free-tier-model-chain]] — sibling decision on the model side of the same zero-cost-infra philosophy
- [[concept-test-strategy]] — why syntax/lint validation runs pre-commit, which is how the YAML bug here was caught before merge instead of after a red CI run
