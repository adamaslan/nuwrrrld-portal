---
date: 2026-10-15
type: entity
tags: [pipeline, gcp, terraform, isolation]
sources: [../../infra/slots/new-pipeline, ../../infra/README.md, ../../docs/nwf-new-slot-terraform.md, PR#292]
---

# Entity — New pipeline infrastructure

## What it is

An unapplied Terraform root for a separate NWF pipeline slot. It defines a runtime identity, a deploy identity, an image repository, empty credential containers, and repository-scoped Workload Identity Federation. The reviewed design and operational gates are in `docs/nwf-new-slot-terraform.md`.

## Where used

`infra/slots/new-pipeline/` owns the proposed resources. `infra/README.md` gives the setup and validation sequence. The manual credential preflight in portal PR #291 uses isolated resources in the existing billed project while the dedicated project lacks billing capacity.

## Known failures

The dedicated project's billing link was rejected by the account's project quota. No cloud Terraform plan or apply has run. The manual preflight confirms two provider reads only; it does not supply ingestion, analysis, a result ledger, or alerts.

## Open questions

- Which billed project and versioned state bucket will own the isolated slot?
- When will the pipeline worker, watchdog, and outcome contracts be implemented and tested?
- How will the shadow deployment be retired after the separate slot is proved?

## See also

[[concept-gha-cloud-parity]], [[concept-mobile-web-parity]], [[concept-sync-requirements]]
