---
date: 2026-10-12
type: entity
tags: [ci, alerts, recovery, ntfy]
sources: [../../scripts/upsert-workflow-failure-issue.sh, ../pipeline-alerts.md, PR#265, PR#271]
---

# Workflow alert lifecycle

## What it is

The shared CI issue writer uses an exact workflow title and the pipeline-failure
label to keep an outage in one issue. Open PR #271 extends the deduplication
base in #265 with recovery close and optional push; neither PR is represented
here as deployed.

## Where used

Nine notify jobs: afternoon, SQLite backup, grounding compiler, weekly judge,
paper portfolios, AI precompute, free-model refresh, monthly selection and daily
tracking. Paper uses separate slot identities. Existing failure event scopes
remain in place; recovery requires successful dependencies, excludes dry runs
and partial account-only paper runs, and uses the same scope.

## Known failures

API lookup, malformed data and issue mutation errors stop the alert job rather
than creating duplicates. Recovery checks its run identity and requires issue
activity to be strictly older than that run. Newer human comments can defer
closure. Old failed runs can still add failure comments; unrelated external
writers do not participate in workflow serialization.

## Open questions

Deployed actions-read/issue-write permissions and optional push delivery still
need validation after merge. NTFY_TOPIC is optional; destination values are never
recorded in this wiki. No historical issue bulk cleanup is included.

## See also

- [[decision-outage-transition-push]]
- [[concept-mobile-web-parity]]
- [[concept-sync-requirements]]
- [[entity-ticker-universe-pipeline]]
