---
date: 2026-10-24
type: entity
tags: [terraform, gcp, slot2, infra, workload-identity]
sources: [../../infra/slots/new-pipeline/main.tf, ../../infra/slots/new-pipeline/hydration.tf, ../../infra/slots/new-pipeline/monitoring.tf, ../../infra/README.md, PR#309, PR#292]
---

# Entity — Slot 2 Terraform

## What it is

The single Terraform root (`infra/slots/new-pipeline/`) that owns the shape of
the slot 2 pipeline's GCP footprint. It is the only Terraform for NWF; the
older mobile OAuth and legacy MCP configs are dead (the OAuth resource type
does not exist in the Google provider).

It builds one set of resources per slot with `for_each` over two slots, `core`
and `hydration`: runtime, observer and deploy service accounts, a Docker
Artifact Registry repo with immutable tags, a versioned artifacts bucket, a
GitHub Workload Identity pool and provider, and empty Secret Manager
containers with accessor bindings for the runtime identity only. A project
guard precondition refuses to plan against any project other than the approved
one.

Terraform creates secret *containers* only. Values are loaded out of band with
`infra/sync-shadow-secrets.mjs` or the secrets-sync skill, so no secret value
is ever in state or in a plan.

## State and how it got here

Remote state lives in a versioned GCS bucket. The foundation was applied on
2026-10-17 from an uncommitted worktree, so for a week the live infra had no
code on `main`. PR #309 lands that code; PR #292 carried an earlier
single-slot design that was never applied and is superseded.

A read-only plan against the live state shows only additive changes: the
hydration database-URL containers and their bindings, the scheduler identity,
three service APIs and alert notification channels.

## Where used

Read by whoever applies slot infrastructure: the hydration worker's image, secrets
and schedules are all declared here. GitHub Actions deploys reach GCP through
the per-slot Workload Identity provider, which admits one repository on the
main branch only and is bound to the deploy identity.

## Gated parts

The hydration Cloud Run job and its three weekday schedulers (open, midday,
close, New York time) are defined but created only when a tested image digest
is supplied. Until then the count is zero, so a scheduled run can never start
a job with no image.

## Known failures

- Applies so far have run from a laptop with no CI plan, so drift would go
  unnoticed.
- The local Terraform is 1.5.7; a newer version's first apply upgrades the
  state format and 1.5.7 can no longer read it.
- A PR plan run cannot use the existing GitHub provider, which admits only the
  main branch; CI planning needs a separate read-only identity.

## Not managed

Slot 1 (the hand-built legacy backend and its scheduler jobs), the temporary
`nwf-shadow-*` smoke-test resources, two data buckets, Modal, Neon, Clerk,
Vercel and DNS. Slot 1 is to be retired, not imported.

## Open questions

> ❓ Open question: should the shared project be split from slot 1 once slot 1
> is paused? Owner decision, not yet made.

> ❓ Open question: the 10 pending additive changes are not applied yet; they
> need owner approval of the saved plan.

## See also

[[entity-gcp-credential-preflight]] — the manual credential check that preceded
this foundation and whose shadow resources are due for retirement.
[[concept-gha-cloud-parity]] — the other place where cloud hosts and CI diverge.
