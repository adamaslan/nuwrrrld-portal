# GitHub Actions: Test Inventory and Modal/GCP Parity Plan

**Status:** Part 3 items C, D, E, F, J, K and the paper `dry_run` are built on `feat/gha-cloud-parity`. A, B, G, H and I are not (§3.5). Every Part 2 test was run on 2026-10-10; results are in Part 4.
**Grounded in:** `.github/workflows/*.yml` on `feat/midday-hydrate` (PR #248, which adds the 15:00 UTC midday hydration run), `deploy/*/modal_app.py`, gcp3 `REFRESH_CYCLE_ARCHITECTURE.md`, and the last 8 runs of each workflow (`gh run list`, 2026-10-10).
**Last updated:** 2026-10-10

Related: [`cloud-only-mode.md`](cloud-only-mode.md), [`nuwrrrld-modal-architecture.md`](nuwrrrld-modal-architecture.md), `pr-248-midday-hydrate-summary.html`, `deploy/modal-backend/SESSION-SUMMARY.md`.

---

## Part 0 — Where things stand

17 workflows. Last 8 runs each, newest first (`succ` / `fail` / `canc`):

| Workflow | Trigger | Last 8 | Read |
|---|---|---|---|
| `ci.yml` | push/PR → main | 8/8 succ | healthy |
| `e2e-resiliency.yml` | push/PR → main | 6 succ, 2 canc | healthy (cancels are `cancel-in-progress`) |
| `integration-tests.yml` | PR (path-filtered) | 8/8 succ | healthy |
| `hydrate-universe.yml` | 22:30 UTC wkdy (+15:00 in #248) | 8/8 succ | healthy, but starts **168–234 min late** |
| `engine-nightly.yml` | `workflow_run` after hydration | 8/8 succ | healthy |
| `signal-freshness-check.yml` | 13:00 UTC wkdy | 7/8 succ | healthy |
| `afternoon-pipeline.yml` | 19:15/20:15 UTC wkdy (DST pair) | 8/8 succ | healthy |
| `paper-portfolios.yml` | 4 slots × DST pair | 8/8 succ | healthy |
| `track-followed-tickers.yml` | 19:30/20:30 UTC wkdy | 6/8 succ | recovered |
| `judge-followed-tickers.yml` | Sat 16:00 UTC | 1/6 succ (latest) | recovered, watch next Saturday |
| `select-followed-tickers.yml` | 1st of month 14:00 UTC | 1/3 succ (latest) | recovered |
| `precompute-ai.yml` | 00:10 UTC daily | 5/8 succ | intermittent (quota) |
| `refresh-free-models.yml` | Mon 06:17 UTC | 2/8 succ | flaky |
| `model-usage-report.yml` | Mon 05:00 + 1st 05:10 UTC | 1/5 succ (latest) | recovered |
| `sync-corpus.yml` | Mon 05:41 UTC | 1/2 succ | new |
| **`compile-grounding-pack.yml`** | daily 06:23 UTC + push | **0/8** | **broken** |
| **`backup-to-sqlite.yml`** | daily 03:00 UTC | **last 2 fail** | **broken** |

### The two red workflows, diagnosed

1. **`compile-grounding-pack`**: `ERR_MODULE_NOT_FOUND: '@neondatabase/serverless'`. The job runs `node scripts/compile_grounding_pack.mjs` without `npm ci`. A fix exists on branch `fix/grounding-pack-deps` (commit `6414cb4`, worktree `../nuwrrrld-portal-grounding`) but it has no open PR.
2. **`backup-to-sqlite`**: `Live column(s) not present in lib/db/schema.sqlite.sql: ticker_cards.is_final`. **That column comes from PR #248, which is still open.** Its migration has already reached the live database, probably through the Vercel preview build's `prebuild → db-migrate` against the shared Neon DB (not verified). Merging #248 fixes the backup because it updates `schema.sqlite.sql`. The deeper problem is that unmerged PRs can migrate prod. See [`cloud-only-mode.md`](cloud-only-mode.md) §3, gap A.

---

## Part 1 — Test suites that GHA runs

| Suite | Command | Runs in | Scope |
|---|---|---|---|
| Lint | `npm run lint` | `ci.yml` › test | ESLint |
| Unit + components | `npm test` (vitest `unit` + `components`) | `ci.yml` › test | 80 files in `__tests__/`, ~830 cases, plus `components/**/*.test.tsx` |
| SQLite schema freshness | `npm run db:check-sqlite-schema` | `ci.yml` › db-schema-parity | `schema.sqlite.sql` is regenerated from `schema.sql` |
| DB parity contract | `npm run test:db-parity` | `ci.yml` › db-schema-parity | `__tests__/db-parity/` against SQLite (+ a Neon branch when `NEON_BRANCH_DATABASE_URL` is set, same-repo PRs only) |
| Shared-core drift | `node scripts/check-shared-drift.mjs` | `ci.yml` › shared-drift-check | web ↔ `gcp3-mobile` shared module drift |
| Integration (real Postgres) | `npm run test:integration` | `integration-tests.yml` | `signal-queue.integration.test.ts` on an ephemeral Neon branch (created, migrated, deleted per run) |
| E2E auth | `playwright --project=auth-setup` | `e2e-resiliency.yml` › auth | Clerk test-user sign-in once; storageState shared as a 1-day artifact |
| E2E preflight | `--project=preflight` | e2e › 4 shards | `billing.spec`, `credentials.spec` |
| E2E health | `--project=health` | e2e › 4 shards | `dependencies.spec` |
| E2E frontend | `--project=frontend` | e2e › 4 shards | brief + NuAI fault injection, nulogdash admin, portfolio health/liveness, signal timing, signals liveness |
| E2E CI helper | `e2e/ci/refresh-free-models.spec.ts` | not in a sharded project | chain-refresh logic |

### Suites that exist but GHA never runs

| Suite | Where | Why it matters |
|---|---|---|
| `vitest --project live` (`__tests__/live/*.live.test.ts`: council verdict, model chain, OpenRouter resilience, portfolio health, streaming) | laptop only | The only tests that touch real LLM providers. No scheduled smoke run exists. |
| **`deploy/modal-backend/tests` (16 files, 241 passing per SESSION-SUMMARY)** | laptop only, needs local Postgres via `TEST_PG_ADMIN_URL` | The whole Modal backend has **zero CI coverage**. |
| `deploy/aws-modal-news/tests/test_news_core.py` | laptop only | nwf4 scheduler logic (`due_jobs`) and scoring are untested in CI. |
| Workflow lint (actionlint / zizmor) | ad hoc | zizmor findings are cited in comments, but no job enforces them. |

---

## Part 2 — Test plan for each scheduled GHA feature

For each workflow: what it checks on its own, the safe way to exercise it, and how to verify the result. Every dispatch input below was confirmed against that workflow's `workflow_dispatch.inputs`.

Run these from the repo root:

```bash
cd ~/code/nuwrrrld-portal && gh auth status
```

### 2.1 Market data

#### `hydrate-universe.yml`: universe hydration (Alpaca → ticker cards)
- **Built-in checks:** secrets preflight, fails loudly if Alpaca keys are missing, uploads the hydrate log, opens or updates a tracking issue on failure.
- **PR #248 addition:** the 15:00 UTC run sets `--intraday`, so its cards are stored with `is_final=false`.
- **Test, smoke (posts nothing):**
  ```bash
  gh workflow run hydrate-universe.yml -f universe=stock -f limit=5 -f dryRun=true
  ```
- **Test, PR #248 midday → close flip** (writes 5 real cards; run after #248 deploys):
  ```bash
  gh workflow run hydrate-universe.yml -f universe=stock -f limit=5 -f intraday=true
  ```
  Then the normal close run:
  ```bash
  gh workflow run hydrate-universe.yml -f universe=stock -f limit=5
  ```
- **Verify** (latest run's conclusion + log):
  ```bash
  gh run list --workflow hydrate-universe.yml -L 2 && gh run view "$(gh run list --workflow hydrate-universe.yml -L1 --json databaseId -q '.[0].databaseId')" --log | grep -iE 'partial|final|posted|error' | tail -20
  ```

#### `engine-nightly.yml`: daily bars + shadow engine
- **Built-in checks:** fires via `workflow_run` after hydration, checks secrets, uploads `engine-logs`.
- **Test (no storage, no engine run):**
  ```bash
  gh workflow run engine-nightly.yml -f limit=5 -f dryRun=true
  ```
- **Caveat:** in GitHub, `workflow_run` fires on **any** completion of hydration, failures included. Once #248 merges it will fire twice a day.

#### `signal-freshness-check.yml`: staleness alarm
- **Built-in checks:** `scripts/check-card-freshness.mjs`, which opens or comments on a `stale-signals` issue when it fails.
- **Test the alert path.** A threshold of 0 fails only when the cards are at least one trading day old. On 2026-10-10 it **passed** (`latest bar_date=2026-10-10 staleTradingDays=0 threshold=0`), so it does not force a failure on a day when hydration is current. Run it the morning after a missed hydration, or treat a pass as "fresh":
  ```bash
  gh workflow run signal-freshness-check.yml -f maxStaleTradingDays=0
  ```
- **Verify:**
  ```bash
  gh issue list --label stale-signals --state open
  ```

### 2.2 Trading and council

#### `afternoon-pipeline.yml`: pre-close refresh → council → thesis scoring
- **Built-in checks:** DST-pair cron plus a single-fire gate (America/New_York 15:xx), secrets preflight, **forced-distribution verdict check**, artifact upload, failure issue.
- **Test:**
  ```bash
  gh workflow run afternoon-pipeline.yml -f skip_market_check=true -f dry_run=true
  ```

#### `paper-portfolios.yml`: council paper portfolios, 4 slots
- **Built-in checks:** gate and slot resolution from the cron that fired, waits for the deployed commit to match the run's commit, refreshes `live_prices` from Alpaca IEX, **sanity check that orders are not zero across all accounts**, failure issue.
- **Test, dry run** (resolves the slot, checks secrets and the deployed SHA; no `live_prices` write, no orders). Added in `feat/gha-cloud-parity`; before that branch merges, add `--ref feat/gha-cloud-parity`:
  ```bash
  gh workflow run paper-portfolios.yml -f slot=midday -f skip_market_check=true -f dry_run=true
  ```
- **Test, real slot** (writes paper orders for all 8 accounts; add `-f account=<account-id>` to limit it to one). Run only on a trading day:
  ```bash
  gh workflow run paper-portfolios.yml -f slot=midday
  ```

#### `track-followed-tickers.yml`, `judge-followed-tickers.yml`, `select-followed-tickers.yml`
- **Built-in checks:** thesis-flip check (track), **gold-gate check** (judge re-grades a gold set), and a first-weekday single-fire gate (select). All three have failure issues and artifacts.
- **Tests:**
  ```bash
  gh workflow run track-followed-tickers.yml -f skip_market_check=true -f dry_run=true
  ```
  ```bash
  gh workflow run judge-followed-tickers.yml -f dry_run=true
  ```
  ```bash
  gh workflow run select-followed-tickers.yml -f dry_run=true -f universe=all
  ```

### 2.3 AI and models

| Workflow | Test | Built-in check |
|---|---|---|
| `precompute-ai.yml` | `gh workflow run precompute-ai.yml -f maxSubjects=1` | failure issue names quota / `PORTAL_PUSH_SECRET` |
| `refresh-free-models.yml` | `gh workflow run refresh-free-models.yml` | script exits non-zero and keeps the chain if no model works; opens a PR only when the chain changed |
| `compile-grounding-pack.yml` | `gh workflow run compile-grounding-pack.yml` (**fails until `fix/grounding-pack-deps` lands**) | failure issue |
| `sync-corpus.yml` | `gh workflow run sync-corpus.yml` | opens a PR only when the corpus changed |
| `model-usage-report.yml` | `gh workflow run model-usage-report.yml -f period=day` | opens a PR when the report changed |

### 2.4 Data operations

#### `backup-to-sqlite.yml`
- **Test with a small table set** (fast, still exercises the schema-mirror guard):
  ```bash
  gh workflow run backup-to-sqlite.yml -f tables=ticker_cards
  ```
  Expect a **failure** with `ticker_cards.is_final` until #248 merges. After the merge, expect success.

### 2.5 One-shot verification for every workflow

```bash
for w in $(ls .github/workflows); do printf '%-32s ' "$w"; gh run list --workflow "$w" -L 5 --json conclusion -q '[.[] | (.conclusion // "running")[0:4]] | join(",")'; done
```

---

## Part 3 — Bringing GHA to parity with Modal and GCP

### 3.1 Capability gap matrix

| Capability | Modal (`modal-backend`, `nwf4`) | GCP (gcp3 Cloud Run + Scheduler) | GHA today | Gap |
|---|---|---|---|---|
| Timezone-aware schedule | `modal.Cron(..., timezone=ET)` | Cloud Scheduler `--time-zone` | UTC only; DST handled by **cron pairs plus a shell gate**, copy-pasted into 4 workflows | duplication, drift risk |
| On-time start | seconds | seconds | **168–234 min late** (22:30 hydration, Oct 3–9) | **largest gap** |
| Retries with backoff | `Retries(3, 10s, ×2, ≤60s)` on every job | Scheduler retry config | none; one failed `curl` fails the run | missing |
| Idempotency / exactly-once | `job_runs(job_name, run_key)` ledger with `force` and stale-claim takeover | `refresh_state:*` checkpoints in Firestore | `concurrency:` group only; doesn't stop a re-dispatch or a Modal twin double-writing | missing |
| Heartbeat / stuck-job detection | `heartbeat_at` + `stale_after_min` | Cloud Run timeouts | job `timeout-minutes` only; no cross-pipeline staleness alarm except card freshness | partial |
| Fan-out | `.map()` / `.spawn()` (`explain_one_signal`, `followed_grade`, `run_council_session`) | n/a | `matrix:` exists, used only for e2e shards | low priority |
| Persistent cache | Volume `nuwrrrld-market-cache`, Dict hot-cache | Firestore cache | none; every run refetches bars | wastes Alpaca budget |
| Shared vendor rate budget | DynamoDB `nwf_rate_budget` (per market-data rule) | — | Alpaca calls in hydrate/engine/paper **don't reserve tokens** | rule violation risk |
| Error reporting | Sentry (`SENTRY_DSN` in `nuwrrrld-observability`) | Cloud Logging | GitHub issues (`pipeline-failure`, `stale-signals`) | split alert channels |
| Run log | `job_runs` table | Firestore `refresh_state` | `pipeline_run_log` for portal-route pipelines only; artifacts otherwise | partial |
| Authenticated HTTP trigger | FastAPI `api()` | OIDC-signed Scheduler → Cloud Run | `workflow_dispatch` (needs a GH token) | fine |
| CI for its own code | — | — | **does not test Modal Python at all** | missing |

### 3.2 Feature ownership: who runs what

The same automations exist on several platforms. Without a single declared owner per automation, either two runs collide or no run happens.

| Automation | GHA | Modal | GCP | Proposed owner |
|---|---|---|---|---|
| EOD universe hydration | `hydrate-universe` (live) | `universe-hydration` (never deployed); `modal-backend.ingest_eod_bars` + `signals_pipeline` (never deployed) | — | GHA now; Modal once `modal-backend` ships |
| Midday hydration (#248) | 15:00 UTC (new) | — | gcp3 `midday-intraday-refresh` 12:00 ET (separate data) | GHA |
| Paper fills | `paper-portfolios` (4 slots) | `paper_fill_open` 09:40 ET, `paper_fill_close` 16:30 ET (undeployed) | — | GHA; pick one before deploying Modal |
| Followed-ticker score/freeze/grade | track/select/judge | `followed_score`/`followed_freeze`/`followed_grade` (undeployed) | — | GHA |
| Council daily/weekly | `afternoon-pipeline` | `council_daily`/`council_weekly` (undeployed) | — | GHA |
| AI precompute | **owns cron** 00:10 UTC | `precompute-ai` has no schedule on purpose | — | GHA (documented in modal_app.py) |
| Free-model chain refresh | Mon 06:17 UTC | Mon 09:00 UTC | Cloud Run Job, weekly | **all three on purpose**; idempotent PR |
| News ingest/score/aggregate (nwf4) | — | `tick` every minute (live) | — | Modal only, no GHA fallback |
| Billing reconcile, trial sweeper, referrals | — | Modal-only (undeployed) | — | Modal; **GHA needs a manual fallback** |
| Gap backfill, calendar refresh, maintenance, weekly health checks | — | Modal-only (undeployed) | — | Modal; GHA fallback |
| Market brief / AI summary / blog refresh | — | — | gcp3 Cloud Scheduler (7 jobs) | GCP |
| Neon → SQLite backup | `backup-to-sqlite` | — | — | GHA |

### 3.3 Recommendations by priority

#### P0: get back to green (no design work)

1. **Merge PR #248.** It fixes `backup-to-sqlite`. Before merging, run the midday → close flip test from §2.1.
2. **Open a PR for `fix/grounding-pack-deps`.** It fixes `compile-grounding-pack` (0/8 runs passing).
3. **Stop preview builds from migrating prod.** Gate `prebuild` on `VERCEL_ENV === 'production'`, or point preview builds at a Neon branch. Unmerged schema changes should not reach live tables. This needs a decision, so it belongs in `manual-setup-todo.md`, not here.

#### P1: largest parity wins

**A. Use an external clock for time-critical workflows.** GHA cron can start 3–4 hours late, so the 15:00 UTC midday run will land after the close on some days. Let a Modal cron (ET-aware, already deployed infrastructure) or Cloud Scheduler call `workflow_dispatch` on time, and keep GHA as the executor. Keep the `schedule:` line as a fallback; the idempotency ledger in B stops a double run.

```python
# deploy/gha-clock/modal_app.py (proposed)
@app.function(secrets=[modal.Secret.from_name("nuwrrrld-gh-dispatch")],
              schedule=modal.Cron("0 11 * * 1-5", timezone="America/New_York"))
def dispatch_midday_hydration():
    httpx.post(
        "https://api.github.com/repos/adamaslan/nuwrrrld-portal/actions/workflows/hydrate-universe.yml/dispatches",
        headers={"Authorization": f"Bearer {os.environ['GH_DISPATCH_TOKEN']}",
                 "Accept": "application/vnd.github+json"},
        json={"ref": "main", "inputs": {"intraday": "true"}},
    ).raise_for_status()
```
`GH_DISPATCH_TOKEN` is a fine-grained PAT with **Actions: write** on this repo only.

**B. Share one idempotency ledger.** Add a small portal route (or script) that claims `(job_name, run_key)` in the same `job_runs` table `modal-backend` uses, with the same semantics: skip when it already succeeded, take over a stale claim, and allow `force`. Each scheduled GHA workflow then claims first and exits 0 with "already ran" when the claim is held. That makes the three-platform pattern from free-model refresh safe for every pipeline, and lets the GHA cron and the external clock coexist.

**C. Run the Modal Python tests in CI.** 241 tests already exist. Proposed `ci.yml` job:

```yaml
  modal-python:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_HOST_AUTH_METHOD: trust }
        ports: ['54329:5432']
        options: --health-cmd pg_isready --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install pytest pytest-asyncio moto "fastapi[standard]~=0.115" "asyncpg~=0.30" "psycopg[binary]~=3.2" "pydantic-settings~=2.6" "httpx~=0.28" "PyJWT[crypto]~=2.10" "svix~=1.40" "stripe~=11.0" "pandas~=2.2" "numpy~=2.1" "pyarrow~=18.0" "exchange_calendars~=4.5" "tenacity~=9.0" "pyyaml~=6.0" "boto3~=1.35"
      - run: pytest -q
        working-directory: deploy/modal-backend
        env: { TEST_PG_ADMIN_URL: postgresql://postgres@localhost:54329/postgres }
      - run: pytest -q deploy/aws-modal-news/tests
```
The dependency list mirrors `py_image.pip_install` in `deploy/modal-backend/modal_app.py`. Extract it to a `requirements.txt` that both files read, so they cannot drift. The `pip install` runs on a CI runner, so the mamba-only rule does not apply. Once the job is stable, limit it to `deploy/**` changes with a `dorny/paths-filter` step, or by moving it into its own workflow with `on.pull_request.paths`.

**D. Add retries to every portal call.** Wrap `curl`/`node` POST steps in a retry that matches Modal's `JOB_RETRIES` (3 attempts, 10 s initial delay, ×2 backoff, 60 s max). Use a shared shell function, not a third-party action, so no new supply-chain dependency is added:
```bash
retry() { local n=0 d=10; until "$@"; do n=$((n+1)); [ $n -ge 3 ] && return 1; sleep $d; d=$(( d*2 > 60 ? 60 : d*2 )); done; }
```

#### P2: consolidation and hygiene

**E. Composite action for the market gate.** The DST cron pair plus the `America/New_York` single-fire gate is copied across `afternoon-pipeline`, `paper-portfolios`, `track-followed-tickers` and `select-followed-tickers`. Move it into `.github/actions/market-gate/action.yml`, built on `exchange_calendars`-equivalent holiday data, so holidays are handled the way Modal's `calendar_refresh` handles them. Today a weekday holiday passes the gate.

**F. Manual fallback for Modal jobs.** Add one `modal-run.yml` with `workflow_dispatch` and a `choice` input listing the Modal functions (`billing_reconcile`, `backfill_gaps`, `news_ingest`, `health_checks_weekly`, …). It runs `modal run deploy/<app>/modal_app.py::<fn>` with `MODAL_TOKEN_ID`/`MODAL_TOKEN_SECRET`. GHA then becomes the "run it now" button and backup trigger for every Modal-only job, without moving ownership.

**G. Alpaca rate budget.** Have `hydrate-local.mjs`, the engine bar fetch, and `push-alpaca-live-prices.mjs` reserve tokens from the DynamoDB `nwf_rate_budget` counter before each batch, as the market-data rule requires. GHA is currently the largest unmetered Alpaca consumer.

**H. Generalize freshness checks.** Extend `signal-freshness-check` to read the last success time per pipeline from `pipeline_run_log` and `job_runs`, and alert when any pipeline misses its expected cadence (hydration ×2 per weekday, paper ×4, engine, precompute, backup). This is the GHA equivalent of Modal's heartbeat.

**I. One alert channel.** GHA files issues and Modal reports to Sentry. Either send GHA failures to Sentry too (a `curl` to the Sentry store endpoint in each `notify` job), or have Modal open GitHub issues. Branch `feat/pipeline-alert-action` is already heading toward a shared notify action; build on it rather than starting over.

**J. Workflow lint in CI.** Add an `actionlint` + `zizmor` job to `ci.yml`. Several workflows cite zizmor findings in comments, but nothing enforces them, and `sync-corpus.yml` is the only workflow with SHA-pinned actions.

**K. Scheduled live smoke test.** A weekly `workflow_dispatch`/`schedule` job running `npx vitest run --project live -t 'model-chain'`, limited to the cheap free-chain cases. Today the only provider-touching tests never run unattended.

### 3.4 Parity scorecard (target)

| Capability | Now | After P1 | After P2 |
|---|---|---|---|
| On-time start | ✗ (3–4 h drift) | ✓ (external clock) | ✓ |
| Retries | ✗ | ✓ | ✓ |
| Idempotency shared with Modal | ✗ | ✓ | ✓ |
| Modal code tested in CI | ✗ | ✓ | ✓ |
| Holiday-aware gate | ✗ | ✗ | ✓ |
| Trigger any Modal job from GHA | ✗ | ✗ | ✓ |
| Metered Alpaca budget | ✗ | ✗ | ✓ |
| Cross-pipeline staleness alarm | partial (cards only) | partial | ✓ |
| Unified alerting | ✗ | ✗ | ✓ |

### 3.5 Implementation status (2026-10-10, `feat/gha-cloud-parity`)

| Item | Status | Where | Verified by |
|---|---|---|---|
| P0.1 merge #248 | open, not merged here | PR #248 | backup run still fails on `ticker_cards.is_final` (Part 4) |
| P0.2 grounding deps | **PR #253 opened** | `compile-grounding-pack.yml` | dispatched on the branch (Part 4) |
| P0.3 previews migrating prod | not done; needs a decision | — | — |
| **A** external clock | not built | — | needs a fine-grained PAT (dashboard-only) and a Modal deploy; see the TODO below |
| **B** shared idempotency ledger | not built | — | needs a new portal route writing `job_runs`, which only exists in modal-backend's schema; design first |
| **C** Modal Python in CI | **built** | `ci.yml` › `modal-python`, `deploy/modal-backend/requirements*.txt`, `tests/test_requirements_sync.py` | locally: 241 + 1 and 85 passed against Postgres on :54329; then on the PR |
| **D** retries | **built** | `.github/scripts/portal-post.sh`, used by all 8 portal POSTs | local flaky server: connect error and 503 retried, 500 not retried, gives up after 3 |
| **E** holiday-aware gate | **built** | `.github/actions/market-gate` in afternoon / track / paper gates | Alpaca calendar: 10-10 (Sat) and 11-26 (Thanksgiving) closed, 11-27 closes 13:00 |
| **F** Modal fallback | **built, not runnable from GHA yet** | `modal-run.yml` | the same `modal run modal_app.py::smoke` ran locally against Modal `main`; GHA needs `MODAL_TOKEN_*` |
| **G** Alpaca rate budget | not built | — | touches three market-data scripts plus DynamoDB; its own PR |
| **H** cross-pipeline staleness | not built | — | depends on B's ledger for Modal jobs |
| **I** one alert channel | not built | — | `feat/pipeline-alert-action` owns this |
| **J** workflow lint | **built** | `ci.yml` › `workflow-lint`, `.github/zizmor.yml` | actionlint clean; zizmor high: 0 after fixing 4 template injections and 1 permissions finding |
| **K** live smoke | **built** | `live-smoke.yml` (weekly + PR paths) | locally 11/11 against OpenRouter; then on the PR |
| paper `dry_run` | **built** | `paper-portfolios.yml` | dispatched on the branch (Part 4) |

Design choices that differ from the proposal above:

- **D retries only requests that cannot have run.** These routes write state (paper orders, council runs), so a timeout, 500 or 504 is not retried: the route may still be running or may already have finished. Only connect errors and 429/502/503 are retried.
- **C keeps `modal_app.py` unchanged.** Modal also evaluates image definitions inside the container, where `requirements.txt` isn't present, so the image keeps its inline list. A test asserts that the two lists match.
- **E fails open.** If Alpaca's calendar can't be read, the gate warns and lets the weekday gate decide. A vendor outage should not cancel a trading slot.
- **J gates on high severity only.** The 62 tag-pinned `uses:` are accepted as an explicit policy, and pinning by SHA is a follow-up.

#### Still manual

🖱 **Dashboard:** create a dedicated Modal token for GitHub Actions (not your personal `~/.modal.toml` token): https://modal.com/settings/tokens. Then push it without it touching the terminal history:

```bash
cd ~/code/nuwrrrld-portal && read -rs MID && printf %s "$MID" | gh secret set MODAL_TOKEN_ID && read -rs MSEC && printf %s "$MSEC" | gh secret set MODAL_TOKEN_SECRET && unset MID MSEC
```

Verify:

```bash
gh secret list | grep -c MODAL_TOKEN
```

Expect `2`. Then:

```bash
gh workflow run modal-run.yml -f job=aws-modal-news::smoke
```

---

## Part 4 — Run log, 2026-10-10 (Saturday, market closed)

Every Part 2 test was dispatched against `main`, plus the branch-only runs. Gated workflows ran with `skip_market_check=true`.

| Workflow | Inputs | Result | Read |
|---|---|---|---|
| hydrate-universe | `stock`, `limit=5`, `dryRun` | ✅ | healthy |
| engine-nightly | `limit=5`, `dryRun` | ✅ | healthy |
| signal-freshness-check | `maxStaleTradingDays=0` | ✅ (expected ❌) | test as written doesn't force a failure; corrected in §2.1. The latest `bar_date` is **2026-10-10, a Saturday**, which is worth a look |
| afternoon-pipeline | `dry_run` | ❌ **HTTP 404** on `/api/pipeline/signals-refresh` | **the routes were never built.** Scheduled runs only looked green because the late GHA start meant the gate skipped them |
| track-followed-tickers | `dry_run` | ✅ | healthy |
| judge-followed-tickers | `dry_run` | ✅ | healthy |
| select-followed-tickers | `dry_run`, `universe=all` | ✅ | healthy |
| precompute-ai | `maxSubjects=1` | ❌ **HTTP 502**, `reason: "db write failed"` | **not quota.** The model answered; the selected subject was the whole ~800-ticker watchlist joined into one string. Open |
| refresh-free-models | — | ✅ | healthy |
| sync-corpus | — | ✅ | healthy |
| model-usage-report | `period=day` | ✅ | healthy |
| backup-to-sqlite | `tables=ticker_cards` | ❌ `ticker_cards.is_final` not mirrored | expected until #248 merges |
| compile-grounding-pack (main) | — | ❌ `ERR_MODULE_NOT_FOUND` | expected; fixed by PR #253 |
| compile-grounding-pack (`fix/grounding-pack-deps`) | — | see PR #253 | |
| paper-portfolios (`feat/gha-cloud-parity`) | `midday`, `skip_market_check`, `dry_run` | ✅ | calendar said "not a session", the override applied, the slot resolved and was flagged late, the deploy SHA was compared, and the run stopped at `would POST …?slot=midday&late=true` |
| ci / e2e / integration | run on the PR | see the PR checks | |
| live-smoke (`feat/gha-cloud-parity`) | PR trigger | see the PR checks | 11/11 locally |
| modal-run | — | not runnable | no `MODAL_TOKEN_*` secrets (§3.5). The identical `modal run modal_app.py::smoke` succeeded locally against Modal `main` |

Not run on purpose:
- **Intraday hydrate flip (§2.1):** it writes real cards, and the doc gates it on #248 being deployed.
- **A real paper slot:** a weekend fill would put a stale-mark midday trade into all 8 books. The new dry run covers the workflow path instead.
