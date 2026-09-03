# GitHub Actions — Deployment and Local Triggering

Companion to [modal-deployment-and-local-triggering.md](modal-deployment-and-local-triggering.md).
That doc covers the Modal side of the scheduler story; this one covers everything
that runs on GitHub — the 11 workflows in `.github/workflows/`, how they get
deployed, how to fire each one by hand, how to run the equivalent work locally
without GitHub at all, and the rest of the `gh` surface (PRs, issues, secrets,
runs, artifacts, caches, API).

The thesis: **a GitHub Actions workflow has four independent trigger paths, and
you should know which one you want before you touch anything.**

| Path | What it exercises | Cost | Use when |
|---|---|---|---|
| **A. `gh workflow run`** | The real workflow, real runner, real secrets | A runner minute | Verifying the workflow itself |
| **B. `act`** | The workflow YAML, locally in Docker, with fake/local secrets | Free, slow first run | Editing steps/matrix logic |
| **C. `curl` the endpoint** | The deployed route the workflow calls — skips GitHub entirely | Free | Debugging the *route*, not the workflow |
| **D. `node scripts/…`** | The underlying script against your local checkout | Free | Debugging the *logic* |

Most "the workflow is broken" reports are actually C or D problems. Reach for the
cheapest path that can reproduce the failure, not the most realistic one.

---

## 1. Ground truth as of 2026-09-02

Repo: `adamaslan/nuwrrrld-portal`. Eleven workflows, three shapes:

### Shape 1 — CI (event-driven, no secrets of consequence)

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | `push`/`pull_request` → `main` | `npm run lint`, `npm test`; plus `shared-drift-check`, which checks out `adamaslan/gcp-expo1` alongside and runs `scripts/check-shared-drift.mjs` |
| `e2e-resiliency.yml` | `push`/`pull_request` → `main` | Clerk-authenticated Playwright suite (`auth` → `e2e` → `report`), with `concurrency` cancel-in-progress |
| `integration-tests.yml` | `pull_request` on a **path filter** (`lib/signal-queue.ts`, `lib/shared/*`, `lib/db/schema.sql`, …) + `workflow_dispatch` | `db-migrate` against an ephemeral Neon branch, then `npm run test:integration` |

### Shape 2 — Scheduled callers (cron → `curl` a deployed route)

These own no logic. They authenticate with `CRON_SECRET` and POST to a portal
route; the portal does the work. This is why path C above is usually the right
debugging tool.

| Workflow | Cron (UTC) | Endpoint it calls | Dispatch inputs |
|---|---|---|---|
| `afternoon-pipeline.yml` | `15 20 * * 1-5` + `15 19 * * 1-5` | `signals-refresh` → `theses-score` → `council-run` → `council-validate-distribution` | `skip_market_check`, `dry_run` |
| `track-followed-tickers.yml` | `30 20 * * 1-5` + `30 19 * * 1-5` | `/api/pipeline/followed-tickers` | `skip_market_check`, `dry_run` |
| `select-followed-tickers.yml` | `0 14 1 * *` | `/api/pipeline/followed-tickers-select` | `dry_run`, `universe` |
| `judge-followed-tickers.yml` | `0 16 * * 6` | `/api/pipeline/followed-tickers-judge` | `dry_run` |
| `hydrate-universe.yml` | `30 22 * * 1-5` | `/api/pipeline/hydrate-universe` | `universe` (choice), `limit`, `dryRun` |
| `precompute-ai.yml` | `10 0 * * *` | `/api/pipeline/precompute-ai` | `maxSubjects` |

**The two-cron pattern.** Four of these list *two* schedule entries — one for EST,
one for EDT — because GitHub cron is UTC-only with no timezone support. A `gate`
job then checks `TZ="America/New_York" date +%H` and no-ops the off-season entry.
Without that gate you'd get two live runs an hour apart for half the year. See
the comment block at the top of `hydrate-universe.yml` for the fuller reasoning
(it picks the time that is safe in the *worse* season, not the current one).

### Shape 3 — Scheduled committers (cron → run a script → open a PR)

| Workflow | Cron (UTC) | Script |
|---|---|---|
| `refresh-free-models.yml` | `17 6 * * 1` | `scripts/refresh-free-models.mjs` — reprobes OpenRouter's `:free` catalog, rewrites `FREE_MODEL_CHAIN` in `lib/openrouter.ts` |
| `compile-grounding-pack.yml` | `23 6 * * 1` + push on `corpus/**` | `scripts/compile_grounding_pack.mjs` |

`refresh-free-models` has a **portable twin**: `scripts/run-refresh-remote.sh`
does the same job from anywhere with bash + git + node (Cloud Run, Modal, a Zo
automation), cloning the repo and opening/force-updating a PR itself. Use it when
you want the refresh without a GitHub runner.

### The failure-notification convention

`afternoon-pipeline`, `track-followed-tickers`, `select-followed-tickers`, and
`judge-followed-tickers` each end in a `notify` job guarded by `if: failure()`
with `permissions: issues: write`, which opens a labeled `pipeline-failure`
issue containing the run URL. **A silently failing scheduled workflow should not
exist here** — if you add a new scheduled workflow, copy that job.

---

## 2. Secrets and variables

### What's referenced

Repo secrets consumed across the workflows:

```
ALPACA_API_KEY            ALPACA_API_SECRET
CLERK_SECRET_KEY          NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
CRON_SECRET               PORTAL_PUSH_SECRET        PORTAL_URL
DATABASE_URL              NEON_API_KEY              NEON_PROJECT_ID
E2E_CLERK_TEST_EMAIL      E2E_CLERK_TEST_PASSWORD
IP_HASH_SECRET            MCP_BACKEND_URL           NULOGDASH_ADMIN_EMAILS
OPENROUTER_API_KEY
STRIPE_SECRET_KEY  STRIPE_WEBHOOK_SECRET  STRIPE_PRICE_MONTHLY  STRIPE_PRICE_ANNUAL
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
```

Plus one repo **variable**: `vars.PORTAL_URL` (some workflows read the var, some
the secret — both exist; prefer the var for a non-sensitive URL).

`CRON_SECRET` and `PORTAL_PUSH_SECRET` are **distinct** and are not
interchangeable. `DATABASE_URL` is deliberately *not* pushed from `.env.local`:
CI mints an ephemeral Neon branch via `NEON_API_KEY` + `NEON_PROJECT_ID` and must
never receive the production URL.

### Pushing them — never through a chat session

```bash
./scripts/push-github-secrets.sh --dry   # show names + value lengths only
./scripts/push-github-secrets.sh         # pipe .env.local -> gh, nothing echoed
```

The script reads each value out of `.env.local` and pipes it straight into
`gh secret set`. No value is printed and none passes through an LLM context. The
same discipline applies to anything you do by hand:

```bash
# Good — value never becomes a shell word or a chat token
printf '%s' "$(openssl rand -hex 32)" | gh secret set CRON_SECRET

# Bad — value lands in shell history, process list, and your transcript
gh secret set CRON_SECRET --body "abc123..."
```

There are companion syncers for the narrower sets: `scripts/sync-e2e-secrets.sh`,
`scripts/sync-hydration-secrets.sh`, `scripts/gen-portal-push-secret.sh`,
`scripts/create-stripe-webhook.sh`. The `secrets-sync` skill covers the GitHub /
Vercel / GCP-WIF variants of this.

### Verifying without reading

```bash
gh secret list                          # names + updated-at, never values
gh variable list
```

Several workflows self-check this at runtime (`gh secret list … | grep -qx
'CRON_SECRET'`) and hard-fail with a clear message rather than sending an
unauthenticated request. Worth copying into new workflows.

### Environments

The pipeline jobs declare `environment: production`. If you add required
reviewers or a wait timer to that environment in repo settings, **every scheduled
run will block on approval** — which is a legitimate choice for a
writes-to-prod job, but make it deliberately.

---

## 3. Local setup

### `gh`

```bash
gh --version                # 2.86.0 here
gh auth status
gh auth login               # if needed; pick HTTPS + browser
gh auth refresh -s workflow # required to push .github/workflows/* changes
```

The `workflow` scope is the one people forget. Without it a push that touches
`.github/workflows/` is rejected by the server, not by git.

### `act` (optional, for path B)

Not installed in this environment. To add it:

```bash
brew install act
# Apple Silicon: the default runner image is amd64; either accept emulation
# or pin an arm64 image.
act --container-architecture linux/amd64 -l
```

`act` reads secrets from a file, never from GitHub:

```bash
# .secrets — gitignore this; never commit it
PORTAL_URL=https://financial.nuwrrrld.com
CRON_SECRET=...
```

Its limits are worth stating up front, because they decide whether path B is
useful for a given workflow:

- **`schedule:` triggers don't fire.** Use `act workflow_dispatch` or `act -j <job>`.
- **`environment:` protection rules, OIDC, and `github.token` permissions are not simulated.** Anything that calls `gh` against the real repo will need a real token passed in as a secret.
- **`actions/cache` is a no-op**, so timings mean nothing.
- Cross-repo `actions/checkout` (the `shared-drift-check` job pulling `gcp-expo1`) needs a token with access to that repo.

So `act` is good for `ci.yml` and step-logic edits, and poor for the pipeline
workflows — for those, path C is both cheaper and more faithful.

### Node

Workflows pin Node 20 (`actions/setup-node@v4`, `cache: npm`) and install with
`npm ci`. Match that locally when reproducing a CI failure — `npm install` can
resolve differently and hide a lockfile problem that CI will hit.

### The pre-commit hook

```bash
git config core.hooksPath .githooks   # `npm run prepare` does this too
brew install gitleaks                 # optional but better detection
```

`.githooks/pre-commit` blocks any staged change containing a credential. Two
layers when both are present: gitleaks for high-entropy keys, plus a
known-prefix pattern scan (`sk-`, `whsec_`, `*.run.app`) that gitleaks' entropy
filter can skip. Either layer failing blocks the commit. `--no-verify` exists and
should stay unused.

---

## 4. Local triggering — the four paths

### Path A — fire the real workflow

```bash
gh workflow list                                   # names + IDs + state
gh workflow view track-followed-tickers.yml        # recent runs + inputs
```

Dispatch, with inputs:

```bash
# Simplest — no inputs
gh workflow run refresh-free-models.yml

# With inputs (-f is a string; boolean inputs still take "true"/"false")
gh workflow run track-followed-tickers.yml \
  -f skip_market_check=true \
  -f dry_run=true

# Cheap smoke test of the hydrator — 5 symbols, writes nothing
gh workflow run hydrate-universe.yml \
  -f universe=stock -f limit=5 -f dryRun=true

# From a branch (the workflow file must exist on that ref)
gh workflow run integration-tests.yml --ref feat/moo-council-simulation

# Inputs from a JSON file / stdin
echo '{"maxSubjects":"3"}' | gh workflow run precompute-ai.yml --json
```

Then watch it:

```bash
gh run list --workflow=track-followed-tickers.yml --limit 5
gh run watch                          # interactive picker, live
gh run watch <run-id> --exit-status    # non-zero exit if the run fails
gh run view <run-id> --log-failed      # only the failing steps' logs
gh run view <run-id> --job <job-id> --log
gh run rerun <run-id> --failed         # re-run just the failed jobs
gh run cancel <run-id>
gh run download <run-id>               # artifacts (e2e report, etc.)
```

**Always prefer `--log-failed` over `--log`.** The e2e workflow's full log is
tens of thousands of lines and the failing assertion is four of them.

`dry_run: true` is honored by every pipeline workflow that has it — it runs the
whole path and skips the persist. That makes path A safe to use liberally on the
schedulers; it is *not* safe without the flag, since these write to production.

### Path B — `act`

```bash
act -l                                  # list what act thinks it can run
act pull_request -W .github/workflows/ci.yml
act -j test                             # one job
act workflow_dispatch -W .github/workflows/integration-tests.yml \
    --secret-file .secrets
act -j e2e --dryrun                     # print the plan, execute nothing
```

Use this when you're editing step logic, a matrix, or an `if:` expression and
want the feedback loop measured in seconds rather than in queued runners.

### Path C — call the endpoint directly (usually the right one)

Every scheduled caller collapses to one authenticated POST. Reproducing it takes
no GitHub involvement at all:

```bash
set -a; source .env.local; set +a       # PORTAL_URL, CRON_SECRET

curl -sS -X POST "$PORTAL_URL/api/pipeline/followed-tickers" \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H 'Content-Type: application/json' \
  --max-time 600 \
  -d '{"dry_run": true, "session": "followed-daily"}' | jq .
```

Swap the path for whichever workflow you're chasing:

| Workflow | Endpoint |
|---|---|
| `afternoon-pipeline` | `/api/pipeline/signals-refresh`, `/api/pipeline/theses-score`, `/api/pipeline/council-run`, `/api/pipeline/council-validate-distribution` |
| `track-followed-tickers` | `/api/pipeline/followed-tickers` |
| `select-followed-tickers` | `/api/pipeline/followed-tickers-select` |
| `judge-followed-tickers` | `/api/pipeline/followed-tickers-judge` |
| `hydrate-universe` | `/api/pipeline/hydrate-universe` |
| `precompute-ai` | `/api/pipeline/precompute-ai` |

Point `PORTAL_URL` at `http://localhost:3000` with `npm run dev` running to hit
your own machine instead of production. That is the fastest full-fidelity loop
for anything route-shaped.

### Path D — run the script

```bash
npm run lint
npm test                                     # ci.yml's `test` job
node scripts/check-shared-drift.mjs          # ci.yml's drift job
WEB_ROOT=. MOBILE_ROOT=../gcp3-mobile node scripts/check-shared-drift.mjs

npm run test:integration                     # integration-tests.yml
npm run db:migrate                           # its migrate step
npm run test:e2e                             # e2e-resiliency.yml
npm run test:e2e:login                       # refresh the stored Clerk session

node scripts/refresh-free-models.mjs         # refresh-free-models.yml
node scripts/compile_grounding_pack.mjs      # compile-grounding-pack.yml
node scripts/hydrate-local.mjs               # hydrate-universe.yml, local variant
```

And the portable remote wrapper, runnable anywhere:

```bash
OPENROUTER_API_KEY=... GH_TOKEN=... bash scripts/run-refresh-remote.sh
OPEN_PR=0 ... bash scripts/run-refresh-remote.sh   # push straight to main
```

---

## 5. Deployment — how a workflow becomes live

There is no deploy step. A workflow is live when its file is on the **default
branch**. The consequences are specific and cause most "why didn't it run"
confusion:

1. **`schedule:` only fires from the default branch.** A cron added on a feature
   branch will never fire, no matter how long the PR sits open.
2. **`workflow_dispatch` only appears in the UI once the file is on the default
   branch.** After that, `--ref` can run it from any branch. So: merge first,
   then dispatch against your branch to test changes.
3. **A `pull_request`-triggered workflow runs from the PR's own version of the
   file**, which is what makes `ci.yml` and `e2e-resiliency.yml` self-testing —
   an edit to those is validated by the very PR that makes it.
4. **Editing `.github/workflows/*` requires the `workflow` OAuth scope** on your
   push credential (`gh auth refresh -s workflow`).
5. **Scheduled workflows are auto-disabled after 60 days of repo inactivity**,
   and GitHub emails about it. `gh workflow enable <file>` turns one back on.
6. **Cron is best-effort.** Fires can be delayed by minutes under load,
   especially on the hour. Nothing here should be clock-critical to the minute —
   the market-hours gates are written to tolerate it.

Enable/disable without deleting:

```bash
gh workflow disable precompute-ai.yml
gh workflow enable  precompute-ai.yml
```

### Validating before you push

```bash
brew install actionlint
actionlint                            # all workflows
actionlint .github/workflows/ci.yml
```

`actionlint` catches the class of error that otherwise costs a full push/run
cycle: bad `${{ }}` expressions, unknown contexts, shellcheck findings inside
`run:` blocks, and invalid `choice` option lists. (The `hydrate-universe` comment
about actionlint rejecting `''` in a choice list is a scar from exactly this.)

### The out-of-band schedulers

`.github/scripts/setup-schedulers.sh` provisions **GCP Cloud Scheduler** jobs
hitting the same portal endpoints, plus the GitHub secrets, in one run:

```bash
gcloud auth login && gcloud config set project <PROJECT_ID>
gh auth login
CRON_SECRET=<value> bash .github/scripts/setup-schedulers.sh
```

It upserts (describe → update, else create), so it is safe to re-run. Note this
means some endpoints can be driven by **both** GHA cron and Cloud Scheduler —
check both before concluding a run was a duplicate or a phantom.

---

## 6. The rest of the GitHub surface

### Pull requests

```bash
gh pr create --fill                       # title/body from commits
gh pr create --base main --head <branch> --title "…" --body "…"
gh pr list --json number,title,headRefName,mergeable
gh pr view <n> --json state,mergeable,statusCheckRollup
gh pr diff <n> --name-only                # the shared-file overlap check
gh pr checks <n> --watch
gh pr merge <n> --squash --delete-branch
gh pr ready <n>                           # draft -> ready
```

Two project rules attach here. Wiki ingest on PR creation (see
`~/.claude/CLAUDE.md` and `docs/wiki-portal/SCHEMA.md`), and CodeRabbit pacing —
every push is a review trigger, so batch commits and don't stack an
`@coderabbitai review` on an in-flight one.

### Issues, labels, releases

```bash
gh issue list --label pipeline-failure --state open
gh issue create --title "…" --body "…" --label pipeline-failure
gh issue close <n> --comment "resolved by #<pr>"
gh label list
gh release create v0.2.0 --generate-notes
```

The `pipeline-failure` label is the failure channel for every scheduled
workflow. Checking it is the cheapest daily health read:

```bash
gh issue list --label pipeline-failure --state open --limit 20
```

### Caches and artifacts

```bash
gh cache list
gh cache delete --all                     # when npm cache poisoning is suspected
gh run download <run-id> -n playwright-report
gh api repos/:owner/:repo/actions/artifacts --jq '.artifacts[] | "\(.name) \(.size_in_bytes)"'
```

### Raw API, for anything `gh` doesn't wrap

```bash
gh api repos/:owner/:repo/actions/workflows --jq '.workflows[] | "\(.state)\t\(.name)"'
gh api repos/:owner/:repo/actions/runs --jq \
  '.workflow_runs[] | select(.conclusion=="failure") | "\(.name) \(.created_at) \(.html_url)"' | head
gh api -X POST repos/:owner/:repo/actions/workflows/ci.yml/dispatches -f ref=main
gh api repos/:owner/:repo/actions/permissions
```

### Repository-level settings worth knowing

```bash
gh api repos/:owner/:repo/actions/permissions/workflow   # default GITHUB_TOKEN perms
gh api repos/:owner/:repo/branches/main/protection       # required checks
```

Workflows here declare least-privilege `permissions:` per job (`contents: read`
by default, `issues: write` only on the `notify` jobs). Keep that pattern —
a job that only calls an endpoint should not carry write access to the repo.

---

## 7. Debugging playbook

| Symptom | First check |
|---|---|
| Scheduled run never happened | Is the file on `main`? Is the workflow disabled (`gh workflow list` shows state)? 60-day inactivity auto-disable? |
| Ran but did nothing | The `gate` job — off-season cron entry no-ops by design. Look for "off-season cron entry, skipping" |
| Two runs an hour apart | Both EST and EDT cron entries fired and the gate is missing or wrong |
| `HTTP 401` from the endpoint | `CRON_SECRET` mismatch between repo secret and deployed env — confirm both by *name* and rotate, don't print |
| `HTTP 404` from the endpoint | Route not built/deployed yet; several of these are written to fail loudly for exactly that reason |
| Push rejected on a workflow edit | Missing `workflow` OAuth scope → `gh auth refresh -s workflow` |
| Green in `act`, red in CI | `act` doesn't simulate environments, OIDC, cache, or token permissions. Trust CI |
| `npm ci` fails in CI, `npm install` fine locally | Lockfile drift. Reproduce with `npm ci` on Node 20 |
| e2e fails only in CI | Stored Clerk session; check the `auth` job before reading the `e2e` job's logs |
| Integration tests can't reach the DB | The ephemeral Neon branch step — check `NEON_API_KEY` / `NEON_PROJECT_ID`, not `DATABASE_URL` |

Fast triage sequence:

```bash
gh run list --limit 15 --json name,conclusion,createdAt,url \
  --jq '.[] | select(.conclusion=="failure") | "\(.name)  \(.createdAt)  \(.url)"'
gh run view <run-id> --log-failed
gh run rerun <run-id> --failed
```

---

## 8. Adding a new scheduled workflow — the checklist

1. Cron in **UTC**. If the local hour matters, add both EST and EDT entries *and*
   a `gate` job keyed on `TZ="America/New_York" date +%H`.
2. `concurrency:` — `cancel-in-progress: true` for CI, `false` for anything that
   writes (finish the run in flight, queue the next).
3. `workflow_dispatch:` with a `dry_run` boolean, always. It is what makes path A
   safe.
4. Least-privilege `permissions:` per job.
5. A secret-existence preflight step that fails with a readable message.
6. A `notify` job with `if: failure()` that opens a `pipeline-failure` issue
   carrying the run URL.
7. `actionlint` clean before pushing.
8. Merge to `main`, then `gh workflow run … -f dry_run=true` to prove it.

---

## See also

- [modal-deployment-and-local-triggering.md](modal-deployment-and-local-triggering.md) — the Modal half
- [gha-modal-core-feature-coverage.md](gha-modal-core-feature-coverage.md) — what *should* move to which scheduler, and why
- [how-to-run-scripts.md](how-to-run-scripts.md) — running the underlying scripts
- [manual-setup-todo.md](manual-setup-todo.md) — secrets and GCP WIF still unprovisioned
- [local-fullstack-testing-guide.md](local-fullstack-testing-guide.md) — path C/D environment setup
