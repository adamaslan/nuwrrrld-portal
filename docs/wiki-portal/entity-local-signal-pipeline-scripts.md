---
date: 2026-10-15
type: entity
tags: [pipeline, alpaca, market-data, local]
sources: [../../scripts/pipeline/locrun.py, ../../scripts/pipeline/refresh-signals.py, ../../scripts/pipeline/market_data.py, ../../scripts/pipeline/alpaca_md.py, ../alpaca-wiring-status-2026-10-07.md, PR#290]
---

# Entity: Local signal pipeline scripts (`scripts/pipeline/`)

Python scripts that pull daily bars, compute signals, and push a digest to the portal cache (and Firestore, when enabled). They moved here from homebase (homebase PR #4 became PR #290), so the portal repo now owns them.

- **`market_data.py`** is the shared loader. Alpaca is the primary source; yfinance is a local-only fallback. It loads only the two Alpaca key names from the portal's `.env.local`, and falls back to the primary checkout's file when run from a worktree.
- **`alpaca_md.py`** is the Alpaca bars client. It uses the paper key pair, batches symbols, and reserves tokens from the shared DynamoDB rate budget. Without `boto3` it falls back to local pacing.
- **`locrun.py`** runs the full pipeline: fetch, analyze, Firestore, GCP3 trigger, push, HTML report. `--dry-run` writes nothing remote.
- **`refresh-signals.py`** is the lighter refresh-and-push tool.

Known gaps: the company-name column is blank (Alpaca bars carry no name), `adj_close` is split-adjusted only, and both scripts still read the sibling `gcp-app-w-mcp1/mcp-finance1` env file, which lives outside this repo.

See [[concept-free-tier-resilience]] for the wider fallback posture. Mobile is unaffected: these are laptop-only scripts, so the parity matrix does not change.
