# Tracker workflow schedule map (T-142)

Source audit: current workflow and route files on `main`, checked 2026-11-16.
This map describes declared schedules and bounded run evidence, not a guarantee
of timely delivery, successful providers, complete data receipts or hydration.
No workflow, cron, timezone, market gate or runtime setting changes in this PR.

## The three tracker workflows

| Workflow | Declared schedule | Declared local time, not guaranteed start time | Gate | Calls | Intended route effect |
| --- | --- | --- | --- | --- | --- |
| `select-followed-tickers.yml` | `0 14 1 * *`, no timezone override | First of month, 14:00 UTC = 09:00 EST / 10:00 EDT | No separate market-hours gate in the workflow | `POST /api/pipeline/followed-tickers-select` | Selects and freezes up to 10 bulls and 10 bears; missing entry prices can underfill the cohort |
| `track-followed-tickers.yml` | `30 16 * * 1-5`, `timezone: America/New_York` | Weekdays, 16:30 New York = 21:30 UTC in EST / 20:30 UTC in EDT | Confirmed NYSE trading day, New York weekday and wall time after confirmed session close; scheduled cron literal also checked | `POST /api/pipeline/followed-tickers` | Daily observations for existing picks and resolution of due horizons; actual field completeness depends on source/provider results |
| `judge-followed-tickers.yml` | `0 16 * * 6`, no timezone override | Saturday, 16:00 UTC = 11:00 EST / 12:00 EDT | No separate market-hours gate in the workflow | `POST /api/pipeline/followed-tickers-judge` | Weekly grading of eligible verdicts and gold-set checks; a green workflow alone does not prove all grades are populated |

Logical dependency: monthly **select** freezes the cohort, daily **track**
observes its existing picks, weekly **judge** consumes eligible verdict evidence.
These separate cron declarations do not enforce a dependency chain or prove
that selection ran before every daily observation. Inspect actual run and data
receipts before claiming that ordering or complete coverage.

## Timezone semantics and the prior incorrect premise

Current official [GitHub workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
says schedules default to UTC and may optionally specify an IANA timezone.
Its example places `timezone: "America/New_York"` beside `cron` in a schedule
entry. The track workflow uses that supported form. Its declared time is
therefore **16:30 New York**, not 16:30 UTC. It is post-close on an ordinary
16:00 New York session and later than an early close; the market gate still
checks the actual trading day and session close at execution.

The previous version of this document incorrectly called the timezone key
inert, converted the track cron as UTC, and proposed changing it on that basis.
That premise and recommendation are withdrawn. An old repo comment saying
GitHub cron is UTC-only is not authoritative over current platform syntax.
Likewise, do not call the timezone entries in other workflows inert merely
because older comments or this document once said so.

PR #386 is a separate, unmerged scheduling proposal. This documentation repair
neither approves nor requires it. Changing a cron while retaining its New York
timezone can change the intended local hour, so any scheduling proposal needs
its own current semantic and effect review. No schedule change is needed to
correct this document's false UTC-only claim.

## Bounded run evidence

A fresh read of the track workflow's latest 12 run records on 2026-11-16 shows
schedule-triggered runs with green workflow conclusions. The newest listed run
is still [43541498880](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/43541498880),
created and started at `2026-11-14T01:35:30Z`. This is **20:35:30 EST on November
13**, not the cron's declared 16:30 New York time. That establishes an observed
late start for this run, not why it started then or when GitHub first queued it.

Additional real run records, UTC created/start timestamps:

- `2026-11-13T02:01:39Z`: [43349161958](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/43349161958)
- `2026-11-12T02:23:35Z`: [43141078652](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/43141078652)
- `2026-11-11T01:22:17Z`: [42938463858](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/42938463858)
- `2026-11-10T03:42:41Z`: [42751190057](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/42751190057)
- `2026-11-07T01:03:21Z`: [42321891929](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/42321891929)

[Workflow history](https://github.com/adamaslan/nuwrrrld-portal/actions/workflows/track-followed-tickers.yml)
is a run inventory, not the database receipt ledger. The latest known response
for run 43541498880 reported `scored: 23`, `degraded: 23`,
`backtest_engine: false`. HTTP success and a green wrapper do not establish
complete signal/backtest/Council fields, populated Judge history or every-day
data delivery. No new production data check was performed for this doc repair.

GitHub documents that scheduled events can be delayed under load and even
queued jobs can be dropped. Those are platform caveats, not a proven diagnosis
of the observed start times here. Separate declared due time, event creation,
run start, individual job/step times and persisted data receipts. Do not infer
zero queue delay from equal created/start fields or infer an ignored timezone
from a late run. The execution gate protects the pre-close condition; it does
not guarantee that a run occurs, writes every field or covers a missing day.

## Related workflow context

- `afternoon-pipeline.yml`: currently `workflow_dispatch` only. Header comments
  can lag implemented route availability, so verify the routes rather than
  treating an old "not shipped" comment as runtime truth.
- `paper-portfolios.yml`: has its own schedule/timezone and market-gate rules;
  inspect those independently, without inheriting the withdrawn inert-key claim.
- `signal-freshness-check.yml`: `0 13 * * 1-5` without a timezone override,
  13:00 UTC = 08:00 EST / 09:00 EDT; runs the local card-freshness script.

## Sources and release boundary

- Official syntax: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- Official schedule caveats: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- `.github/workflows/select-followed-tickers.yml`, `track-followed-tickers.yml`,
  `judge-followed-tickers.yml`, `afternoon-pipeline.yml`,
  `paper-portfolios.yml`, `signal-freshness-check.yml`
- `app/api/pipeline/followed-tickers-select/route.ts`,
  `app/api/pipeline/followed-tickers/route.ts`,
  `app/api/pipeline/followed-tickers-judge/route.ts`

Prior rejection and its independent-review escalation remain in force. This is
a docs-only accuracy repair, not authorization to trigger a workflow, change
cron/config, call providers or models, write a database, or merge a scheduler.
