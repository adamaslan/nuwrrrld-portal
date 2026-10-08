---
date: 2026-10-07
type: entity
tags: [tooling, python, finnhub, alpaca, streamlit, parity]
sources: [../../tools/nwf-lab/README.md, ../../docs/nwf-lab-finnhub-streamlit-plan.md, PR#235]
---

# Entity: nwf-lab (`tools/nwf-lab/`)

## What it is

A local, read-only Python package that re-expresses the portal's data and analysis features as pure functions, so they can be run from one command, explored in Streamlit, or poked at in a notebook. It is dev tooling: nothing in the deployed portal imports it.

Beyond the portal-mirroring features it adds `ichimoku` (cloud/Tenkan-Kijun/Chikou scoring) and `fib` (swing-based retracement and extension levels); both rules are lab-defined. Inputs can be dragged into the app as CSVs (tickers, positions) or a saved bundle.

The design rule is a hard split between fetching and computing. Providers fill a serializable `DataBundle`; every feature is a pure function of `(bundle, config)`. That is why moving a config slider, editing a price, or applying a scenario recomputes everything with zero vendor calls, and why a saved bundle replays byte-identically offline.

Data sources follow [[concept-free-tier-resilience]] reasoning: Finnhub supplies quotes, profile, metrics, analyst trends, earnings, insiders, peers and news; daily bars come from Alpaca (yfinance fallback on the laptop only) because Finnhub's candle, sentiment and price-target endpoints are premium. Those gaps surface as `vendor_gap` results, never as quiet wrong answers.

## Where used

- `run_all.py` CLI (writes `results.json`, `summary.html`, the bundle), the Streamlit app (explains each tab and config field), and a jupytext notebook source.
- Feature slugs are aligned with `docs/nulogdash-inventory.json`; the run summary reports how many inventory entries are out of scope.
- `analyze` is parity-tested against `homebase/locrun.py:analyze()`, so the lab and the local signal pipeline cannot drift unnoticed.

## Known failures

- Live run verified once (3 tickers: Finnhub fundamentals, Alpaca bars); a 157-ticker live run takes ~20+ minutes cold at the 1 req/s Finnhub pace.
- holdfold, portfolio scoring and the paper engine are lab-defined or simplified ports (the portal's holdfold and backtest routes only proxy other services), so their numbers will not match the portal's.
- Alpaca pacing is local; it does not draw from the shared cross-pipeline rate budget.
- Streamlit's headless test harness segfaults on any second script run in this environment (reproduced with a five-line script); the app was verified through a single-run render instead.

## Open questions

> ❓ Open question: should the lab replace `homebase/locrun.py` once parity holds, with its Firestore and portal-push steps behind explicit flags?

> ❓ Open question: should paper-engine policy constants move to a shared JSON file so the TypeScript and Python engines cannot drift?

## See also

- `docs/nwf-lab-finnhub-streamlit-plan.md` for the full design
- [[entity-backtest-engine]]
- [[entity-paper-portfolios]]
