---
date: 2026-09-26
type: entity
tags: [engine, signals, fibonacci, shadow-mode, bars, labels, paper-trading, parity]
sources: [../../lib/engine, ../../lib/shared/engine-bars.ts, ../../lib/shared/engine-ladder.ts, ../../lib/shared/paper-engine-events.ts, ../../lib/engine-db.ts, ../../app/api/pipeline/engine-run/route.ts, ../../app/api/pipeline/engine-label/route.ts, ../../app/api/pipeline/daily-bars/route.ts, ../../app/api/engine/[ticker]/route.ts, ../../.github/workflows/engine-nightly.yml, ../../scripts/engine/gen_fib_golden.py, ../../__tests__/fixtures/fib-golden.json, PR#189]
---

# Entity — Signal Engine (canonical Fibonacci, shadow mode)

**Update (PR #196, 2026-09-28):** `lib/engine/indicators/ma.ts` and
`indicators/ichimoku.ts` add a 50/200 SMA cross detector (`ma-cross`) and a
Tenkan/Kijun cross detector (`ichimoku`), per
`homebase/harness/FIB-ICHIMOKU-MA.md` §8 row 4. Both ship as `-experimental`
in `SNAPSHOT_DETECTORS` (row 5) and bump `ENGINE_CODE_VERSION` to
`nu-engine@0.2.0`. They fix the D1–D6 defects the doc documents against
signals-app's *current* production trend detectors from the start rather
than porting the bug then fixing it: one emission per cross via a shared
sign-flip rule (D1/D4), states (cloud position/colour) never emit as a vote
(D2/T5), Ichimoku's leading lines are unshifted and `Chikou_Diff` is a
causal `Close[i] − Close[i-26]` rather than the traditional negative-shift
lagging span (D5/T1), and both crosses grade `BULLISH`/`BEARISH` rather than
`STRONG` (D3). **Not done in this PR:** the golden-fixture cross-language
parity gate (T6, row 4's own "Done when") — that requires generating a
fixture from signals-app's *own* fixed detectors (row 1, a separate PR in
that repo) and diffing it against this TS port bar-by-bar. Unit tests here
pin causality (T1), no-partial-window (T2), single-emission/no-tie-refire
(T3/T4) and states-never-vote (T5) with hand-built series, the same style
`entity-signal-engine`'s own fib tests use — but they are not a substitute
for T6. Treat the MA/Ichimoku detectors as shadow-only until that fixture
exists and the row 5 10-day hit-match gate has actually run.

## What it is

A pure-TypeScript port of the canonical Fibonacci signal logic that lives in the
signals-app research lab, plus the storage and jobs that let the portal run it
nightly on its own bars. It answers "where is price relative to the last real
swing, and did anything *happen* there" — and it does so from one implementation
that the batch job, the ladder route, and (later) any agent tool all share.

**Core (`lib/engine/`)** is deliberately I/O-free. A columnar OHLCV frame, Wilder
ATR and a 20-bar volume mean, confirmed pivots, legs of at least three ATRs,
direction-aware retracements and extensions, confluence zones, and a detector
that fires on **events, not proximity** (a hold of the golden pocket on
above-average volume is the default signal; a breach is not a hold). The
confluence hold, the 0.786 break and the 1.618 target sit behind an
`experimental` flag. A runner isolates detectors so one failing detector becomes
a warning, and the run reports `degraded` after repeated failures. A layering
test forbids anything under `lib/engine/` from fetching, importing Next, a DB
driver or Firebase, or reading the environment — that purity is what makes the
same code reusable across the route, the batch and a future tool server.

**Parity is enforced, not hoped for.** A Python script runs the canonical lab
code bar by bar over eight series and writes a golden fixture; the TS port must
reproduce every bar's signals exactly and the indicator values to a tight
tolerance. Deliberate breaks (a wrong tolerance, a removed same-bar guard, wrong
ATR seeding) each fail those tests, which is what shows the fixture actually
constrains the port. Description text matches byte for byte, including Python's
round-half-even formatting of exact ties.

**Storage and jobs.** `daily_bars` keeps OHLCV (keyed by ticker, data feed and
date, so a free-feed series and a consolidated-feed series never mix, with no
foreign key to the universe so delisted history survives). `engine_runs`,
`engine_structure`, `engine_detector_hits` and `engine_forward_returns` hold the
per-run bookkeeping, the per-bar structure, every hit with a stable id and a
`features` blob for later research, and the labeled outcomes (forward returns and
a triple-barrier result, stop checked first when one bar reaches both). A nightly
workflow, chained after hydration, fetches bars incrementally, runs the engine in
chunks and labels hits whose horizon has passed. `lib/engine-db.ts` is the only
engine file that talks to the database.

## Where used

- **Shadow mode is the default.** Shadow runs write `engine_*` tables only, so
  nothing a user sees changes. `mode: "live"` also merges the fib ladder into
  `ticker_cards.numerics`, and the route refuses it with a 403 unless the same
  `ENGINE_LADDER_ENABLED` flag that opens the ladder route is set. See
  [[decision-engine-shadow-mode-first]].
- **Ladder route** (`GET /api/engine/[ticker]`) maps stored structure into the
  existing `FibSummary` shape so the Hold/Fold ladder renders it unchanged. It
  returns 404 unless its flag is on, and is not wired into any UI yet.
- **Paper account** — the decision core for a long-only `engine` account lives in
  `lib/shared/paper-engine-events.ts`; see [[entity-paper-portfolios]].
- **Bars** are fetched with the same pagination and bad-symbol handling as the
  local hydration runner but in their own script and workflow, so the two
  pipelines evolve independently ([[entity-ticker-universe-pipeline]]).

## Known failures

- **Never run end to end.** The route SQL was exercised against a real Postgres,
  and the fetcher, run driver and workflow have only had syntax checks. The first
  real run is the first time they meet Alpaca and a live portal.
- **Local production build cannot be verified in a worktree**: the prebuild
  migrate step needs a database URL, Turbopack rejects a symlinked `node_modules`,
  and the webpack build trips on the unresolved `firebase-admin` install in an
  untouched file. CI is the real build check for this change.
- **Data-source mismatch is expected, not a bug.** The lab uses one price vendor
  and the engine uses another; hit-level disagreement must be explained by data,
  not by logic, before the comparison gate passes.

## Open questions

> ❓ Open question: which volume feed the bar store should use. The free feed's
> volume is a fraction of consolidated volume, and the default detector gates on
> relative volume, so the choice changes which holds fire.

> ❓ Open question: the promotion goal, kill line and minimum sample size in
> `docs/engine/promotion-checklist.md` are blank by design and must be set by the
> owner *before* results exist, not after.

> ❓ Open question: whether the leg needs a start index for the levers that depend
> on swing age; three of the planned research levers are blocked on it.

## See also

- [[decision-engine-shadow-mode-first]] · [[entity-ticker-universe-pipeline]] · [[entity-paper-portfolios]]
- [[concept-signal-engine-host-parity]] · [[entity-signal-data-plane]]
- [[concept-mobile-web-parity]] (portal-only; mobile carries no engine)
