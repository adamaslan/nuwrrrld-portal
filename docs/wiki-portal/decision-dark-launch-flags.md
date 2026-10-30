---
date: 2026-10-30
type: decision
tags: [flags, dark-launch, paper-trading, track-record, council, news]
sources: [../../lib/flags.ts, ../../__tests__/flags.test.ts, PR#316]
---

# Decision: Hide Wrong-Number Surfaces Behind Constant Dark-Launch Flags

## Decision

Surfaces that show wrong or unverified numbers are gated by a `flagLive(name)` check in `lib/flags.ts`. Each flag has one of three modes (`off`, `shadow`, `live`) and every flag starts `off`. The five flags in place are `backtest_hit_rates`, `paper_benchmark_metrics`, `holdfold_top_movers`, `news_vote` and `council_public_demo`. Flags are constants in code, not env vars. `__tests__/flags.test.ts` pins them all to `off`, so promoting one means editing the flag and its test in the same reviewed PR.

## Date

2026-10-30

## Context

The 2026-10-27 dashboard audit found users reading numbers that were fake or broken: ten dev-seed hit-rate rows, benchmark controls that never invested, a holdfold feed 15 days stale with price 0, a news vote missing from every confluence score, and a public council demo that returned chain-of-thought. Hiding them is quicker and safer than fixing each one first, and the same flag later lets a fixed path run in `shadow` before it goes `live`.

## Alternatives considered

- **Fix each surface first.** Slower, and users keep seeing wrong numbers while the fixes land.
- **Env or Edge Config store.** Lets ops flip a flag without a deploy, but needs server-side reads, and client components could not import it directly. Deferred until the shadow runner needs it.
- **Delete the surfaces.** Loses the working UI that the fixed data will need again.

## Consequences

- Hidden surfaces show a dash or a short note ("News not included") rather than disappearing silently. Trading and data writes keep running.
- The gates sit at the render and route layer only. The arena rank still uses Sharpe and vs SPY internally, and the council grounding query still reads `backtest_hit_rates`.
- Hiding the top-movers strip also hides the TOP MOVERS links whose target 404s in production. The 404 itself is not fixed.
- A flag read on the client is a build-time constant, so a promotion needs a deploy.

> ❓ Open question: whether mobile shows any of these five surfaces. This wiki does not cover the mobile app, so the parity pages record the question rather than an answer.

## Validated by

Typecheck, lint and 20 related test files pass. Not yet viewed in a browser, and Codex verification is pending (PR #316).

## See also

- [[entity-paper-portfolios]] — the benchmark metrics and arena columns this hides
- [[entity-backtest-engine]] — the hit-rate source behind the track-record badge
- [[entity-holdfold-cache]] — the stale feed behind the top-movers strip
- [[entity-ai-council]] — the public demo seat
- [[concept-mobile-web-parity]] — the cross-surface effect
