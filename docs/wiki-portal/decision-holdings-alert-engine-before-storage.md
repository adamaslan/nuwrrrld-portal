---
date: 2026-11-13
type: decision
tags: [alerts, watchlist, retention, pro-tier, fail-closed]
sources: [../../lib/holdings-alerts.ts, ../../lib/subscription.ts, ../../lib/digest.ts]
---

# Decision: Build the Holdings Alert Engine as Pure Logic Before Any Storage or Delivery

## Decision

Signal-change alerts for a user's watchlist start as a pure function: previous snapshot plus current snapshot plus held tickers in, a short ordered list of changes out (a reversal, a turn from neutral, a fade to neutral). It is gated on the existing, so far unused, `watchlist_alerts` Pro feature. Where the previous snapshot is stored, how an alert is delivered, and what a higher tier costs are deliberately not decided here.

## Date

2026-11-13

## Context

The strongest retention idea for a paid signal product is "a signal changed on something you own". Two of its three parts need decisions with real consequences: persisting the last-seen signal per user needs a schema migration, and delivery needs a send path and a rate policy. A higher price needs a billing change. Those are sensitive surfaces and need owner confirmation. The detection rule has none of that cost and is the part most likely to be wrong in a way users notice, so it is built and tested first.

## Alternatives considered

- **Build storage, endpoint and email in one change.** Rejected: it bundles a migration and a billing-adjacent path into one review and cannot be reverted piecemeal.
- **Alert on any score movement.** Rejected: a flip of direction is a statement a user can verify; a score wobble is noise and would train users to ignore the channel.
- **Alert on stale data and let the UI caveat it.** Rejected: an alert is pushed, so it must fail closed. A stale or unknown-quality current signal, an unparsable timestamp, a signal not newer than the baseline, and a ticker with no baseline all produce nothing.

## Consequences

The delivery layer can be idempotent: each alert carries a key built from ticker, change and timestamp. Wording is descriptive, never advisory ("the signal moved from bullish to bearish"), and a test pins that. Output is capped (20 by default) so one noisy digest cannot flood a user.

> ❓ Open question: the right previous-snapshot store (a new table versus reusing the per-user digest cache) and the right delivery channel are undecided. Both need an owner decision before code.

## Validated by

Fourteen unit tests on the pure function, plus the existing subscription tests, which still pass. Nothing was run against real digests, real watchlists or a delivery path.

## See also

- [[entity-billing]]
- [[concept-three-state-signal]]
- [[concept-graceful-degradation]]
