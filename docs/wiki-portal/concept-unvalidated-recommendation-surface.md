---
date: 2026-09-15
type: concept
tags: [signals, scoring, validation, risk, sector, universe, recommendations]
sources: [../stock-recommendation-deficiencies.md, ../risk-off-rotation.html, ../../lib/backtest.ts, ../../lib/shared/paper-policy.ts, ../../lib/shared/paper-sectors.ts, ../../lib/shared/paper-engine-core.ts, ../../lib/db/schema.sql, PR#143]
---

# Concept — The Unvalidated Recommendation Surface

## The pattern

The portal produces **recommendation-shaped output** — a BUY/HOLD/SELL action, a
0–100 score, a ranked top-N — from a layer that contains no validation, no
fundamentals, and no risk model. The indicator math is sound; what is missing is
everything that would convert an indicator reading into a defensible
recommendation.

Established by a full 933-ticker scan on 2026-09-15 (929 resolved) plus a
codebase audit. Three properties define the gap:

- **The score is four booleans wide.** `50 + (bullish − bearish) × 12.5` over
  RSI > 55, MACD histogram > 0, price > SMA20, volume > 1.2×. That yields only
  nine reachable values, so 24 stocks tied at a perfect 100 and any "top 10" is
  decided by a tiebreak rather than by the model. All four inputs carry equal,
  unfitted weight.
- **Nothing measures whether the score predicts anything.**
  [[entity-backtest-engine]] is the only validation surface and is disabled by
  default, so no hit rate or forward-return study backs any action label.
- **No fundamentals or risk layer exists at all.** A word-boundary audit for
  `earnings`, `peRatio`, `marketCap`, `revenue`, and `fcf` across `lib/` and
  `app/` returns zero files. Sizing and stops are likewise absent — the three
  apparent matches are an analytics event name, a conversation-topic label, and
  an `ATR` mention inside a comment.

The distinguishing feature of this pattern is not absence but **the appearance of
presence**: the vocabulary of rigor exists in the codebase (a `sectorCapPct`, a
`position_size` string, a backtest client, a `volatilityPercentile`) while the
capability behind each does not.

## Where it appears

- **Sector caps enforced against data that mostly does not exist.**
  `lib/shared/paper-policy.ts` sets `sectorCapPct` per account (0.15–0.35) and
  `lib/shared/paper-engine-core.ts:178` actively enforces it. The only sector
  source is `lib/shared/paper-sectors.ts`, a hand-maintained literal covering
  176 tickers — **18.9% of the 933-symbol active universe**. `ticker_universe`
  has no sector column at all ([[entity-ticker-universe-pipeline]]).
  `lib/portfolio-health-policy.ts:128` already states the consequence: *"only
  `etf`/`stock`, not sector, so genuine sector concentration is invisible."*
- **Silent upstream degradation.** The scan's Finnhub sentiment endpoint
  returned 403 for every symbol and gcp3 `/refresh` returned 401, yet the run
  reported `Done. 929 signals` — indistinguishable from a clean run. A scan
  missing its entire sentiment input still presents as success. This is
  [[concept-graceful-degradation]] applied past its useful limit: degrading
  gracefully is correct for a *nice-to-have* badge, and wrong for an input the
  output is framed as incorporating.
- **A universe that is a portfolio, not an index.** Per
  `docs/universe-by-industry.md` the registered set is a Yahoo portfolio export
  unioned with a partial large-cap seed, with no index-membership column. So
  breadth figures describe that book and cannot be reproduced against a
  benchmark.
- **Unfiltered liquidity.** No dollar-volume or market-cap floor, so a $4
  microcap ranked beside a $430 large cap in the same top-10 with no size
  guidance.

## Contradictions / tensions

> ⚠️ Contradiction: `paper-policy.ts` and `paper-engine-core.ts` implement a
> sector cap as an enforced risk control; `paper-sectors.ts`'s own header
> concedes it is "a best-effort GICS-style classification… not a guaranteed
> exact match," and it covers under a fifth of the universe. The control reads
> as enforced and is unenforceable for the remainder. Unresolved.

> ⚠️ Contradiction: [[concept-graceful-degradation]] argues that a missing
> optional input should collapse to a quiet `null` rather than crash. Applied to
> a *declared* scoring input this produces a run that silently scores nothing on
> sentiment while reporting success. The two need a boundary: degrade for
> decoration, fail loudly for inputs. Unresolved.

> ❓ Open question: which direction should share-class notation canonicalize?
> `ticker_universe` stores the dot form (`BRK.B`, matching Alpaca) while Yahoo
> requires a hyphen. `normalizeTicker` accepts both and canonicalizes neither,
> so `BRK.B`/`BRK-B` and `BF.B`/`BF-B` are each registered as two rows for one
> security. Canonicalizing is a data-plane key change touching enqueue, drain,
> and the watchlist route, so it was deliberately left out of PR #143.

> ❓ Open question: does engine coherence imply engine validity? All twelve
> inverse/leveraged ETF mirror pairs in the universe resolved opposite as they
> mechanically must — which proves the indicators are not reading noise, and
> proves nothing about whether the score predicts returns. Coherence was the
> only property this scan could establish without a backtest.

## See also

- `docs/stock-recommendation-deficiencies.md` — the ranked ten, each with a
  verified reproduction command
- `docs/risk-off-rotation.html` — the scan this came from
- [[entity-backtest-engine]] — the disabled validation surface
- [[entity-ticker-universe-pipeline]] — where the sector column is missing
- [[entity-paper-portfolios]] — the sector cap that cannot be enforced
- [[entity-signal-data-plane]] — where action labels are served from
- [[concept-graceful-degradation]] · [[concept-three-state-signal]]
