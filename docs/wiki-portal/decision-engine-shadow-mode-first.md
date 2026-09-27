---
date: 2026-09-26
type: decision
tags: [engine, shadow-mode, promotion, fibonacci, paper-trading, migration]
sources: [../../lib/engine, ../../app/api/pipeline/engine-run/route.ts, ../../app/api/engine/[ticker]/route.ts, ../engine/promotion-checklist.md, PR#189]
---

# Decision — Run the Engine in Shadow Mode First, Promote by Evidence

## Decision

The portal's signal engine ships writing **only its own tables**, with its user
facing outputs (the ladder route and any card numerics) switched off. It does not
replace an existing signal pipeline until a written promotion checklist is met,
and the checklist's goal and kill line are set before any results are read.

## Date

2026-09-26

## Context

Signals are produced today by several paths (a backend service, a local pipeline,
and a research lab). The canonical Fibonacci logic lives in the lab, and the
product needs it inside the portal so bars, hits and outcomes are owned in one
place and the same code can serve a route, a batch and an agent tool. Replacing
working pipelines in one step would remove the only ground truth to compare
against, and would do it on a data source the engine has not yet been run on.

## Alternatives considered

- **Cut over immediately** and retire the older writers. Rejected: it deletes the
  reference the port is measured against and hides any data-source mismatch behind
  a user-visible change.
- **Consume the lab's output over an API instead of porting.** Rejected: the lab
  is a research tool with its own release cadence, and the point is one owned
  implementation with a parity fixture, not a runtime dependency.
- **Ship the ladder route live on day one.** Rejected: a wrong ladder on the
  Hold/Fold surface is user visible; behind a flag it costs nothing to wait.

## Consequences

- Two write paths coexist for the shadow period; hits are compared per ticker and
  date, and every mismatch has to be explained by data or fixed.
- Promotion is a human decision recorded in a checklist, not a config flip that
  drifts: backtest goal met, then months of paper trading in the same direction.
- Before promotion, the paper `engine` account must trade the same hits so its
  live behavior can be measured. Only the pure decision core exists so far; the
  run loop and route that connect it to the paper run are not written.
- Retiring the older signal writers stays a separate, explicit decision because it
  removes working pipelines.

## Validated by

- Golden-fixture parity against the canonical lab code, with deliberate breaks
  proving the tests bite.
- The route SQL and the full schema applied twice to a real Postgres.
- Not yet validated: any real run against live bars. That is the point of the
  shadow period.

## See also

- [[entity-signal-engine]] · [[entity-paper-portfolios]] · [[entity-ticker-universe-pipeline]]
- [[concept-signal-engine-host-parity]]
