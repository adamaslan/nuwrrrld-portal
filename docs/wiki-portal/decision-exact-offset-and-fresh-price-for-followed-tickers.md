---
date: 2026-10-04
type: decision
tags: [followed-tickers, benchmark, eval, price, data-integrity, horizon]
sources: [../../lib/shared/followed-tickers-policy.ts, ../../lib/followed-tickers-price.ts, ../../lib/alpaca-latest-price.ts, ../../app/api/pipeline/followed-tickers/route.ts, ../../app/api/pipeline/followed-tickers-select/route.ts, ../../lib/db/schema.sql]
---

# Decision — Horizons Exit on Their Own Offset; Prices Must Be Fresh or Absent

## Context

The [[concept-followed-tickers-tracking]] benchmark scores each pick at seven
horizons. Two things can silently corrupt those scores: a horizon that exits
on a later price than its label says, and an entry or close price that is stale
but looks current. Either one makes a hit-rate wrong without any error.

Before this decision the observer scored every due horizon against the most
recent observation. Entry prices came from `live_prices` with no date check.

## Decision

1. **A fixed horizon exits on its trading-day offset.** The exit is the first
   observation at or after the horizon's offset from entry. Trading days are
   counted as weekdays, with holidays not excluded. One weekday of lag is
   tolerated, which covers a single market holiday.
2. **A missing due close voids the horizon.** If the first observation past the
   offset is more than one weekday late, the horizon is scored `void` against
   the last observation date. The system never borrows a later close.
3. **A price is used only if it is dated on or after a freshness bound**
   (New York calendar date). The chain is `live_prices` → Alpaca latest trade
   (`iex`) → latest `daily_bars` close. A rung that is stale falls through, and
   the fall-through is logged.
4. **Entry freshness is 7 calendar days.** Selection runs on the 1st, so the
   honest entry is the prior close, one to four days old. A week covers a long
   weekend.
5. **Track freshness is the current NY date.** The daily close must belong to
   today. A stale quote is recorded as a missed observation, never as a close.
6. **Every accepted price records its source** (`price_source` on picks and
   observations), so a vendor switch appears in the data.

## Why

- A benchmark that is wrong with no error is worse than one that is empty. An
  empty benchmark says "not yet"; a wrong one reports a hit-rate.
- Voiding a horizon costs one data point. Borrowing a later close poisons the
  horizon's whole sample, and it can't be detected afterwards.
- The UTC date is wrong for this purpose. After the 19:00 ET track run it is
  already the next day, so observations would land on the wrong trading day.

## Trade-offs accepted

- Holidays are not excluded from the count. A two-day holiday around a due date
  voids a horizon that a holiday-aware calendar would have scored. That is
  rarer than the failure it prevents, and it's visible as `void`.
- `daily_bars` closes are split-adjusted, while `live_prices` quotes are raw.
  A split on a pick's ticker mid-horizon would distort the return. This is
  noted, not handled.
- Alpaca's last trade is an IEX print, not the official closing auction. The
  fallback is labelled `alpaca_iex`, so the difference can be checked later.

## How to apply

- New price consumers for the benchmark go through `resolveFollowedPrice`. Do
  not call `getLivePrice` directly for an entry or a close.
- Horizon math goes through `horizonExit`. Do not index the observation array
  by position.
- Tests: `__tests__/followed-tickers-horizon-exit.test.ts`,
  `__tests__/followed-tickers-price.test.ts`.

## Related

- [[incident-2026-10-04-followed-tickers-never-produced-data]] — the failures that
  made this decision necessary
- [[entity-live-price-tier]] — the primary price source and its coverage limit
