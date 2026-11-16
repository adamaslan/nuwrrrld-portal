---
date: 2026-11-02
type: entity
tags: [pipeline, gcp, terraform, isolation]
sources: [../../infra/slots/new-pipeline, ../../infra/README.md, ../../docs/nwf-new-slot-terraform.md, PR#292]
---

# Entity — New pipeline infrastructure (historical single-slot proposal)

## Status

The single-slot `nwf-new-*` design described here was never applied. It was
superseded by the per-slot core and hydration implementation documented in
[[entity-slot2-terraform]], whose foundation was applied on 2026-10-17. The
older Terraform files are preserved in
`file-archive/pr292-infra-2026-11-02/`.

## What it is

This page records the earlier unapplied design for a separately named NWF
pipeline slot in the existing billed project. The owner chose shared-project
placement on 2026-10-16 after the dedicated project's billing quota blocked
deployment. Its single runtime identity, deploy identity, image repository,
credential containers, and Workload Identity Federation were replaced by the
per-slot resource layout in [[entity-slot2-terraform]].

The repository has immutable tags and a dry-run retention policy that keeps
two recent versions per package and proposes deleting untagged versions older
than one day. Builds must use unique tags and deploy tested digests. No image
deletion is active in this new-slot configuration.

## Where used

The historical code was in `infra/slots/new-pipeline/`; its replacement is
the current root at that path. The manual credential preflight in portal PR
#291 uses separate shadow resources in the same project.

The older secret-sync script accepted `shadow` or `new`; the current script
supports the explicit `shadow`, `hydration`, and `core` targets documented in
[[entity-slot2-terraform]].

## Known failures

The dedicated project's billing link was rejected by the account's project
quota. The original 17-create plan was superseded; see
[[entity-slot2-terraform]] for the applied foundation and current 10-create
pending plan. The manual preflight confirms two provider reads only; it does
not supply ingestion, analysis, a result ledger, or alert policies.

## Open questions

- When will independent verification and owner review clear the saved plan for apply?
- When will the pipeline worker, watchdog, and outcome contracts be implemented and tested?
- How will the shadow deployment be retired after the separate slot is proved?

## See also

[[concept-gha-cloud-parity]], [[concept-mobile-web-parity]], [[concept-sync-requirements]]
