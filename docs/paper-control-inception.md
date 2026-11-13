# Cash controls: explicit fixed-book inception

## Diagnosis

Nov10 production arena and IVV account reads show cash10000, NAV10000, zero positions/orders and no invested performance. `seed-paper-portfolios.mjs` creates accounts/watchlists only. The old engine marks equal/spy but never buys either book, as already documented in paper-trading-v3 F1/D1. The zero is real cash behavior, not evidence of an invested benchmark's return.

Read-only sources:
- https://financial.nuwrrrld.com/api/paper/arena
- https://financial.nuwrrrld.com/api/paper/spy

## Fix

Cash-only controls display Awaiting first investment - cash only. NAV remains the genuine10000; return/comparison/metrics are unknown, not misleading0. A real invested0% stays0. Cash-only control marks are excluded from their curves and future metric calculations. No historical control prices or returns are invented.

Initialization is explicitly OFF for every ordinary cron/workflow. Only an approved targeted invocation of the existing authenticated pipeline with `initialize_control=true`, a single `account=equal` or `account=spy`, and a current nonsettle slot enables it. Existing PAPER_CRON_SECRET and production-DB guard are unchanged. No new secret/env/admin/migration needed. Deployment/merge alone must not buy anything. This code is not approval to invoke it.

Before inception, require an active account, pristine starting cash, no positions/orders, exactly the frozen Core50 or IVV watchlist and complete positive fresh prices. Invalid, over30minuteold or over5minutefuture prices deny the entire plan. No partial book. Uses6decimal fractional shares and ordinary slippage inside the10000cash budget. Controls never enter model arbitration, never rebalance and never refill historical/partial books. Fixed Core50 is tested against the canonical seed list.

An account-scoped transaction advisory lock plus guarded run INSERT rechecks no orders/positions and pristine matching cash. Each buy references that new run, so a competing cross-slot inception that loses the guard aborts atomically through FK; same-slot idempotency retains existing behavior. Mocked SQL tests inspect the lock/guard/order construction, but a real PostgreSQL concurrency run has NOT been performed.

After inception, value genuine holdings at current marks. Day return uses the previous invested settle close, not NAV at the start of the same slot. First invested day has unknown day return, with honest slippage included in total return. Existing cash-only settle history stays append-only and is excluded from control metrics. A stored settle snapshot remains a settle snapshot until recomputed by the normal engine.

## Activation remains separately gated

No portfolio mutation, hydration, model/data call, deployment, migration, reseed or account admin change was executed. The two books require owner-authorized actual inception at current prices. Do not backdate to the September seed date. Wait for a new current slot if one already has an idempotency run; do not delete run history to force a retry. Verify current prices/watchlists/cash/history again before the approved invocation, then read orders,positions,NAV and run provenance afterward.

Independent different-family review must check the exact final SQL/FK atomicity and metric filters. Required exact-head CI and authorized merge remain open; local tests are not clearance. Live functional output is unverified until approved current-price inception and subsequent marks are observed.
