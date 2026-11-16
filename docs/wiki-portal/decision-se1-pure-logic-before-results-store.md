---
date: 2026-11-08
type: decision
tags: [se1, planning, scope, shared-logic]
sources: [lib/shared/ai-features.ts, lib/shared/se1-dossier.ts, docs/nwf-ai-native-10x-plan-2026-10-31.md (homebase)]
---

# Decision: build pure logic and catalog pages before the se1 results store

## Decision

Ship the Wave 0 and logic-only features now as pure functions and static pages over scan-card data. Do not wire any of them to live scan results until the results store exists.

## Date

2026-11-08

## Context

The 10x plan (homebase, `docs/nwf-ai-native-10x-plan-2026-10-31.md`) gates Wave 1 on the se1 results store (decision D1) and on gates X1, X2, and X4. Wave 0 needs only the scan-card contract, not results. The se1 plan has 4 cards written so far, so there is nothing real to show a user yet.

## Alternatives considered

- **Wait for the results store.** Nothing ships until D1 is decided and built. Rejected: the contract, the gap list, and the provenance rules are useful on their own, and the gap list is itself a honest status surface.
- **Stub results so the UI looks live.** Rejected: that would show a level or a flag with no evidence behind it, which breaks the evidence-honesty rule (G6).
- **Ship the pure functions and static pages now (chosen).** Each function takes rows as input, so the same code runs unchanged once rows exist.

## Consequences

- The `/scans` pages and the gap list are the only user-visible surfaces. They say plainly that every card is a spec.
- Tests cover the logic with synthetic rows only. Real-data behavior is unverified until the store exists.
- Any future feature that consumes rows must go through the provenance footer and evidence badge, not bypass them.

## Validated by

- Unit tests: `__tests__/se1-catalog.test.ts`, `__tests__/se1-dossier.test.ts`, `__tests__/llms-txt.test.ts` (1233 unit tests passing on the branch, 9 skipped).
- Mutation check: 10 deliberate breaks across the new logic, 10 caught after adding one boundary test. The one equivalent mutant (a redundant flat-series guard) is noted in the PR.
- Not validated: any run against real scan output, and any build or browser check of the new pages.

## See also

- [[concept-se1-evidence-surfaces]]
- [[index]]
