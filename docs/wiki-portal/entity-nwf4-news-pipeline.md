---
date: 2026-10-08
type: entity
tags: [news, modal, dynamodb, finbert, alpaca, shadow, pipeline]
sources: [../../deploy/aws-modal-news/modal_app.py, ../../deploy/aws-modal-news/news_core.py, ../../deploy/aws-modal-news/news_io.py, ../../lib/db/schema.sql, PR#feat/nwf4-news-jobs]
---

# Entity — nwf4: the news-scoring pipeline (4th pipeline)

## What it is

A Modal app (`nwf4`, `deploy/aws-modal-news/`) that turns Alpaca news into one
point-in-time `news_score` per ticker per session, measures how well that score
predicts returns, and decides — weekly — whether it has earned a weight in the
card score. Three files, split so the logic is testable without a network:

- `news_core.py` — pure functions only: story clustering (64-bit SimHash),
  the lexicon scorer, the ensemble, §6.4 aggregation, labeling, rank-IC / hit
  rate / decile / Brier metrics, the weight state machine, and `due_jobs()`.
  Covered by an offline test suite.
- `news_io.py` — Alpaca (shared rate budget), Finnhub (corroboration only),
  DynamoDB stores, Neon helpers.
- `modal_app.py` — the seven jobs plus a dispatcher.

**Jobs:** ingest → score → corroborate → aggregate (16:05 ET final, 09:20
preview) → label outcomes → weekly accuracy eval, plus a one-minute live-price
poller. **One cron, not seven:** only `tick` is scheduled; it asks
`due_jobs()` what is due in America/New_York and spawns it, because Modal's
Starter plan caps cron schedules. Each job is idempotent, so the retry slots
(16:25, 19:30, Saturday 10:30) are safe.

**It changes no card.** The news weight is 0 by design. The evaluator appends
`shadow` rows to `confluence_news_weights`; nothing reads that table yet, and
the four new `ticker_cards` columns are NULL on every row.

Neon tables: `news_articles`, `news_article_symbols`, `news_article_scores`,
`news_ticker_scores`, `news_score_outcomes`, `news_accuracy`,
`confluence_news_weights`. DynamoDB (cursors, dedupe, locks, budget, live
prices) holds nothing a metric is computed from.

## Where used

- Writes `live_prices` (the poller) — a second writer next to the Finnhub
  feeder; see [[entity-live-price-tier]]. Its upsert carries the same
  never-overwrite-a-newer-tick guard.
- Logs every run to `pipeline_run_log` (pipelines `news-*`), so
  [[entity-nulogdash]] can show a gap rather than a silent success.
- Reads `ticker_universe` and `daily_bars` ([[entity-signal-engine]]).

## Known failures

- **Labeling cannot run yet.** `daily_bars` holds 12 IEX bars for SPY and no
  SIP bars; the labeler fails closed and says so in the run log.
- **The gate cannot pass.** ΔIC needs card history, and `ticker_cards` keeps
  only the latest card per ticker, so the evaluator records ΔIC as NULL and
  the gate fails on a missing metric. Absent is not passing.
- **The scoped IAM user has no `DeleteItem`.** Locks are released by setting
  `expires_at` to 0, not by deleting the row.
- **Benchmark is SPY for every ticker;** no ticker-to-sector-ETF map exists.
- **The lexicon is a curated subset** of Loughran-McDonald, and the scorer-weight
  re-fit is recorded as a proposal only; neither creates a new `scorer_version`.
- The LLM scorer (`llm_v1`) is off by owner decision.

## Open questions

> ❓ Open question: where should card history for ΔIC live — a `ticker_cards_history` table, or recompute from `daily_bars`?
> ❓ Open question: SIP daily bars for SPY and the universe are a prerequisite for any accuracy number; which job backfills them?

## See also

- [[entity-live-price-tier]], [[entity-nulogdash]], [[entity-signal-engine]]
- [[concept-three-state-signal]] — `absent` vs `neutral` vs directional is the same rule applied to news
- Design: `docs/fin-api-and-4th-aws-modal-pipeline.md` (§5.1, §6–§9, §10.1b); not committed because it holds account identifiers
