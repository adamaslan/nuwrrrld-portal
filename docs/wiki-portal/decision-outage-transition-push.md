---
date: 2026-10-12
type: decision
tags: [ci, alerts, ntfy, recovery]
sources: [PR#271, ../pipeline-alerts.md]
---

# Push at outage transitions

## Decision

In open PR #271, optional phone push follows successful new-issue creation and
actual recovery closure. Repeated failures stay in issue comments. Push failure
does not undo or fail the authoritative issue mutation.

## Date

2026-10-12.

## Context

An older alerts branch overlaps a stronger deduplication PR. The owner chose to
layer its recovery and push value onto #265 rather than ship two issue writers.
The coordinator selected transition-only push while retaining exact workflow
identities and conservative recovery eligibility.

## Alternatives considered

Every-third-repeat push was omitted because the old implementation counted all
issue comments, including activity unrelated to consecutive failures. Treating
an unsuccessful lookup as an empty result would create duplicate outages and
was rejected. Skipped or narrow account-only runs do not prove recovery.

## Consequences

Fewer repeat notifications, with continuing outage context in GitHub. Missing
NTFY_TOPIC disables push; invalid settings or delivery failures warn after the
issue operation. Serialization and strict issue-age checks favor delayed closure
over falsely declaring a newer incident recovered.

## Validated by

Mocked lifecycle tests, 2,016 workflow condition cases and actionlint passed.
No real push or issue mutations were used. Live delivery remains unverified.

## See also

- [[entity-workflow-alert-lifecycle]]
- [[concept-sync-requirements]]
