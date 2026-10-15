---
date: 2026-10-15
type: entity
tags: [pipeline, alpaca, market-data, local]
sources: [../../scripts/pipeline/locrun.py, ../../scripts/pipeline/refresh-signals.py, ../../scripts/pipeline/market_data.py, ../../scripts/pipeline/alpaca_md.py, ../alpaca-wiring-status-2026-10-07.md, PR#290]
---

# Entity: Local signal pipeline scripts (`scripts/pipeline/`)

## What it is

Python scripts that pull daily bars, compute signals, and push a digest to the portal cache (and Firestore, when enabled). They moved here from homebase (homebase PR #4 became PR #290), so the portal repo now owns them.

- **`market_data.py`** is the shared loader. Alpaca is the primary source; yfinance is a local-only fallback. It loads only the two Alpaca key names from the portal's `.env.local`, falling back to the primary checkout's file when run from a worktree.
- **`alpaca_md.py`** is the Alpaca bars client. It uses the paper key pair, batches symbols, and reserves tokens from the shared DynamoDB rate budget.
- **`locrun.py`** runs the full pipeline: fetch, analyze, Firestore, GCP3 trigger, push, HTML report. `--dry-run` writes nothing remote.
- **`refresh-signals.py`** is the lighter refresh-and-push tool.

## Where used

Run by hand from a laptop in the `fin-ai1` mamba env. No cloud host runs them. Mobile is unaffected, so the parity matrix does not change.

## Known failures

- The company-name column is blank (Alpaca bars carry no name).
- `adj_close` is split-adjusted only.
- `boto3` is missing in the mamba envs, so the shared rate budget falls back to local pacing.
- Both scripts still read the sibling `gcp-app-w-mcp1/mcp-finance1` env file, which lives outside this repo.

## Open questions

- Should `--output` still default to `~/Desktop`?
- Does any host other than the laptop need these scripts?

## See also

- [[concept-free-tier-resilience]]
