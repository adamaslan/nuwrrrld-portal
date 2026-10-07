---
date: 2026-10-07
type: entity
tags: [modal, backend, postgres, dynamodb, alpaca, council, paper-trading, pipeline]
sources: [../../deploy/modal-backend/SESSION-SUMMARY.md, ../../deploy/modal-backend/modal_app.py, ../nuwrrrld-modal-architecture.md]
---

# Entity — Modal Backend (`deploy/modal-backend`)

## What it is

A Python backend meant to run the Modal-side half of the product: the evening market pipeline, the AI Council and paper trading, Followed Tickers scoring, billing and referral jobs, and a FastAPI service. The web app stays on Vercel; nothing here replaces the Next.js app. Postgres is the system of record. Every job also mirrors its rows into DynamoDB (a failed mirror is logged and never fails a job), and DynamoDB additionally holds live prices, the shared Alpaca rate budget, a short-lived cache and locks.

Shape: about 60 modules and 37 Modal functions, each a thin wrapper over plain, unit-tested Python in `nuwrrrld/jobs/entrypoints.py`. Market data follows the Alpaca-first order (yfinance only on local hosts). Idempotency comes from a `(job_name, run_key)` claim in `job_runs`.

Status at ingest: **written and tested, never deployed.** The suite passes against a real local Postgres and mocked AWS and HTTP. No Modal, real AWS, live Alpaca, LLM, Stripe or Clerk call has ever been made.

## Where used

- Spec: `docs/nuwrrrld-modal-architecture.md`. Operator notes and the remaining human-only setup are in the folder's `SESSION-SUMMARY.md`.
- Related: [[entity-ticker-universe-pipeline]] (the existing hydration lane), [[incident-2026-08-18-modal-under-recommended]] (zero Modal apps in this repo have ever been deployed), [[decision-afternoon-pipeline-cron-split]] (current scheduling split this would eventually absorb).

## Known failures

- **Run-key claim and skip interact badly for multi-fire crons.** A job that fires on several days under one key (the weekly council fires Thu and Fri under one ISO-week key) must decide "should I act today?" *before* claiming the key. A recorded skip counts as done, so the later run sees `not_claimed`. Found by the first real run of the ops tests; fixed by checking before the claim.
- **Default-argument `time.sleep` is invisible to test patches.** Entry points bound the real sleep at import, so a test that patched `time.sleep` still waited minutes. Now resolved at call time. The same trap is worth checking in any new polling code here.
- Entrypoints that pass a date to a helper must pass their own `today`; one helper read the real clock instead.

## Open questions

> ❓ Open question: council strategies are still the spec's placeholders, so every real session ends "consensus: flat" and no orders are created until real strategies are registered.

> ❓ Open question: should the DynamoDB mirror stay write-only, or become a read path for anything? It is unmeasured against the free-tier write cap, and a large backfill will throttle it.

> ❓ Open question: the evening stages are fixed cron slots that poll each other. Chaining them on success and starting ingest earlier is proposed but unmeasured. Alpaca SIP bar finality timing needs a live check first.

> ⚠️ Contradiction: [[incident-2026-08-18-modal-under-recommended]] records that no Modal app in the repo has been deployed. That is still true, and this backend does not change it: until a `modal deploy` to a staging environment succeeds, treat every claim above as local-only evidence.

## See also

- [[concept-signal-engine-host-parity]] — a second engine host means a fourth place the signal rules could drift; the backend's rule engine has no parity test against the existing three yet
- [[decision-modal-backend-skip-before-claim]]
