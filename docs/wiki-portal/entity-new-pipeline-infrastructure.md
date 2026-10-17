---
date: 2026-10-15
type: entity
tags: [pipeline, gcp, terraform, isolation]
sources: [../../infra/slots/new-pipeline, ../../infra/README.md, ../../docs/nwf-new-slot-terraform.md, PR#292]
---

# Entity — New pipeline infrastructure

## What it is

An unapplied Terraform root for a separately named NWF pipeline slot in the existing billed project. The owner chose the shared-project placement on 2026-10-16 after the dedicated project's billing quota blocked deployment. It defines a runtime identity, a deploy identity, an image repository, empty credential containers, and repository-scoped Workload Identity Federation. The current design and operational gates are in `docs/nwf-new-slot-terraform.md`.

The repository has immutable tags and a dry-run retention policy that keeps
two recent versions per package and proposes deleting untagged versions older
than one day. Builds must use unique tags and deploy tested digests. No image
deletion is active in this new-slot configuration.

## Where used

`infra/slots/new-pipeline/` owns the proposed resources and pins the project to `ttb-lang1`. `infra/README.md` gives the setup and validation sequence. The manual credential preflight in portal PR #291 uses separate shadow resources in that same project.

`infra/sync-shadow-secrets.mjs` now requires an explicit `shadow` or `new`
target and checks that it matches the expected project before copying only
missing credential versions. The new slot remains empty until its
Terraform foundation has been reviewed and applied.

## Known failures

The dedicated project's billing link was rejected by the account's project quota. A local preview plan for the shared-project root showed 17 creates, zero changes, and zero destroys; the remote state bucket and cloud apply are still pending. The manual preflight confirms two provider reads only; it does not supply ingestion, analysis, a result ledger, or alerts. Same-project placement shares administrators, API enablement, billing, and quotas with the running backend.

## Open questions

- When will the proposed versioned state bucket be created and a remote plan reviewed?
- When will the pipeline worker, watchdog, and outcome contracts be implemented and tested?
- How will the shadow deployment be retired after the separate slot is proved?

## See also

[[concept-gha-cloud-parity]], [[concept-mobile-web-parity]], [[concept-sync-requirements]]
