---
date: 2026-07-24
type: entity
tags: [backtest, signals, real-data, track-record, disabled-by-default]
sources: [../../lib/backtest.ts, ../../app/api/backtest/[symbol], ../../components/TrackRecordBadge]
---

# Entity — Backtest Engine Client

## What it is

`lib/backtest.ts` — the client for a **separate** signals-app FastAPI backend
that returns historical hit-rate data per symbol (`BacktestResult`: `by_category`
and `by_strength` buckets, each with `hits` / `total` / `hit_rate`, plus
`bars_scanned` and `horizon_days`). It answers "when this kind of signal fired on
this ticker before, how often was it right?"

Two properties define it:

- **A different engine than the live digest.** The digest/Hold-Fold path talks to
  the gcp3 backend ([[entity-signal-data-plane]]); the backtest talks to
  `SIGNALS_ENGINE_URL`. They are not otherwise connected.
- **Disabled by default.** If `SIGNALS_ENGINE_URL` is unset, `fetchBacktest`
  returns `null` immediately — "we never hardcode a URL we haven't confirmed is
  live." Every failure mode (unset, timeout, non-2xx, bad JSON, wrong shape)
  collapses to the same `null`, so a missing backtest never crashes the page.
  This is [[concept-cache-then-degrade]] / [[concept-graceful-degradation]] in
  its purest form: a nice-to-have that is invisible when absent.

## Where used

- `components/TrackRecordBadge` — rendered on the primary signal card in
  `SignalsClient` and behind the "View full ticker page & backtest track record"
  link in `HoldFoldClient`'s detail panel.
- `app/api/backtest/[symbol]` — the route that proxies `fetchBacktest`.
- The per-ticker Hold/Fold page `app/dashboard/holdfold/[ticker]`.

## Known failures

1. **Silent absence in production.** Because the engine is disabled unless
   `SIGNALS_ENGINE_URL` is set, the track-record UI is currently dark in most
   deploys — users see the signal but not its historical hit-rate. This is
   correct-by-design but easy to mistake for a bug.
2. **No caching.** Every badge render is a live 8 s-timeout round-trip; there is
   no Neon L2 in front of it the way Hold/Fold has one.

## Open questions

- ❓ Should backtest results be cached in Neon (same pattern as
  [[entity-holdfold-cache]]) and refreshed on the weekly cron, so the track
  record survives even when the live engine is down?
- ❓ Is the backtest engine the right home for a Modal/GCP-hosted vectorized
  backtest job (see the app-robustness suggestions), or should its results be
  precomputed into the grounding pack?
- ❓ `period=2y` is hardcoded in the fetch URL — no caller can request a
  different window.

## See also

- [[entity-signal-data-plane]] — the *other*, live signal engine (gcp3)
- [[entity-holdfold-cache]] — the cache pattern a backtest cache would copy
- [[concept-graceful-degradation]] — "one hard dependency"; backtest is a zero
- [[decision-compile-time-grounding]] — precompute-vs-request-time, the same
  tension a cached backtest raises
