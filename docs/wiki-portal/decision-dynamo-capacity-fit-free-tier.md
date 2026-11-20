---
date: 2026-11-19
type: decision
tags: [aws, dynamodb, free-tier, capacity, provisioning, modal-backend]
sources: [../../deploy/modal-backend/nuwrrrld/dynamo.py, ../../deploy/modal-backend/modal_app.py, ../../deploy/modal-backend/tests/test_dynamo.py, homebase PR#133]
---

# Decision — Fit the Planned nwf_* Tables Into the Always-Free Pool

## Decision

Size the four DynamoDB tables this backend owns to use the spare units of the always-free pool, 25 RCU / 25 WCU in total, with no headroom:

| Table | RCU/WCU before | RCU/WCU after |
|---|---|---|
| `nwf_pipeline_data` | 10 / 12 | **4 / 4** |
| `nwf_live_prices` | 6 / 5 | 6 / 5 |
| `nwf_market_cache` | 4 / 3 | **2 / 2** |
| `nwf_locks` | 2 / 1 | **1 / 1** |

The six `nwf_*` tables already provisioned in the account total 18 / 18. The four tables above add 7 / 7 once resized, which gives 25 / 25. `CAPACITY` in `nuwrrrld/dynamo.py` is the single source of these numbers; `provision_dynamo` and the module header describe the same budget.

## Date

2026-11-19. Owner choice, recorded in the brief for this change.

## Context

Measured read-only on 2026-11-19: the six existing tables were provisioned at 18 / 18, and the free pool is 18,600 unit-hours per month per meter. The code as it stood on `main` sized the four tables at 10/12, 6/5, 4/3 and 2/1, which is 22 / 21 by itself. Three of those tables (`nwf_pipeline_data`, `nwf_market_cache`, `nwf_locks`) did not yet exist in AWS. Running `provision_dynamo` as written would have created them at 34 / 34, which is 9 units over the always-free ceiling of 25 / 25.

The owner's constraint is the always-free pool, not paid capacity. Keeping the sizes in code and creating the tables at those sizes was the only option that stayed inside it.

## Alternatives considered

- **Keep the sizes as coded (34 / 34).** Rejected. It is 9 units over the free ceiling and would start billing.
- **Upgrade the AWS plan.** Not taken. The Free plan closure date could not be verified (the plan-state API returned "Missing data"), and an upgrade is irreversible and owner-only.
- **Shrink `nwf_rate_budget` to free units.** Deferred. It is a separate owner decision, and that table is the shared Alpaca rate counter (see [[decision-no-shared-alpaca-budget]]), so it was not touched here.
- **Shrink the tables below the sizes chosen.** Not evaluated in this change.

## Consequences

- **No headroom.** Any new table, or any size increase, needs an equal reduction elsewhere first. Creating a table without that is a silent billing risk.
- **Write volume is still unmeasured against the write cap.** The sizes fit the budget on paper. The mirror's real write rate, and how a large backfill throttles at 4 WCU, are still open (see [[entity-modal-backend]]).
- **Tests pin the numbers.** `tests/test_dynamo.py` asserts the sum is at most 25 / 25 and checks each resized table, so a future edit that breaks the budget fails the suite.
- **Nothing was created by this change.** It is a code change only. The tables are not created or resized from a laptop or in tests; `provision_dynamo` is run only on an approved deploy.

## Validated by

- `pytest tests/test_dynamo.py` in `deploy/modal-backend` (moto, no AWS calls): 8 passed, 4 skipped. The full modal-backend suite: 117 passed, 122 skipped. The skips are existing tests that need live services.
- Read-only AWS measurement on 2026-11-19: six `nwf_*` tables, 18 / 18.

## Open questions

> ❓ Open question: the AWS DynamoDB page gives two different data-transfer allowances (1 GB and 100 GB). Not needed for this sizing, but unresolved.

> ❓ Open question: the Free plan closure date is unverified. The always-free sizing only matters if the plan stays free.

## See also

- [[entity-modal-backend]] — the backend whose DynamoDB mirror and locks these tables back
- [[decision-no-shared-alpaca-budget]] — why `nwf_rate_budget` is not part of this change
- [[concept-free-tier-resilience]] — the wider free-tier posture; this page covers the AWS side only
