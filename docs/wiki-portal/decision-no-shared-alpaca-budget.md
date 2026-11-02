---
date: 2026-10-20
type: decision
tags: [alpaca, rate-limit, aws, dynamodb, hydration, pipelines]
sources: [../../scripts/hydrate-local.mjs, ../../scripts/pipeline/alpaca_md.py, ../../deploy/modal-backend/nuwrrrld/dynamo.py, ../alpaca-budget-removed-2026-10-20.md]
---

# Decision — No Shared AWS-Backed Alpaca Rate Budget

## Decision

No pipeline reserves Alpaca requests from a shared AWS-backed counter. Each pipeline
paces itself or simply counts its own requests. Hydration logs the count as
`[usage] alpaca_requests=N`. An Alpaca 429 fails the run loudly instead of waiting
for the next minute bucket.

## Date

2026-10-20

## Context

All pipelines share one Alpaca paper key with a limit of roughly 200 requests a
minute. A per-minute counter in the DynamoDB table `nwf_rate_budget` kept them under
it, reserved through the AWS CLI in the Node hydration job and through `boto3` in the
Python fetcher and both Modal apps. On 2026-10-20 the hydration job failed twice
because the CLI reservation errored for every ticker: nothing was written for six
days. The error text was discarded, so the cause was never confirmed.

## Alternatives considered

- **Fix the CLI reservation.** Keeps one limit across pipelines, but keeps a hard
  dependency on AWS credentials for a data job, and the failure mode (write nothing)
  is worse than hitting a rate limit.
- **Swap the CLI for the AWS SDK.** Same dependency, plus a new package.
- **A non-AWS shared counter** (a database row, say). Not built; it is the likely
  shape of any future return.

## Consequences

- Hydration no longer needs the AWS CLI or `AWS_*` secrets.
- Nothing caps the combined request rate across pipelines. Overlapping runs can hit
  429s; hydration is sequential, so its own rate stays modest.
- The DynamoDB table and its IAM grants still exist and are unused by these paths.
- The global market-data rule still requires a shared budget, which now contradicts
  the code until the rule is updated.
- Other repos that vendor `alpaca_md.py` keep the budget until re-copied.

## Validated by

Unit tests for hydration and the Python fetcher pass, and a one-symbol dry run against
Alpaca made one request with no budget call. No full scheduled run has been observed
since the change.

## See also

- [[entity-local-signal-pipeline-scripts]]
- [[entity-nwf4-news-pipeline]]
- [[entity-modal-backend]]
- [[concept-gha-cloud-parity]]
- `docs/alpaca-budget-removed-2026-10-20.md` for what was removed and how to restore it
