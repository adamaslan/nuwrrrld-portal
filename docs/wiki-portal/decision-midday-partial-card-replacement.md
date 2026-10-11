---
date: 2026-10-09
type: decision
tags: [hydration, ticker-cards, cron, data-quality]
sources: [../../.github/workflows/hydrate-universe.yml, ../../lib/shared/card-policy.ts, ../../lib/ticker-cards-db.ts, PR#248]
---

# Decision: A Midday Hydration Run Writes Partial Cards That the Close Replaces

## Decision

Universe hydration runs twice on weekdays: the existing 22:30 UTC settled-close run and a new 15:00 UTC midday run. Midday cards are stored with `is_final = false`. For the same bar date, a final card replaces a partial one at any quality, a partial never replaces a final, and two partials resolve to the later run at equal or better quality. A newer bar date still always wins.

## Date

2026-10-09, PR #248.

## Context


The card replacement rule only accepted a same-bar card on strictly better quality. The hydrate script stamps every card with the run's date, so a midday run would have written today's partial daily bar, and the close run (same date, equal quality) would have been refused. The universe would have kept the partial bar until the next trading day while every run reported green.

## Alternatives considered

- **Add the cron and change nothing else.** Rejected: the close run would be refused, leaving partial-bar cards for a day.
- **A separate intraday lane or table.** Rejected for now: more surface area, and rankings would need to merge two sources.

## Consequences

- The rule lives in two places that must agree: `shouldReplaceCard` and the upsert guard in `ticker-cards-db.ts`.
- Only the 15:00 cron or the manual `intraday` input marks a run partial; every other caller defaults to final.
- ~~Ranking reads do not yet filter or label on finality, so midday cards can rank.~~ **Resolved in the same PR's review cycle (2026-10-10):** `rowToStored` was silently dropping `is_final` on every read, and both ranking queries — `topCards` and `bipolarCards` — selected partial cards with no way for a caller to exclude them. Both queries now require `c.is_final = true`; `rowToStored` preserves the field. CodeRabbit caught the `topCards` gap first; a second review pass on the fix caught the identical gap in `bipolarCards` (see [[incident-2026-08-31-bear-side-starved-at-universe-scale]] — same function, a different correctness axis).
- A second same-PR fix: the equal-quality partial-vs-partial tie-break (`shouldReplaceCard`, and the SQL `WHERE` guard) compared `computed_at` — the portal's write-time clock — so a batch generated earlier but POSTed late could overwrite a fresher batch purely on arrival order. Added `observed_at`, an immutable timestamp the producer captures once per run *before* computing anything (see `scripts/hydrate-local.mjs`'s `main()`), and used it to break the tie by generation order. Falls back to the original quality-only tie-break when either side lacks it, so non-updated producers are unaffected.
- A related correctness bug surfaced in the same pass: the `observed_at` tie-break initially compared ISO timestamp strings directly, which can disagree with chronological order across differing UTC offsets. Fixed to parse both sides via `Date.parse` and compare as instants.
- GitHub delays scheduled crons by hours, so "15:00" means around midday.
- Engine nightly follows hydration through `workflow_run`, so it also runs after the midday run.

## Validated by

Unit tests in `__tests__/card-policy.test.ts` for the replacement matrix (extended with 5 new cases covering the `observed_at` tie-break, including a UTC-offset regression test), and the SQLite schema check. Not yet validated by a live midday run; the PR's test plan has that box open.

## See also

[[incident-2026-09-03-nightly-hydration-dead-15-days]], [[decision-afternoon-pipeline-cron-split]].
