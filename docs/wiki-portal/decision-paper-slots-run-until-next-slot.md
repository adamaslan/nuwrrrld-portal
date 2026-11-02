---
date: 2026-10-27
type: decision
tags: [paper-portfolios, github-actions, scheduling, gate, late-runs]
sources: [../../.github/actions/market-gate/gate.mjs, ../../.github/workflows/paper-portfolios.yml, ../../lib/paper-engine.ts, incident-2026-09-22-paper-portfolios-slot-gate-never-matched]
---

# Decision: A Paper Trading Slot Runs From Its Start Until the Next Slot Begins

## Decision

A scheduled paper trading slot is eligible from its nominal start until the next slot begins: preopen until the session opens, midday until preclose begins (15:45 ET), and preclose until the 16:00 close. A run that starts late still trades and is recorded with `late=true`. The gate no longer refuses a trading slot for starting more than 30 minutes after its nominal time.

Each slot has three uncommon-minute cron entries (for example 09:07, 09:17 and 09:27 ET for preopen), so one delayed or dropped GitHub queue does not lose the slot. The route's unique `(account, trade_date, slot)` key absorbs the duplicates.

## Date

2026-10-27. Replaces the 30-minute window from the same day, which was pinned to the paper engine's `MAX_PRICE_AGE_MINUTES`.

## Context

The 2026-09-22 fix replaced an exact-minute match with a window, but GitHub Actions scheduled runs had been starting 40 minutes to 3 hours late, and some triggers were dropped. Under a 15-minute window, a single late trigger skipped the slot, and the workflow still exited green. A 30-minute window cut down that loss but still lost slots during the longer delays.

The 30-minute cap was not a hard constraint. The refresh step (`Refresh live_prices`) runs in the same job, right before the POST, so quotes are re-pulled at run time. `MAX_PRICE_AGE_MINUTES` in `lib/paper-engine.ts` therefore sees fresh prices however late the job started, and a queue delay does not make fills stale.

## Consequences

- Trades can land later in the session than the nominal time. Midday can run as late as 15:44 ET, and midday and preclose can be up to an hour apart.
- Duplicate runs cost extra Actions minutes. The route de-duplicates the orders, so they do not cause duplicate fills.
- Calendar, closed-day, session-open and session-closed checks are unchanged. A scheduled event still cannot use the manual `force` override.
- Settle is unchanged: a single `30 16` entry, with its own late-settle rules.

## How to apply

Keep a slot's band ending where the next slot begins, so two slots never trade back to back. If a future change widens a band past the session boundary, it needs a new decision, not a constant bump.

## Alternatives considered

- **Keep the 30-minute window.** Rejected: it lost slots whenever GitHub queued a trigger later than 30 minutes, which was the observed delay range.
- **Widen the window to match the observed delay.** Rejected: the cap was tied to `MAX_PRICE_AGE_MINUTES` by an earlier assumption. The price refresh makes that assumption unnecessary, but nothing else bounds the window except the session, so the session bounds it instead.
- **Let scheduled runs use the manual `force` override when late.** Rejected: the gate deliberately blocks scheduled events from forcing a run, and that protection covers closed days and holidays.

## Validated by

- `node --test .github/actions/market-gate/*.test.mjs`: 29 pass, including a late midday start at 14:10 ET that trades and is marked late, a midday start at 15:45 ET that is refused, and a late run on a closed day that is refused.
- Not yet validated in production: a live trading day is needed to confirm three entries per slot give the expected coverage. Measure over a week before calling the delay problem solved.

## See also

- [[entity-paper-portfolios]] — the schedule this decision changes
- [[incident-2026-09-22-paper-portfolios-slot-gate-never-matched]] — the earlier gate failure this window design builds on
