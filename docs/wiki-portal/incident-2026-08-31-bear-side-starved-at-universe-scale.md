---
date: 2026-08-31
type: incident
tags: [signals, ranking, followed-tickers, benchmark, universe, silent-failure]
sources: [../../lib/ticker-cards-db.ts, ../../app/api/pipeline/followed-tickers-select/route.ts, ../../lib/shared/followed-tickers-policy.ts, ../../__tests__/followed-tickers-policy.test.ts, ./concept-followed-tickers-tracking.md, ./concept-three-state-signal.md]
---

# Incident: the benchmark cohort's bear side starved as the universe grew

Monthly cohort selection fetched its candidates with
`topCards(horizon, 200, scope)`, which orders by **signed** `score DESC`. The
first 200 rows of a signed ordering are the 200 most *bullish* cards — the
bears are at the opposite end of the table, past the cut.

At ~518 tickers, 200 rows still reached into negative scores, so both sides
filled and the cohort looked correct. At the target ~950-ticker universe the
head of the ordering is effectively all bulls, so `selectCohort` filled its
bear side from whatever weak negatives happened to survive, or returned fewer
than 10 bears.

## What happened

The bug shipped dormant and became live as the universe grew toward 950
tickers. It was found by reading the selection route while assessing whether
the followed-tickers harness would hold at that scale — not by any failure
signal, because there was none to notice.

## Root cause

A top-N over a **signed** ordering is a one-directional read, and the caller
treated it as if it contained both directions.

## Why it was hard to see

Nothing failed. There was no exception, no empty result, no coverage warning —
the route returned HTTP 200 with a `bears: []` array beside a full `bulls`
array, and the monthly workflow spliced that into `docs/tickers-followed.md` as
a completed cohort refresh.

This is the same shape as [[concept-three-state-signal]]'s central distinction:
an *absent* measurement and a *measured* negative are different facts. A cohort
with no bears because the market had no bears is a real observation; a cohort
with no bears because they were never fetched is a broken query wearing that
observation's clothes. Nothing in the response distinguished the two.

The severity is that the artifact is a **published track record**. A benchmark
missing half its thesis does not merely under-report — it silently selects for
one direction, and every hit-rate computed from it inherits that bias while
presenting as a neutral scorecard.

## Resolution

`bipolarCards()` takes N from each tail explicitly (a `bulls`/`bears` CTE union),
and selection uses it with 1000 per side — deliberately larger than the current
universe, so the query is a full eligible-set scan rather than a cut.

`topCards` keeps `score DESC` unchanged. `/api/signals/top` and `precompute-ai`
both want a most-bullish feed, and that ordering is correct for them; the bug
was the *caller's* assumption that a top-N of a signed ordering contains both
directions, not the ordering itself.

## Impact on design

A regression test asserts the failure mode rather than only the fix: given a
synthetic 950-ticker universe, a signed-DESC cut yields **10 bulls and 0 bears**,
while both tails yield 10 and 10. Written that way so the route's use of
`bipolarCards` reads as load-bearing, and a future refactor back to `topCards`
fails loudly instead of re-introducing a silent starve.

## Open items

- The 950-ticker universe is registered but the first bipolar selection run has
  not yet executed — the fix is verified by unit test and by reading the query,
  not yet by a live monthly cohort. Confirm on the next selection that both
  sides come back full.
- No alert exists for a short cohort. A selection returning fewer than
  `COHORT_SIDE_SIZE` on either side is still an HTTP 200; it should be loud.

## Generalization

**A top-N over a signed ordering is a one-directional read.** Any caller that
needs both extremes of a distribution must say so at the query, because the
shortfall surfaces as a smaller-than-expected result set — which is
indistinguishable from a genuinely quiet market, and therefore invisible. The
cost of that ambiguity scales with the universe: the bug is dormant precisely
while the dataset is small enough to test casually.
