---
date: 2026-09-11
type: decision
tags: [portfolio, health-score, degradation, ticker-cards, gcp3, cross-repo]
sources: [../../lib/shared/portfolio-health-policy.ts, ../../lib/portfolio-health-local.ts, ../../app/api/portfolio/health/route.ts, ../../app/api/portfolio/suggestions/route.ts]
---

# Decision — Score the portfolio locally instead of waiting for gcp3

## Decision

The portal computes its own portfolio health score and optimizer suggestions
from `ticker_cards`, and treats `{gcp3-backend-url}/api/portfolio/health` as a
**preferred optimisation rather than a dependency**. Upstream is still called
first and still wins when it answers with a valid payload; every other outcome
— unreachable, non-2xx, or a 200 whose shape isn't the contract — falls
through to the local scorer.

The watchlist is the portfolio. Coverage is reported to the user but excluded
from the score. A watchlist where not one ticker has a computed card returns
503 with its own copy, not a number.

## Date

**2026-09-11.**

## Context

`/api/portfolio/health` had never once succeeded. The upstream route was never
registered on gcp3 — confirmed four times over 47 days, most recently against
the backend's own OpenAPI, which lists ~35 paths and no portfolio path among
them. Full history in
[[incident-2026-07-26-portfolio-health-endpoint-missing]].

The gcp3-side fix was written on 2026-07-26 and was still undeployed. That is
the fact that forced this decision: the portal cannot deploy gcp3, so every
day of "the fix is ready" was a day the panel stayed dead, and continuing to
wait was a choice being made by nobody.

The unlock was noticing the portal already had the data. `ticker_cards`
([[entity-ticker-universe-pipeline]]) carries a deterministic, reproducible
score in [-100, 100] plus a BUY/HOLD/SELL action for every ticker in the
registered universe — ~932 of them. It was built to rank a discovery feed, not
to score a portfolio, but a watchlist is a subset of the universe and the same
cards answer the question. The dependency was never on gcp3's *data*; it was on
gcp3's *endpoint*.

## Alternatives considered

- **Keep waiting for the gcp3 deploy.** The status quo, and the thing that had
  already failed for 47 days. Costs nothing to continue and delivers nothing;
  its real cost is that it looks like progress on a ticket board.
- **Deploy gcp3 from this session.** Out of scope and out of this repo. It also
  wouldn't address the structural problem, only this instance of it — the next
  cross-repo endpoint would be equally fragile.
- **Write the adapter and wait.** The incident documents the field-name drift
  (`ai_grade` vs `score`) in detail, so a correct adapter was writable. But an
  adapter for a route that does not exist is unrunnable code, and the local
  scorer made it unnecessary: a drifted payload is now simply *not a payload*
  and routes to the fallback.
- **Score from `signal_cache` instead of `ticker_cards`.** `signal_cache` is
  per-ticker, read-through, and populated on demand — it held 5 rows at the
  time of this decision. `ticker_cards` covers the whole universe. Using the
  demand-side cache would have made coverage a function of who happened to
  have browsed what.
- **Fold coverage into the score.** Rejected deliberately. A portfolio with 3 of
  20 tickers covered would score low, and "we don't know" would render as "this
  is bad" — a re-run of the exact Grade-F-for-everyone trap this incident is
  about, one layer up. Coverage is a reported factor with `impact: neutral`.

## Consequences

- **The panel works, and mobile's does too.** `gcp3-mobile`'s
  `lib/usePortfolio.ts` calls the portal route, so its Portfolio tab is fixed
  with no mobile change — the payoff of the portal owning the contract.
- **The number now means something different**, and says so. It is the portal's
  own signal engine over the watchlist, not gcp3's analyzer, and the response
  carries `X-Portfolio-Health-Source` so the surface can label it. An
  unlabelled substitute engine would be the same silent swap that made the
  original outage invisible; mobile does not yet read the header, which is a
  recorded gap.
- **A new, quiet coupling.** Portfolio health now depends on the hydration
  pipeline staying alive. That pipeline has already been dead for 15 days once
  ([[incident-2026-09-03-nightly-hydration-dead-15-days]]), and a frozen
  `ticker_cards` would degrade this score without erroring. The failure mode
  moved rather than vanished — from "route missing, loudly" to "cards stale,
  quietly." Nothing flags card age yet.
- **Upstream can come back without a code change.** If gcp3 ever registers the
  route, it resumes winning automatically and the liveness test logs the
  switch instead of silently changing what it measures.
- **The weights are unvalidated.** 0.45 signal / 0.30 direction / 0.25
  diversification is reasoned, not fitted. Shipping an unvalidated heuristic is
  defensible only because the alternative on offer was no score at all — that
  trade should be revisited, not inherited.

## Validated by

- `__tests__/portfolio-health-policy.test.ts` — pure scorer: ordering
  (strong/broad/BUY > weak/narrow/SELL), quality-weighting without dropping
  cards, factor bounds, and that coverage never depresses the score.
- `__tests__/live/portfolio-health.live.test.ts` — the real path against real
  Neon. Asserts invariants, never a score; the cards change nightly.
- Observed 2026-09-11: 936-ticker watchlist → 74 / Grade C, 932 covered;
  10-ticker watchlist → 71 / Grade C, 7 covered.
- `e2e/frontend/portfolio-health.spec.ts` — the local-source result renders with
  its provenance label, and 503 renders as "no signals computed" rather than a
  generic outage.

## See also

- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — the 47-day outage this closes
- [[entity-portfolio-intelligence]] — the surface
- [[entity-ticker-universe-pipeline]] — where the cards come from
- [[concept-graceful-degradation]] — the terminal-honest-state rule this satisfies
- [[concept-cache-then-degrade]] — the stale-serve-without-visible-age tension it inherits
- [[decision-second-analyze-backend]] — the other case of routing around gcp3 rather than through it
