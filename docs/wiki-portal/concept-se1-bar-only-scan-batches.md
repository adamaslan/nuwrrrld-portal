---
date: 2026-11-20
type: concept
tags: [se1, scans, bar-only, pure-logic, s26, cl24]
sources: [../../lib/shared/se1/bar-only-batch-01.ts, ../../lib/shared/se1/bar-only-batch-06.ts, PR#413]
---

# Concept — se1 bar-only scan batches (S26, 36 scans)

## The pattern

The S26 scan catalog is split into batches that each read only OHLCV bars. Six batch modules under `lib/shared/se1/` carry 36 scans in total, six per module. Each module is pure TypeScript with no network, provider, database, or result-store dependency, so the logic can be tested in isolation before any results store exists. This follows [[decision-se1-pure-logic-before-results-store]]: the logic ships first, and no live results are wired yet.

The batches were written in one session on 2026-11-18 and kept on a local branch until PR #413 opened them for review on 2026-11-20. Those are the only records of the scans' history.

## Where it appears

| Module | Scan IDs |
|---|---|
| `lib/shared/se1/bar-only-batch-01.ts` | S26-001, 002, 003, 007, 015, 019 |
| `lib/shared/se1/bar-only-batch-02.ts` | S26-023, 024, 025, 026, 027, 028 |
| `lib/shared/se1/bar-only-batch-03.ts` | S26-029, 030, 031, 033, 034, 036 |
| `lib/shared/se1/bar-only-batch-04.ts` | S26-037, 038, 039, 040, 053, 054 |
| `lib/shared/se1/bar-only-batch-05.ts` | S26-055, 059, 060, 062, 063, 066 |
| `lib/shared/se1/bar-only-batch-06.ts` | S26-067, 068, 069, 070, 071, 082 |

Each module has a matching `__tests__/se1-bar-only-batch-0N.test.ts`. The test files hold 39 `it`/`test` declarations in total. That count is static; the tests were not run as part of this ingest.

These scan IDs do not overlap the S26 modules already on `main` (`bottom-scans.ts`, `trend-vol-scans.ts`, and the other se1 modules), nor the PR #409/#410 lineage.

## Contradictions / tensions

> ⚠️ Contradiction: the PR body and this page both say the batches were not run in the authoring session. Nothing in the repository records a test or build receipt for them. Unresolved until CI or a reviewer records one.

> ❓ Open question: the batches are pure bar-only logic. No real-data run against the live bar store is recorded. Whether any scan output is trusted in the product depends on that run, and it is not part of this PR.

## Verification status

- **Static test count only:** 39 declarations across six test files. Not executed in the authoring session.
- **Build:** not recorded.
- **Real-data runtime proof:** none. Pure logic only.

## Parity

The modules are portal-only. `gcp3-mobile` has no `lib/shared/se1/` directory, so no drift gate is involved. Feature-domain parity is unchanged, as with the earlier se1 logic-only PRs such as PR #375. See [[concept-mobile-web-parity]].

## See also

- [[concept-se1-evidence-surfaces]] — evidence badge, provenance, and scan pages that will consume these scans once a results store exists
- [[decision-se1-pure-logic-before-results-store]] — why the logic ships before results
- [[concept-sync-requirements]] — no mobile port is queued for these modules
