# nwf4 Modal audit and five-minute tick candidate

2026-11-13, America/New_York. Status: review candidate only. No deployment, scheduler change, job invocation, database write, payment method or paid usage was performed for this audit.

## Decision

Reduce the dispatcher and market poller from every minute to every five minutes, and daytime news ingestion from every two minutes to every five minutes. Keep the half-hour corroboration, preview/final aggregation, labeling, backlog and Saturday evaluation slots. This trades up to four extra minutes of polling latency and three extra minutes of ingestion latency for fewer launches. It does not restore exhausted credits or establish a free operating budget. Do not deploy until the owner accepts the freshness tradeoff and account-specific credit state is verified.

## Evidence boundaries

- Owner-supplied Modal Apps snapshot at 19:10 EST names `nwf4` and `free-model-refresh`, shows the former deployed one month ago and the latter four months ago, `tick` every minute UTC, and zero displayed calls. Its call-count time window is not supplied. Zero displayed calls is NOT proof of no historical execution.
- The snapshot shows both a $1 free-credit exhaustion warning and $0.00 usage. Their scopes/windows are not established. Do not infer remaining credit, permission to add payment, or permission to run from either.
- Source inspected at portal main `470bda6cf6c6f120bd4602bcbe1d5c3f229d29fa`. `deploy/aws-modal-news/modal_app.py` defines the actual app and cron; `news_core.py` defines Eastern-time dispatch; `news_io.py` implements persistence and locks. A source schedule does not establish which commit is deployed.
- Browser audit of the supplied Apps route redirects to Modal sign-in. Workspace is owner-grounded; sign-in method/account and current live schedule revision, last attempts, execution logs and billing restrictions remain unverified. Existing authentication question remains open.
- Existing production pipeline history was read without invoking jobs. In the displayed recent table, the newest nwf4 news rows are November 2, 2026, around 11:32 EST. That table is bounded history, not proof no later run exists outside its coverage.
- `docs/modal-pipeline-status.md` is explicitly dated September 21. Its statement that only free-model-refresh is deployed is superseded by the owner's newer snapshot. It is not a current inventory. Snapshot Monday free-model-refresh also differs from current source Wednesday; deployed-source provenance must be checked, not assumed.

## Source-confirmed schedule

One UTC cron runs a dispatcher; each job's due time is calculated in America/New_York, including DST. Current source wakes 10,080 times per seven days before any child work. It ingests every two minutes on weekdays 07:00-19:59 ET and every 30 minutes otherwise. It polls once per minute during 09:30-16:00 ET inclusive, corroborates each half-hour, previews 09:20, aggregates 16:05/16:25, labels 19:00/19:30, scores backlog 17:30 and evaluates Saturday 10:00/10:30. Jobs handle trading calendars themselves. This is configured logic, not verified actual delivery timing.

### Candidate schedule, not activated

| Work | Current nominal weekly starts | Candidate nominal weekly starts |
|---|---:|---:|
| Dispatcher | 10,080 | 2,016 |
| Ingestion | 2,156 | 986 |
| Market poller | 1,955 | 395 |
| Corroboration | 70 | 70 |
| Preview aggregate | 5 | 5 |
| Final aggregate including retry | 10 | 10 |
| Label including retry | 10 | 10 |
| Backlog | 5 | 5 |
| Evaluation including retry | 2 | 2 |

Counts are a full simulated UTC week beginning November 16, 2026. They are nominal weekday dispatch counts, not holiday-adjusted calls, CPU seconds, bills or predicted savings. Every scheduled job slot is divisible by five, so changing only the cron without changing internal ingestion/poller logic would be incomplete. Both are changed together in this candidate.

## Overlap and idempotency findings

1. Ingestion timeout is 300 seconds but its current lock expires at 240 seconds. Another run may acquire the lock while the first is still executing. Candidate raises that TTL to 360 seconds, beyond the configured runtime plus a margin. Unexpected termination can defer the next attempt until expiry; this is preferable to knowingly overlapping writers.
2. Dispatcher `.spawn()` does not wait for child completion, and no dispatcher slot claim is present. Duplicate ticks can enqueue duplicate jobs. Five-minute cadence reduces opportunity; it is NOT exactly-once execution.
3. Poller timeout is 90 seconds, longer than its current 60-second interval. Its price upsert refuses older ticks but no poller single-run lock is present. Five-minute cadence leaves room for the configured timeout on normal schedules, but duplicate/manual launches remain possible.
4. Article conflict keys, cursor locking and aggregate/evaluation checks protect some writes. They do not establish all side effects are idempotent. The evaluator's existence check then insert is not a cross-process atomic claim. Ingest, FinBERT scoring and the separate backlog can still compete; prove ownership before enabling more schedules.
5. Missed exact-minute slots are not durably replayed by `due_jobs`. Daily retries cover only named operations. Do not introduce automatic catch-up/backfill as part of a cadence change. A delayed tick is not proof a job ran at the intended market time.
6. News contribution remains shadow/zero in source and does not feed current card scores. Do not sell this cadence fix as improved signal quality or quietly promote news weights.

## Credit-safe release checklist

- Resolve sign-in, inspect the owner's actual Apps/function execution history and its selected count window. Record current deployed commit/revision and latest successful output, not just container or invocation success.
- Inspect the credit/billing restriction without adding payment or starting compute. Confirm whether scheduled work is blocked and whether any free-only continuation is possible. No cost estimate can be grounded from launch counts alone, especially with FinBERT's 2 CPU/3GB/900-second function.
- Keep this PR unmerged and undeployed until current review and explicit release scope cover the latency change. Merging/deploying schedule code can trigger real cloud work; code review does not approve spend.
- Verify all jobs' cross-process idempotency and owner locks; consider durable `(job, session, slot)` claims separately, without treating proposed schema changes as authorized.
- After an authorized deployment, verify source-bound next tick, intended child, provider stage, persisted rows and consumer freshness. No "Run now" or smoke invocation is part of this audit.
- Cancellation/rollback requires a supported route. Modal's current schedule guide says removing a schedule requires redeploying the app. Never assume a pause button exists. A rollback also needs owner approval and follow-through.

## Validation

88 pure Python tests pass, including all retained schedule/rubric tests plus five-minute reachability, both aggregate/label retries, poller count and cron/lock configuration checks. Python compile and diff checks pass. No Modal import/deploy, providers, models, databases or cloud jobs were used by these tests. Tests do not prove billing eligibility, live scheduler execution or concurrent exactly-once semantics.

## Sources

- Owner-supplied Apps route: https://modal.com/apps/chillcoders/main
- Owner-supplied nwf4 tick: https://modal.com/apps/chillcoders/main/deployed/nwf4?functionId=fu-mbVDLBBiHkDEu4TdqKFHCj&activeTab=functions
- Existing production run-history page: https://financial.nuwrrrld.com/dashboard/nulogdash/pipelines
- Scheduling and logs: https://modal.com/docs/guide/cron
- Autoscaling and queue behavior: https://modal.com/docs/guide/scale
- Input concurrency: https://modal.com/docs/guide/concurrent-inputs
- General pricing, not proof of this account's remaining credit: https://modal.com/pricing
