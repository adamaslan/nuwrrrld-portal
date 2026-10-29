# Alpaca shared budget removed (2026-10-20)

**Written for:** the owner, and any future session that considers reinstating a shared Alpaca rate budget.

## Decision

The shared Alpaca request budget is gone. Every pipeline that used it was AWS-backed: a per-minute counter in the DynamoDB table `nwf_rate_budget`, reserved before each Alpaca call. Some reserved through the AWS CLI, some through `boto3`. The owner's direction on 2026-10-20: no AWS-based budgeting of Alpaca.

Requests are now paced locally where they were paced before. The Node hydration job counts its requests and prints `[usage] alpaca_requests=N`. Nothing waits on, or is blocked by, a shared minute bucket.

## What was removed

| Area | Before | After |
|---|---|---|
| Node hydration (`scripts/hydrate-local.mjs`) | `acquireAlpacaBudget()` before every bar and clock request, via the AWS CLI | Local counter, printed as `[usage]` |
| Node budget module (`lib/alpaca-budget.mjs`) | `aws dynamodb update-item` through `execFile` | Archived |
| Hydration workflow (`.github/workflows/hydrate-universe.yml`) | Required `aws` on the runner and `AWS_*` secrets | Requirement and secrets removed |
| Python fetcher (`scripts/pipeline/alpaca_md.py`) | `boto3` reservation on `nwf_rate_budget` before each request; falls back to local pacing if unreachable | Local pacing only (`LOCAL_MIN_INTERVAL_SECONDS = 0.35`) |
| modal-backend Dynamo layer (`deploy/modal-backend/nuwrrrld/dynamo.py`) | `take_alpaca_tokens`, `wait_for_alpaca_tokens`, `TABLE_BUDGET`, `AlpacaBudgetExhausted` | Removed; the table is no longer created or capacity-planned |
| modal-backend Alpaca provider (`providers/alpaca.py`) | `take_tokens` hook, defaulting to the DynamoDB wait | Hook removed; no call before each request |
| aws-modal-news (`news_io.py`) | `DynamoStore.take_alpaca_tokens` before each Alpaca call, including the calendar lookup | Removed. `AlpacaBudgetExhausted` now means only an Alpaca HTTP 429 |
| aws-modal-news health check (`modal_app.py`) | Checked the `nwf_rate_budget` table | Table removed from the check |
| Tests | Budget reservation tests in four files | Removed. The batching test in `u3-route-budget.test.ts` stays |
| Comments | Descriptions of the budget in `refresh-signals.py`, `locrun.py`, `deploy/new-pipeline/` | Updated |

## What was NOT touched

- **AWS resources.** The DynamoDB table `nwf_rate_budget` still exists, and so do its IAM grants. Deleting the table is a destructive action and needs your confirmation. Nothing here deletes it.
- **Other DynamoDB use.** Mirror, live prices, cache, locks and seen-state still use DynamoDB through `boto3`. Only the Alpaca budget was removed.
- **`deploy/modal-backend/SESSION-SUMMARY.md`.** Left as a dated record of how the design looked then.
- **Other worktrees' copies of `alpaca_md.py`.** The file says each repo vendors it unchanged. Other worktrees still have the old budget version until re-copied.
- **Deployed Modal apps.** Editing the code does not change what is running. The Modal apps keep the budget until they are redeployed.

## Risk

With the shared budget gone, Alpaca's roughly 200 requests per minute on the single paper key is no longer enforced across pipelines. Two things remain:

- **Hydration** is sequential, so its own rate stays modest. An Alpaca 429 now fails the run loudly.
- **Other pipelines** can still overlap in time. Nothing coordinates them any more. If their combined rate passes the limit, expect 429s, which the code already reports as errors.

## Restoring it, if you want it back

The original code is archived, unchanged, in `file-archive/alpaca-budget-2026-10-20/`. Each file keeps its repo path with a `.orig` suffix. The restore is not a copy-paste, because the original design was AWS-backed and you've ruled that out. Any restored design needs a non-AWS shared counter (for example a Neon row or a Modal-side store) and a decision on whether it should block, wait, or fail.

If you do want the original back as-is, these are the files:

```bash
cd ~/code/nuwrrrld-portal-drop-alpaca-budget
A=file-archive/alpaca-budget-2026-10-20
cp "$A/scripts/hydrate-local.mjs.orig" scripts/hydrate-local.mjs
cp "$A/.github/workflows/hydrate-universe.yml.orig" .github/workflows/hydrate-universe.yml
cp "$A/scripts/pipeline/alpaca_md.py.orig" scripts/pipeline/alpaca_md.py
cp "$A/deploy/modal-backend/nuwrrrld/dynamo.py.orig" deploy/modal-backend/nuwrrrld/dynamo.py
cp "$A/deploy/modal-backend/nuwrrrld/providers/alpaca.py.orig" deploy/modal-backend/nuwrrrld/providers/alpaca.py
cp "$A/deploy/aws-modal-news/news_io.py.orig" deploy/aws-modal-news/news_io.py
cp "$A/deploy/aws-modal-news/modal_app.py.orig" deploy/aws-modal-news/modal_app.py
cp "$A/__tests__/u3-hydration.test.ts.orig" __tests__/u3-hydration.test.ts
cp "$A/__tests__/u3-route-budget.test.ts.orig" __tests__/u3-route-budget.test.ts
cp "$A/__tests__/alpaca-budget-wait.test.ts.orig" __tests__/alpaca-budget-wait.test.ts
cp "$A/lib/alpaca-budget.mjs.orig" lib/alpaca-budget.mjs
cp "$A/deploy/modal-backend/tests/test_dynamo.py.orig" deploy/modal-backend/tests/test_dynamo.py
cp "$A/deploy/modal-backend/tests/test_providers_auth.py.orig" deploy/modal-backend/tests/test_providers_auth.py
cp "$A/tsconfig.json.orig" tsconfig.json
```

Expect: the restored files match `origin/main` at the base commit, and the AWS-backed code is back. Restoring also brings back the AWS CLI requirement and the DynamoDB table dependency, so the restore needs the AWS credentials again.

Verify after restoring:

```bash
npx vitest run __tests__/u3-hydration.test.ts __tests__/u3-route-budget.test.ts
cd deploy/modal-backend && python -m pytest -q tests/test_dynamo.py tests/test_providers_auth.py
```
Expect: both pass.

## Verification of this change

- Node: lint passes; `vitest` runs the full TypeScript suite.
- Python: `deploy/modal-backend` tests pass (117 passed, 122 skipped), and `deploy/aws-modal-news/tests/test_news_core.py` passes (85 passed). The Python tests ran in a dedicated mamba env, `nwf-budget-test`, built from `deploy/modal-backend/requirements-dev.txt`.
- Live check: one-symbol dry run of hydration before the Python changes showed `[usage] alpaca_requests=1` with no budget call.
