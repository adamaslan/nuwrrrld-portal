---
date: 2026-10-20
type: entity
tags: [ci, alerts, recovery, ntfy]
sources: [../../scripts/upsert-workflow-failure-issue.sh, ../pipeline-alerts.md, PR#265, PR#271]
---

# Workflow alert lifecycle

## What it is

The shared CI issue writer uses an exact workflow title and the pipeline-failure
label to keep an outage in one issue. PR #271 merged on 2026-10-13, extending
the deduplication base in #265 with recovery close and optional push. The writer
accepts both the canonical title and the legacy title with a trailing ISO date;
it selects the oldest matching legacy issue when no canonical title exists.

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

The October 20 grounding-pack run exposed a false recovery: run #39418102712
concluded green after 40 model calls even though 37 extraction calls failed,
only 8 rules were extracted, and 198 chunks were deferred by the per-run call
budget. The recovery job closed #203 while the same-title #268 stayed open.
This code change makes any live extraction failure exit nonzero after preserving
successful chunks, so the failure notification runs instead of recovery. Budget
deferrals remain resumable and do not independently mark a run failed.

## Open questions

GitHub run history confirms successful SQLite backup, AI precompute, paper
portfolios and followed-ticker tracking. Grounding pack is not fully recovered:
the October 20 run was green only because the compiler tolerated partial
extraction errors; the recovery job closed legacy issue #203 and the October 19
run similarly closed #193. Issue #268 remains open. The new exit condition
addresses the false-green path, but a later clean full compile is still needed
before closing #268.
Hydration remains an active failure: scheduled run #39523318736 failed and
appended a repeat-failure comment to open issue #282. This verifies failure
deduplication and issue delivery for that workflow, while the underlying
hydration failure still needs diagnosis.
Optional ntfy delivery depends on repository setup; destination values are never
recorded in this wiki. No historical issue bulk cleanup is included.

## See also

- [[decision-outage-transition-push]]
- [[concept-mobile-web-parity]]
- [[concept-sync-requirements]]
- [[entity-ticker-universe-pipeline]]
