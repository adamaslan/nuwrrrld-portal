# CI failure and recovery alerts

The nine workflows below share `scripts/upsert-workflow-failure-issue.sh`.
Failures retain PR 265's exact issue titles, `pipeline-failure` label and
100-result title search. An exact open match gets a repeat-failure comment;
otherwise a new issue opens. Fuzzy/near titles never match. Lookup/API errors
or malformed results abort before mutation, and issue mutation errors fail the
alert job. This builds on the P84 alarm pattern without changing which failures
these workflows detect.

| Workflow | Exact issue title | Alert event scope |
| --- | --- | --- |
| afternoon-pipeline | Afternoon pipeline failed | Existing scheduled/manual scope |
| backup-to-sqlite | Daily Neon→SQLite backup failed | Schedule only |
| compile-grounding-pack | Scheduled grounding-pack compile failed | Schedule only |
| judge-followed-tickers | Followed-tickers weekly judge failed | Existing scheduled/manual scope |
| paper-portfolios | Paper portfolios (`slot`) failed | Existing scheduled/manual scope, separate slot identities |
| precompute-ai | Nightly AI precompute failed | Schedule only |
| refresh-free-models | Weekly free-model chain refresh failed | Schedule only |
| select-followed-tickers | Followed-tickers monthly selection failed | Existing scheduled/manual scope |
| track-followed-tickers | Followed-tickers daily tracking failed | Existing scheduled/manual scope |

Recovery runs only in the same event scope, with every dependency successful.
Skipped, cancelled and explicit dry-run jobs cannot close an issue; a paper run
restricted to one account cannot prove whole-slot recovery either. Paper alerts
keep the four resolved slot titles and the existing `unresolved slot` fallback;
a resolved-slot success does not close an unresolved-slot incident.

Recovery closes an exact matching issue with a successful-run link and the
`completed` reason. Before closing, it reads the current GitHub run metadata,
verifies the run ID, attempt, workflow name, branch and event, and compares
`run_started_at` with the issue's `updatedAt`. Dates must be canonical UTC.
Issue activity at or after the run start conservatively defers closure,
including equal-second timestamps and human comments. The next eligible
success can close it. Missing/malformed metadata or an API error fails closed.
No open matching issue means no mutation and no metadata lookup.

All eight existing workflow concurrency groups remain unchanged; the refresh
workflow gains `refresh-free-models` with `cancel-in-progress: false`.
Serialization prevents concurrent alert mutations; the age guard also handles
queued runs executing out of order. This guard protects recovery from closing
a newer failure; it does not suppress an old failed run's subsequent alert.
External/manual issue writers do not participate in workflow serialization.

## Optional phone push and setup

The issue lifecycle uses the existing `GITHUB_TOKEN` with `contents: read` and
`issues: write`; recovery adds `actions: read` to each notify job. The existing
`pipeline-failure` label must be present, as before. No extra GitHub token or
application configuration is required.

Push is disabled unless the repository Actions secret `NTFY_TOPIC` is set.
Choose a private topic containing only letters, digits, underscores or hyphens
and subscribe to that topic on `https://ntfy.sh` in the ntfy client. Treat the
topic as sensitive: it is part of the notification destination. The current
integration supports public ntfy.sh topics, not authenticated/self-hosted
servers.

A push goes out only after creating a new failure issue or successfully closing
one on recovery. Repeats stay in GitHub comments, and recovery with no open issue
sends nothing. This intentionally uses outage transitions instead of the old
reference branch's every-third-comment idea, whose count included unrelated
comments. Transport errors/timeouts and invalid optional configuration produce
a warning and preserve the successful GitHub mutation. Requests have a ten
second timeout, no retry and no response-body logging.

## Local verification

All lifecycle tests replace both `gh` and `curl` with recording mocks. They cover
exact/fuzzy identity, create/comment/close/no-op, lookup/mutation errors,
malformed input/results, disabled/invalid/failing push, stale/equal timestamps,
invalid dates, and run/attempt/workflow/event/branch mismatches. The wiring test
checks all nine identities, dependency lists, permissions and concurrency groups
and evaluates 2,016 combinations of status, event, cancellation and inputs.

```sh
bash -n scripts/upsert-workflow-failure-issue.sh scripts/test-upsert-workflow-failure-issue.sh
bash scripts/test-upsert-workflow-failure-issue.sh
python3 scripts/test-workflow-alert-wiring.py
```

The Python wiring test needs Python 3 with PyYAML installed (for example `python3 -m pip install pyyaml` inside your active environment, or the mamba base environment).
Actionlint 1.7.7 also passes all nine changed workflows with optional shellcheck
and pyflakes integration disabled. No real issues or ntfy messages were used for
verification; delivery and deployed permissions remain operator setup checks.
