# Tickers Followed — the standing benchmark, eval harness, and judge

**Written:** 2026-08-30
**Scope:** `nuwrrrld-portal` — a frozen monthly cohort of the app's own
strongest directional calls, scored against realized prices across seven
horizons, and graded for reasoning quality by an LLM judge.

This file is the human-readable face of an automated process. It is **not**
hand-curated.

Once a month a **selection run** reads the app's ranked signal universe
(`/api/signals/top`), takes the **10 most bearish** and **10 most bullish**
tickers, and freezes them as that month's cohort. Freezing is what makes this
an eval rather than a watchlist: a rolling list that re-picks daily hides every
miss, because a bad call silently drops off the ranking before it can be
scored. A frozen cohort has to stay wrong in public.

From that moment each of the 20 picks is a **standing prediction with a
timestamp, a direction, an entry price, and a stated invalidation level** —
which is precisely the shape of a benchmark item. Every trading day a
**tracking run** records where the price actually went, and every horizon
boundary (1 day, 1 week, 1 month, 3 months, 6 months, year-to-date, 1 year) a
**scoring run** resolves the accumulated picks that have come of age and writes
a hit-rate for each horizon.

Two things get measured, and keeping them apart is the whole design:

- **Outcome accuracy** — did the price move the way the call said? Pure
  arithmetic against realized prices. No model involved.
- **Reasoning quality** — was the *stated rationale* sound, grounded, and
  falsifiable? Graded by an LLM judge that never sees the outcome.

A call that was right for an ungrounded reason and a call that was wrong for a
well-reasoned one are different failures, and a single blended score erases
both. See *Why outcome and reasoning are scored separately* below.

---

## Table of contents

1. [How the cohort is chosen (monthly)](#how-the-cohort-is-chosen-monthly)
2. [What runs against them (daily)](#what-runs-against-them-daily)
3. [The horizon ladder](#the-horizon-ladder)
4. [Scoring: outcome accuracy](#scoring-outcome-accuracy)
5. [Scoring: LLM as judge](#scoring-llm-as-judge)
6. [Why outcome and reasoning are scored separately](#why-outcome-and-reasoning-are-scored-separately)
7. [Benchmark integrity rules](#benchmark-integrity-rules)
8. [Baselines — what the score is compared against](#baselines--what-the-score-is-compared-against)
9. [Current cohort](#current-cohort)
10. [Scoreboard](#scoreboard)
11. [Judge scorecard](#judge-scorecard)
12. [Cohort history](#cohort-history)
13. [Data model](#data-model)
14. [Automation](#automation)
15. [Follow-up work](#follow-up-work)
16. [Verification](#verification)

---

## How the cohort is chosen (monthly)

| Step | Source | Rule |
|---|---|---|
| 1. Rank | `GET /api/signals/top?universe=all&horizon=t1&limit=200` | The ranked ticker-card universe — `topCards()` ordered by signal strength. |
| 2. Split by direction | each card's `category` / verdict sign | Bullish cards in one pile, bearish in the other. Neutral / absent-signal cards are ignored (see [[concept-three-state-signal]] — a measured-negative is a real bear signal, an *absent* one is not). |
| 3. Take the extremes | strength score | Top 10 by strength from each pile → 20 tickers. Ties broken by `bars_scanned` (more history first), then alphabetically. |
| 4. Stamp the prediction | `live_prices` + the card | Each pick is frozen with `entry_price`, `direction`, `strength`, `signal_category`, and the council's `invalidation` level, all as of the selection timestamp. **This tuple is the benchmark item.** |
| 5. Freeze for the month | this file | The 20 are written to *Current cohort* with `added` = selection date. They do **not** change mid-month even if the ranking shifts. |
| 6. Archive the prior month | *Cohort history* | The outgoing table moves down with its final readings intact; its picks stay live in the scoreboard until their longest horizon resolves. |

A ticker can be dropped mid-month only if it is **delisted or halted** — noted
inline with the reason, never silently removed. A dropped ticker's already-open
horizons resolve as `void`, not as a miss, and `void` items are excluded from
the denominator rather than counted as failures.

---

## What runs against them (daily)

For each of the 20 tickers, on every trading day:

| Feature | Endpoint | What it contributes |
|---|---|---|
| **Price observation** | `live_prices` (Finnhub-fed) | The day's close for the ticker, appended to `followed_ticker_observations`. This is the only input to outcome scoring, and it is the one row that must never be missed — a gap in the price series makes every horizon crossing it unresolvable. |
| **Backtest** | `GET /api/backtest/{symbol}` | Historical hit-rate for the signal category currently firing — "when this setup appeared before, it resolved in the signal's direction X% of the time." Returns 204 when the engine is disabled; the row then reads `—`. This is the **prior** the judge and the scoreboard are compared against. |
| **Signal** | the ranked card from `/api/signals/top`, re-pulled daily | Today's direction + strength, and whether the ticker is still on the side it was picked on. A bull that has flipped bearish is the most interesting row in the table. |
| **AI council** | `POST /api/pipeline/followed-tickers` → one grounded council call per ticker (free-tier models only, see [[concept-free-tier-resilience]]) | A structured verdict — `OUTLOOK` / `BECAUSE` / `INVALIDATION` / `EXECUTION`, per `lib/council-verdict.ts` — grounded on the live signal and the backtest hit-rates. This is the **artifact the judge grades**. |

The daily run writes back into *Current cohort*: it updates `latest signal`,
`backtest`, `council`, and flips `thesis holding?` to **no** the first day a
ticker's live signal direction disagrees with its picked `direction`. The flip
is recorded with its date, because *how long a thesis survived* is itself a
metric — see `days_held` in the scoreboard.

---

## The horizon ladder

Seven horizons, each resolving independently against the same frozen entry.
A single pick therefore produces up to seven scored rows over its lifetime,
and early horizons are readable long before the late ones have any data.

| Horizon | Key | Resolves at | Available from | What it measures |
|---|---|---|---|---|
| Daily | `d1` | next trading close | day 1 | Signal noise floor. Near-coin-flip by construction; useful only in aggregate over hundreds of picks. |
| Weekly | `w1` | +5 trading days | week 1 | The T1 swing horizon the signal engine is actually tuned for. **This is the headline number** until three months of history exist. |
| Monthly | `m1` | +21 trading days | month 1 | Whether the monthly cohort held for its own refresh period. The most natural unit — a pick is graded over exactly the window it was the reigning pick for. |
| 3-month | `m3` | +63 trading days | month 3 | First horizon long enough to survive a single earnings cycle. |
| 6-month | `m6` | +126 trading days | month 6 | Regime-change territory; a signal that survives here is measuring something structural. |
| Year-to-date | `ytd` | Dec 31 close | first Jan rollover | Calendar-anchored, so it is comparable to how every benchmark publishes. Partial and re-stated daily until year end — always render it with an "as of" date. |
| 1-year | `y1` | +252 trading days | year 1 | The long-run number. Not meaningfully readable until ~2027-09. |

**Reading the ladder honestly.** Horizons become available on a schedule, and
a horizon with fewer than **30 resolved picks** is reported as `n<30 —
insufficient` rather than as a percentage. A hit-rate over 4 picks is not a
hit-rate; publishing one is the single easiest way to make this harness lie.
The scoreboard renders the count next to every number so the denominator is
never hidden.

---

## Scoring: outcome accuracy

Pure arithmetic. No model, no judgment, fully reproducible from the price
series alone.

For a pick with `entry_price` **E**, `direction` **D**, and horizon close
**P**, the signed return in the direction of the call is:

```
return_pct   = (P - E) / E * 100
directional  = D == "bull" ?  return_pct
                           : -return_pct      # a bear call profits when price falls
```

Then, with a **dead-band** τ:

| Outcome | Condition | Meaning |
|---|---|---|
| `hit` | `directional > +τ` | Moved the called way by more than noise. |
| `miss` | `directional < -τ` | Moved decisively against the call. |
| `flat` | `abs(directional) <= τ` | Inside the dead band — no information either way. |
| `void` | delisted / halted / price gap | Unresolvable. Excluded from the denominator. |

**τ scales with the horizon**, because ±0.5% in a day and ±0.5% in a year are
not the same claim: `d1` 0.5%, `w1` 1%, `m1` 2%, `m3` 3%, `m6` 5%, `ytd` 5%,
`y1` 8%. A fixed τ across all seven would make long horizons look far more
accurate than they are, since any drift eventually exceeds a small band.

**`flat` is reported, never silently dropped.** The headline hit-rate is
`hits / (hits + misses)` — flats excluded, since they are genuinely
uninformative — but the flat count is printed alongside it. A strategy that is
70% accurate on 10 decisive calls out of 200 picks is a different object from
one that is 70% accurate on 190, and hiding the flat count conflates them.

Three secondary measures come free from the same data and are worth more than
the hit-rate alone:

- **Mean directional return** — hit-rate ignores magnitude, so a method that
  is right 55% of the time on small moves and wrong 45% on large ones scores
  well and loses money. This catches that.
- **`days_held`** — trading days until `thesis holding?` flipped. A pick that
  was right at `m1` but flipped on day 3 and back on day 19 was not a good
  call, and only this column shows it.
- **Calibration** — bucket picks by the council's stated `confidence`
  (low/medium/high) and compare each bucket's hit-rate to its claim. A model
  whose `high`-confidence calls hit at the same rate as its `low`-confidence
  ones has confidence that carries no information, which is a distinct and
  more actionable defect than plain inaccuracy.

---

## Scoring: LLM as judge

A second, independent pass grades the **quality of the reasoning** in each
council verdict. It runs on a weekly cadence over a sample of that week's
verdicts, not on every verdict daily — the free-tier quota does not support
20 extra grounded calls a day on top of the 20 the tracking run already makes
([[concept-free-tier-resilience]]).

### The two-layer contract: validators first, judge second

The judge never sees a verdict that the **deterministic validators** in
`lib/council-validate.ts` have already rejected. Those run first, cost
milliseconds, and catch the failures a model is worst at catching:

- **Numeric cross-check** — every number in `BECAUSE` / `INVALIDATION` /
  `EXECUTION` must appear (±1%) in the brief the verdict was grounded on.
- **Trade-logic sanity** — `EXECUTION`'s entry/stop/target must be ordered
  correctly for the call's direction.

A verdict failing either goes through the existing repair loop
(`buildRepairMessage`). Only verdicts that pass reach the judge. This ordering
matters: an LLM judge asked to check arithmetic is expensive, slow, and worse
at it than a regex, and letting it grade a verdict with a hallucinated number
teaches the scoreboard that fabrication is a style problem rather than a
disqualifying one.

### What the judge scores

Five criteria, each `0–2` (0 = absent/violated, 1 = partial, 2 = fully met),
for a max of 10:

| # | Criterion | Passes when |
|---|---|---|
| 1 | **Grounding** | `BECAUSE` cites an evidence id from `RULES` and quotes it exactly, rather than composing a plausible-sounding sentence. |
| 2 | **Falsifiability** | `INVALIDATION` names a specific price level or observable condition. "If the trend reverses" scores 0; "below $187.40" scores 2. |
| 3 | **Internal consistency** | `OUTLOOK`, `BECAUSE`, and `EXECUTION` describe the same trade. A bullish outlook with a short-shaped execution scores 0. |
| 4 | **Specificity** | Concrete levels and timeframes over hedged prose. Generic market commentary that would fit any ticker scores 0. |
| 5 | **Calibration language** | Stated confidence matches the strength of the cited evidence — no `high` confidence resting on one weak signal. |

### Judge integrity rules

These are the rules that decide whether the judge's output means anything.

1. **Outcome-blind.** The judge's prompt contains the verdict and the brief it
   was grounded on — never the realized price, never the resolved outcome,
   never the current date relative to the pick. A judge that can see the
   answer grades hindsight, and its scores collapse into a noisy copy of the
   outcome column.
2. **Different model than the author.** The judge runs on a different
   free-tier model than the seat that produced the verdict, and never on the
   same model instance. Self-grading inflates: a model's notion of a good
   answer is its own output distribution.
3. **Rubric-anchored, not preference-based.** The judge returns five integers
   and a one-line justification per criterion — never a holistic "rate this
   1–10". Holistic scores drift with prompt phrasing and cannot be audited.
4. **Position-and-verbosity controlled.** When comparing two verdicts, both
   orderings are run and averaged; length is not a criterion. LLM judges
   reliably favor the first-presented and the longer answer, and both biases
   are large enough to swamp the effect being measured.
5. **Anchored by a gold set.** A fixed set of ~20 hand-scored verdicts —
   deliberately spanning excellent, mediocre, and outright ungrounded — is
   re-graded on every judge run. **If the judge's agreement with the gold set
   drops below 80%, the run's scores are discarded, not published.** This is
   the only defense against silent judge drift when the free-tier model chain
   swaps a model out from under the harness, which it does without notice.
6. **Judge changes reset the series.** Changing the judge model or the rubric
   starts a new scoring series with a version tag. Judge scores are comparable
   only within a version — splicing them across a rubric change produces a
   trend line that is an artifact of the change.

---

## Why outcome and reasoning are scored separately

This is the design decision the rest of the harness rests on, so it is worth
stating plainly: **do not blend the outcome score and the judge score into one
number.**

Over any horizon shorter than a quarter, market outcomes are mostly noise. A
verdict can be perfectly grounded, cite the right evidence, name a real
invalidation level, and still lose — because an unrelated macro print landed
two days later. The reverse is worse and more common: a lazy, ungrounded,
unfalsifiable verdict is right roughly half the time by construction, and a
blended score rewards it exactly as much as a rigorous one.

Keeping the two axes apart makes the diagnostic quadrant readable:

| | **Outcome hit** | **Outcome miss** |
|---|---|---|
| **High judge score** | Working as intended. | Sound process, unlucky draw — expected at this frequency; do not "fix" it. |
| **Low judge score** | **The dangerous quadrant.** Right for no articulable reason: looks like success, generalizes to nothing, and is what a blended metric would promote. | Genuinely broken. Fix the grounding path before reading anything else. |

The bottom-left cell is the whole argument. A single blended score cannot
distinguish it from the top-left, and optimizing that blended score
systematically selects for it.

---

## Benchmark integrity rules

What keeps this an eval instead of a set of numbers that always look good.

1. **Freeze before observation.** A pick's `entry_price`, `direction`, and
   `invalidation` are written at selection time and never updated. Any
   retroactive edit voids the pick.
2. **No survivorship pruning.** Delisted/halted names resolve `void` and are
   reported as void; they never quietly vanish from the denominator. Cohort
   history keeps every past cohort in full, including its worst rows.
3. **Denominators always visible.** Every published rate carries its `n`. Rates
   under `n=30` are not published as rates.
4. **No post-hoc horizon shopping.** All seven horizons are computed and
   published for every pick. Reporting only the horizon that happened to work
   is the most common way an eval becomes marketing.
5. **Baseline-relative.** A hit-rate without a baseline is uninterpretable —
   see below.
6. **Judge scores are versioned.** Per judge integrity rule 6.
7. **The scoreboard is append-only.** Corrections are new rows with a reason,
   not edits. The git history of this file is part of the evidence.

---

## Baselines — what the score is compared against

A 55% hit-rate means nothing on its own. In a market that rose over the
period, a "always bullish" strategy might hit 60%, and beating coin-flip is
not the bar. Every scoreboard row is therefore reported next to four
baselines, computed over the identical picks and horizons:

| Baseline | Definition | Catches |
|---|---|---|
| **Coin flip** | 50% | Nothing subtle — the absolute floor. |
| **Always-long** | Every pick scored as if it were bullish | Bull-market drift. If the harness can't beat this, it is measuring the market's direction, not the signal's skill. |
| **Buy-and-hold SPY** | Same entry/exit dates, SPY substituted | Whether ticker selection added anything over just being invested. |
| **Backtest prior** | The `backtest_hit_rates` figure for the firing category | Whether the *live* signal performs like its own history claims. A large gap between the two is the most valuable single finding this harness can produce — it means the backtest is overfit, and that is worth more than any hit-rate. |

The bear side gets its own row throughout. Bear calls in a rising market fail
for reasons that have nothing to do with signal quality, and blending the two
sides hides both.

---

## Current cohort

**Selection run:** _not yet executed_ — this table is populated by the first
monthly run of `select-followed-tickers.yml` (see *Automation*). Until then
the rows are the shape the run will fill, not real picks.

### Bulls (10)

| Ticker | Direction | Added | Entry | Latest signal | Backtest | Council | Judge /10 | Days held | Thesis holding? |
|---|---|---|---|---|---|---|---|---|---|
| _pending selection run_ | bull | — | — | — | — | — | — | — | — |

### Bears (10)

| Ticker | Direction | Added | Entry | Latest signal | Backtest | Council | Judge /10 | Days held | Thesis holding? |
|---|---|---|---|---|---|---|---|---|---|
| _pending selection run_ | bear | — | — | — | — | — | — | — | — |

---

## Scoreboard

Outcome accuracy by horizon. Rewritten by the scoring run as each horizon
resolves. `n` is resolved picks (hits + misses; flats and voids excluded from
the rate but counted in their own columns).

**As of:** _no scoring run has executed_

| Horizon | n | Hit | Miss | Flat | Void | Hit-rate | Mean ret % | vs always-long | vs SPY | vs backtest prior |
|---|---|---|---|---|---|---|---|---|---|---|
| `d1` | 0 | — | — | — | — | `n<30` | — | — | — | — |
| `w1` | 0 | — | — | — | — | `n<30` | — | — | — | — |
| `m1` | 0 | — | — | — | — | `n<30` | — | — | — | — |
| `m3` | 0 | — | — | — | — | `not yet available` | — | — | — | — |
| `m6` | 0 | — | — | — | — | `not yet available` | — | — | — | — |
| `ytd` | 0 | — | — | — | — | `not yet available` | — | — | — | — |
| `y1` | 0 | — | — | — | — | `not yet available` | — | — | — | — |

### Split by side

| Side | Horizon | n | Hit-rate | Mean ret % |
|---|---|---|---|---|
| bull | `w1` | 0 | `n<30` | — |
| bear | `w1` | 0 | `n<30` | — |

### Calibration

Council confidence vs. realized hit-rate. A well-calibrated column rises
monotonically down the table.

| Stated confidence | n | Hit-rate | Gap vs claim |
|---|---|---|---|
| high | 0 | `n<30` | — |
| medium | 0 | `n<30` | — |
| low | 0 | `n<30` | — |

---

## Judge scorecard

Reasoning quality, independent of outcome. **Judge version:** `v1` (rubric
above, 5 criteria × 0–2).

**As of:** _no judge run has executed_

| Period | Verdicts graded | Mean /10 | Grounding | Falsifiability | Consistency | Specificity | Calibration | Gold-set agreement |
|---|---|---|---|---|---|---|---|---|
| _pending first judge run_ | 0 | — | — | — | — | — | — | — |

### Quadrant distribution

The diagnostic from *Why outcome and reasoning are scored separately*. The
bottom-left cell is the one to watch.

| | Outcome hit | Outcome miss |
|---|---|---|
| **Judge ≥ 7** | 0 | 0 |
| **Judge < 7** | 0 | 0 |

---

## Cohort history

Prior months' cohorts, moved here on the next monthly refresh with their final
readings. Picks stay live in the scoreboard until their longest horizon
resolves, so a cohort appearing here is archived, not finished.

_(none yet)_

---

## Data model

The markdown tables above are a **rendering**, not the store. Markdown cannot
support seven horizons × N cohorts × per-criterion judge scores without
becoming unreadable and unqueryable, and a scoring run that has to parse
markdown to find the previous state will eventually corrupt it.

Three new tables, following the conventions already in `lib/db/schema.sql`:

```sql
-- One row per pick per cohort. Written once at selection, never updated.
CREATE TABLE IF NOT EXISTS followed_ticker_picks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_month    date        NOT NULL,       -- first of the selection month
  ticker          text        NOT NULL,
  direction       text        NOT NULL,       -- 'bull' | 'bear'
  entry_price     numeric     NOT NULL,
  strength        real,
  signal_category text,
  invalidation    text,                       -- from the council verdict
  confidence      text,                       -- low | medium | high
  selected_at     timestamptz NOT NULL DEFAULT now(),
  dropped_at      timestamptz,                -- delisting/halt only
  drop_reason     text,
  UNIQUE (cohort_month, ticker)
);

-- Daily append. The price series outcome scoring reads.
CREATE TABLE IF NOT EXISTS followed_ticker_observations (
  pick_id       uuid        NOT NULL REFERENCES followed_ticker_picks(id) ON DELETE CASCADE,
  observed_on   date        NOT NULL,
  close_price   numeric     NOT NULL,
  signal_dir    text,                         -- today's direction, for days_held
  backtest_rate real,
  council_json  jsonb,                        -- the structured verdict, verbatim
  PRIMARY KEY (pick_id, observed_on)
);

-- One row per pick per horizon, written when that horizon resolves.
CREATE TABLE IF NOT EXISTS followed_ticker_scores (
  pick_id      uuid        NOT NULL REFERENCES followed_ticker_picks(id) ON DELETE CASCADE,
  horizon      text        NOT NULL,          -- d1|w1|m1|m3|m6|ytd|y1
  resolved_on  date        NOT NULL,
  exit_price   numeric,
  return_pct   real,
  directional  real,                          -- sign-corrected for direction
  outcome      text        NOT NULL,          -- hit|miss|flat|void
  judge_score  int,                           -- 0-10, null until judged
  judge_detail jsonb,                         -- per-criterion scores + justifications
  judge_version text,
  PRIMARY KEY (pick_id, horizon)
);
CREATE INDEX IF NOT EXISTS followed_ticker_scores_horizon_idx
  ON followed_ticker_scores (horizon, resolved_on DESC);
```

The `ytd` horizon is the one irregularity: it re-resolves daily until Dec 31
rather than once at a fixed offset, so its row is updated in place and
`resolved_on` carries the as-of date. Every other horizon writes once.

---

## Automation

Three workflows, all following the pattern established by
[[decision-afternoon-pipeline-cron-split]] — a market-hours gate,
`workflow_dispatch` with a `dry_run` input, secret verification before any
call, `concurrency` guard, step summary, artifact upload, and a
failure-issue notification.

| Workflow | Schedule | Calls | Job |
|---|---|---|---|
| `.github/workflows/select-followed-tickers.yml` | `0 14 1 * *` — 1st of the month, ~10 AM ET | `POST /api/pipeline/followed-tickers-select` | Ranks the universe, picks 10+10, stamps entry prices, writes `followed_ticker_picks`, rewrites *Current cohort*, archives the prior table. |
| `.github/workflows/track-followed-tickers.yml` | `30 20 * * 1-5` — weekdays 3:30 PM ET (after the afternoon pipeline has refreshed signals) | `POST /api/pipeline/followed-tickers` | Appends the day's `followed_ticker_observations` for all live picks, resolves any horizon that came due, updates *Current cohort*. |
| `.github/workflows/judge-followed-tickers.yml` *(not yet written)* | weekly, Sat ~12:00 ET | `POST /api/pipeline/followed-tickers-judge` | Grades that week's verdicts against the rubric, re-grades the gold set, aborts and publishes nothing if gold agreement < 80%. |

Running the judge on a Saturday is deliberate: it is off-market, so it
competes with neither the afternoon pipeline nor interactive Nu AI traffic for
the shared free-tier quota.

### Route status — shipped ahead of its endpoints

Exactly as `afternoon-pipeline.yml` was merged before its `/api/pipeline/*`
routes existed ([[decision-afternoon-pipeline-cron-split]]): **the workflows
are orchestration only.** The routes they call —
`/api/pipeline/followed-tickers-select`, `/api/pipeline/followed-tickers`, and
`/api/pipeline/followed-tickers-judge` — **do not exist yet.** The workflows
pass their gate and secret-check steps and then 404 on the trigger call until
follow-up PRs land the handlers. This is deliberate: the route work touches
`lib/backtest.ts`, the signal-lookup layer, the council-grounding path, and
three new tables, and needs its own route tests. Holding the scheduler infra
hostage to it is the anti-pattern that decision doc calls out.

The route paths are **namespaced under `/api/pipeline/`** — a prefix with no
existing occupant — so a misconfiguration 404s loudly against a route that
isn't built rather than silently 401ing against a working endpoint that does
something else (the `/api/signals/refresh` reuse bug from
[[decision-afternoon-pipeline-cron-split]]).

### Secrets required (already used by `afternoon-pipeline.yml`)

- `PORTAL_URL` — base URL of the deployed portal.
- `CRON_SECRET` — bearer token the scheduled call sends; the future routes must
  gate on it, not on `PORTAL_PUSH_SECRET`.

---

## Follow-up work

Ordered by dependency — each item unblocks the next.

1. **Schema migration** — the three tables above, via `scripts/db-migrate.mjs`.
   Nothing else can land first; the routes have nowhere to write.
2. **`POST /api/pipeline/followed-tickers-select`** — reads `/api/signals/top`,
   splits by direction, takes the extremes, stamps entry prices from
   `live_prices`, inserts `followed_ticker_picks`, edits this file's *Current
   cohort* in place, moves the old table to *Cohort history*.
3. **`POST /api/pipeline/followed-tickers`** — the daily observer: for each
   live pick, append an observation row (close, signal direction, backtest
   rate, council verdict JSON), then resolve any horizon that came due into
   `followed_ticker_scores`.
4. **`lib/eval-scoring.ts`** — pure functions for the outcome math: `directional`,
   the per-horizon dead-band table, `outcome` classification, aggregate
   hit-rate with `n<30` suppression, and the four baselines. Pure and
   dependency-free so it is unit-testable without a DB, which matters because
   a scoring bug is invisible — it produces plausible numbers.
5. **`POST /api/pipeline/followed-tickers-judge` + `lib/eval-judge.ts`** — the
   rubric prompt, the gold-set comparison, the <80%-agreement abort, and the
   `judge_version` stamp. Depends on `lib/council-validate.ts` running first
   as the pre-filter.
6. **The gold set** — ~20 hand-scored verdicts spanning the quality range,
   checked in as a fixture. This is manual work and cannot be generated by the
   model being evaluated; without it, judge rule 5 is unenforceable and the
   judge column is unfalsifiable.
7. **Distribution guard** — the same forced-distribution check
   `afternoon-pipeline.yml` runs, so a month of uniform `neutral` council
   verdicts fails loudly (issue #12 regression class).
8. **Scoreboard rendering** — the run rewrites the *Scoreboard* and *Judge
   scorecard* sections from the tables, never by hand.
9. **Public surface** — decide whether any of this is user-facing. The
   `n<30` and baseline rules exist so that it *could* be, but that is a
   product decision with compliance weight (`docs/wiki-portal/entity-disclaimer-system.md`), not a
   default.
10. **Mobile parity** — decide whether `gcp3-mobile` surfaces the cohort or
    the scoreboard ([[concept-mobile-web-parity]] / [[concept-sync-requirements]]).

---

## Verification

| Check | Result |
|---|---|
| `select-followed-tickers.yml` YAML parse | _validate before commit_ |
| `track-followed-tickers.yml` YAML parse | _validate before commit_ |
| `judge-followed-tickers.yml` exists | **no** — follow-up |
| Routes called exist | **no** — documented above, follow-up PRs |
| Schema tables exist | **no** — migration is follow-up item 1 |
| Ran against live data | **no** — no selection run has executed |
| Any published hit-rate | **no** — and none may be published under `n=30` |

Every number in this document is a placeholder. Nothing here has been
measured, and the tables are the shape the runs will fill.

---

## Cross-references

- `docs/wiki-portal/concept-followed-tickers-tracking.md` — the wiki page for
  this process and why it is a monthly-cohort design, not a rolling watchlist.
- `docs/wiki-portal/decision-afternoon-pipeline-cron-split.md` — the workflow
  pattern these jobs copy, and the two bugs (route reuse, DST double-fire)
  they were written to avoid.
- `docs/wiki-portal/entity-ai-council.md` — the council's grounding contract
  and free-tier model chain.
- `docs/wiki-portal/entity-backtest-engine.md` — the separate signals-app
  backtest backend, the `backtest prior` baseline, and its
  `SIGNALS_ENGINE_URL` disable-by-default posture.
- `lib/council-verdict.ts` — the four-field structured verdict the judge grades.
- `lib/council-validate.ts` — the deterministic validators that run *before*
  the judge, and the repair loop.
- `lib/track-record.ts` — the existing aggregate hit-rate over
  `backtest_hit_rates`; the scoreboard is the forward-looking counterpart.
- `app/api/signals/top/route.ts` — the ranked universe the monthly selection
  reads.
- `docs/ship-to-clients-top-25.md` — item #14 (explain-quality gate) is exactly
  what the judge scorecard measures.
