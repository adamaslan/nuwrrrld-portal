---
date: 2026-10-10
type: concept
tags: [github-actions, modal, gcp, ci, scheduling, retries, parity]
sources: [../gha-tests-and-cloud-parity.md, ../../.github/workflows, ../../.github/actions/market-gate/action.yml, ../../.github/scripts/portal-post.sh, ../../deploy/modal-backend/modal_app.py]
---

# Concept — GitHub Actions as a Peer of Modal and GCP

## The pattern

The portal's scheduled work runs on three hosts: GitHub Actions (live, the de facto owner of most pipelines), Modal (`aws-modal-news` live, [[entity-modal-backend]] built but never deployed), and gcp3's Cloud Scheduler. Modal and GCP got reliability primitives built in: timezone-aware cron, retries with backoff, an idempotency ledger, heartbeats. GHA had none of them, and it does most of the work.

The parity effort brings those primitives to GHA without moving ownership:

- **Retries that respect writes.** Every portal POST goes through one helper with Modal's retry curve (3 tries, 10 s, ×2, 60 s cap). It retries only failures where the request cannot have reached the route: connect errors and 429/502/503. A timeout, 500 or 504 may mean the route ran, and these routes write paper orders and council verdicts, so those failures surface immediately.
- **A calendar, not a weekday check.** A composite action asks Alpaca's market calendar whether today is an NYSE session. The three trading gates use it, so a weekday holiday no longer passes. It fails open: a calendar outage defers to the old weekday gate rather than cancelling a slot.
- **The Modal code is tested where it's merged.** CI now runs the Modal backend's Postgres-backed suite and the news pipeline's suite. A test keeps CI's dependency file identical to the Modal image's inline list.
- **GHA as Modal's "run now" button.** A dispatch workflow can `modal run` any listed Modal function from the merged code. It needs a Modal service token in GitHub secrets before it can run.

## Where it appears

- `.github/scripts/portal-post.sh`, used by afternoon-pipeline, track/judge/select-followed-tickers, paper-portfolios and precompute-ai.
- `.github/actions/market-gate`, used by the afternoon-pipeline, track-followed-tickers and paper-portfolios gates. select-followed-tickers deliberately runs on the 1st whatever the weekday.
- `ci.yml` jobs `modal-python` and `workflow-lint`; `live-smoke.yml`; `modal-run.yml`.
- [[entity-paper-portfolios]] gained a workflow-level `dry_run`, since the route has none.

## Contradictions / tensions

- **The biggest gap is still open.** GHA cron started 168–234 minutes late on the 22:30 UTC hydration (Oct 3–9), and nothing here fixes on-time start. That needs an external clock (Modal or Cloud Scheduler calling `workflow_dispatch`), which in turn needs a PAT and a shared idempotency ledger (`job_runs`) so the clock and the GHA cron can't double-run. Neither is built.
- **Green runs that never did anything.** Dispatching every workflow on 2026-10-10 showed that the afternoon pipeline's first route returns 404. Its scheduled runs only looked healthy because the gate skipped them: the late start put the NY hour past 15. See [[decision-afternoon-pipeline-cron-split]]. A run that skips is reported as success, so "8/8 green" said nothing about whether the pipeline works.
- **Alpaca is metered nowhere in GHA.** The market-data rule requires reserving `nwf_rate_budget` tokens. GHA's hydrate, engine and live-price scripts don't, and the new calendar call adds one more unmetered request per gate.

## See also

- [[entity-modal-backend]] · [[entity-nwf4-news-pipeline]] · [[entity-paper-portfolios]] · [[concept-test-strategy]] · [[concept-signal-engine-host-parity]]
- `docs/gha-tests-and-cloud-parity.md`: the full inventory, test plan, run log and implementation status.
