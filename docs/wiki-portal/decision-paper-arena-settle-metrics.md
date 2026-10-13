---
date: 2026-10-13
type: decision
tags: [paper-trading, arena, performance, resilience]
sources: [../../lib/paper-arena.ts, ../../lib/paper-db.ts, ../../lib/paper-metrics.ts, ../../__tests__/paper-arena-load.test.ts]
---

# Decision: Reuse settle metrics in the paper arena

## Decision

The arena reads the latest settle run for each account and uses its metrics when the stored shape is valid. It batches NAV, order, position, and settle reads across accounts. Missing or malformed metrics trigger batched fallback reads and account-specific recomputation. One account's computation failure leaves that score empty without hiding the other accounts.

## Date

2026-10-13

## Context

The arena previously recomputed metrics for every account through repeated database reads. With eight accounts, the modeled normal path made 79 queries. FE15 reduces that model to six queries with stored metrics and nine when fallback data is needed. These are query counts from code and focused tests, not a production latency measurement.

## Alternatives considered

- Recompute every account on every load: keeps metrics freshest but repeats expensive reads already performed at settle.
- Trust stored JSON without validation: fewer reads but malformed run details could produce misleading scores or fail the page.

## Consequences

- Arena score metrics can reflect the last settle rather than the latest NAV. Current NAV is still loaded separately for current values.
- Accounts without usable stored metrics still produce scores when the fallback succeeds.
- A single fallback computation error affects that account's score only. A failed shared batch read can still fail the request.
- The new SQL has focused test coverage but has not been exercised against production Neon.

## Validated by

`__tests__/paper-arena-load.test.ts` covers batched reads, stored metric validation, fallback, and per-account error isolation. Focused tests and lint passed in the FE15 worktree.

## See also

- [[entity-paper-portfolios]] — arena behavior and known limits
- [[concept-graceful-degradation]] — account-level failure isolation
