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
- Ranking reads do not yet filter or label on finality, so midday cards can rank. Open question: should `topCards` expose it?
- GitHub delays scheduled crons by hours, so "15:00" means around midday.
- Engine nightly follows hydration through `workflow_run`, so it also runs after the midday run.

## Validated by

Unit tests in `__tests__/card-policy.test.ts` for the replacement matrix, and the SQLite schema check. Not yet validated by a live midday run; the PR's test plan has that box open.

## See also

[[incident-2026-09-03-nightly-hydration-dead-15-days]], [[decision-afternoon-pipeline-cron-split]].
