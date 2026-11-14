---
date: 2026-11-13
type: decision
tags: [track-record, followed-tickers, public-surface, trust, growth]
sources: [../../lib/public-track-record.ts, ../../lib/public-track-record-db.ts, ../../components/landing/RecordedOutcomes.tsx, ../../lib/eval-scoring.ts]
---

# Decision: The Public Track Record Publishes Counts, Never Picks

## Decision

The unauthenticated `/track-record` page shows the Followed Tickers scoreboard as aggregate counts per horizon: hits, misses, flat-band calls, unpriced calls, a hit-rate, and mean directional return. It never shows a ticker, a price, a cohort member or a per-pick row. Misses sit beside hits on every row. The hit-rate is withheld until a horizon has at least the same 30 decisive calls the signed-in scoreboard requires. No benchmark comparison is shown.

## Date

2026-11-13

## Context

The page previously described the record in prose and linked to a Pro-gated dashboard, so a visitor could not check anything before paying. A record that can be checked is the argument for a paid tier, but the underlying prices are not all verified: the November 12 audit found a suspicious return basis on one ticker and unreconciled paper baselines, so a public number built on unverified inputs would advertise exactly the data in question.

## Alternatives considered

- **Per-pick public table.** Rejected: it hands the paid product's content away and publishes entry prices whose source varies by pick.
- **Show a hit-rate at any sample size.** Rejected: [[concept-followed-tickers-tracking]] already holds that a rate under 30 decisive calls is the easiest way for the harness to mislead.
- **Show a SPY-relative figure.** Rejected for now: the paper benchmark metrics are dark-launched ([[decision-dark-launch-flags]]) because their basis is not verified. The page says so in one sentence rather than implying a comparison exists.

## Consequences

The page is statically revalidated hourly and reads the database through a lazy import, so a build without a database renders the empty state instead of failing. Early on, most rows will read "too few" instead of a percentage; that is the intended honest state, and it improves as cohorts accumulate. Flat and unpriced calls are shown so a high hit-rate on few decisive calls is visible as such.

## Validated by

Unit tests on the pure builder cover the minimum-sample withholding, misses and flats in the right denominators, horizon ordering, and the absence of any per-pick identifier from the output. No signed-in or production rendering was checked when this was written.

## See also

- [[concept-followed-tickers-tracking]]
- [[decision-dark-launch-flags]]
- [[concept-public-surface-audit]]
