---
date: 2026-08-11
type: decision
tags: [analyze, holdfold, backend, cloud-run, env]
sources: [../../app/api/analyze/route.ts, ../../lib/env.ts, ../../lib/shared/analyze-policy.ts]
---

# Decision — Point `/api/analyze` at holdemfoldem-api, Not gcp3-backend

## Decision

The new `POST /api/analyze` route (per-ticker live trade-plan analysis, exposed
on `app/dashboard/holdfold/[ticker]`) calls a **new, separate** upstream —
`MCP_ANALYZE_URL`, pointing at `holdemfoldemapp`'s `holdemfoldem-api` Cloud Run
service — rather than extending `gcp3-backend`, the service
[[entity-holdfold-cache]] and [[entity-signal-data-plane]] already call via
`MCP_BACKEND_URL`.

## Date

2026-08-11

## Context

Portal's existing `/api/holdfold` route derives Hold/Fold verdicts from
`gcp3-backend`'s **batch** `/signals` endpoint — every tracked symbol at once,
mapped client-side in `lib/shared/holdfold-map.ts`. There is no per-ticker
`/analyze` endpoint on `gcp3-backend`.

`holdemfoldemapp` (a separate, already-deployed app) has exactly the endpoint
needed: `POST /api/analyze` on `holdemfoldem-api`, accepting a full request
(symbol, period, risk profile, options legs, position lots) and returning a
verdict with trade plan, Fibonacci levels, and options Greeks — none of which
`gcp3-backend` currently computes.

## Alternatives considered

| Option | Cost | Rejected because |
|---|---|---|
| **A. Point at `holdemfoldem-api`** (chosen) | Lowest — one new env var + one route | Two backends in prod for portal; accepted as the cost of shipping now |
| **B. Add `/api/analyze` to `gcp3-backend`** | Medium — port the analysis stack (trade plan, Fibonacci, options payoff) into gcp3 | Correct long-term target, but blocks the feature on a backend port that hadn't started |
| **C. Merge `holdemfoldem-api` and `gcp3-backend`** | Highest | Right eventual shape, wrong first move — a merge should follow proof the feature is wanted, not precede it |

## Consequences

- Portal now depends on **two** Cloud Run services for signal-shaped data:
  `gcp3-backend` (batch `/signals`, `/industry-intel`) and `holdemfoldem-api`
  (per-ticker `/api/analyze`). Their verdict semantics are not guaranteed to
  agree — `gcp3-backend`'s `ai_action` → Hold/Fold mapping
  ([[entity-holdfold-cache]]) and `holdemfoldem-api`'s own verdict logic are
  independently derived.
- `/api/analyze` fails closed and names the specific cause when
  `MCP_ANALYZE_URL` is unset (`503`, "Analysis backend not configured") rather
  than silently defaulting to a hardcoded URL like `/api/holdfold` does for
  `MCP_BACKEND_URL` — deliberate, since a bad default here would point
  production traffic at someone's `localhost`.
- Per-ticker results are cached separately (`analyze_cache`, keyed on
  `(symbol, period, asset_type, risk_profile)` — see
  [[entity-holdfold-cache]]) from the batch `holdfold_cache`, since they're
  answering different questions with different staleness tolerances.
- Option B remains open. If per-ticker analysis proves popular, the next step
  is porting the trade-plan/Fibonacci/options logic into `gcp3-backend` and
  retiring `MCP_ANALYZE_URL`, not merging the services outright.

## Validated by

Not yet — `MCP_ANALYZE_URL` is unset in production as of this PR;
`/api/analyze` returns a clear 503 until it's configured. No live traffic has
exercised the holdemfoldem-api path yet.

## See also

- [[entity-holdfold-cache]] — the existing `gcp3-backend`-backed cache this sits
  alongside, not on top of
- [[entity-disclaimer-system]] — gates the UI surface (`app/dashboard/holdfold/[ticker]`)
  that calls this route
- `holdemfoldemapp/backend/main.py` — the `AnalyzeRequest`/`HoldFoldVerdict`
  shape this route proxies to (cross-repo, link by path per [[SCHEMA]])
