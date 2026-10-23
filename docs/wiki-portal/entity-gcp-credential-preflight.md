---
date: 2026-10-15
type: entity
tags: [gcp, pipeline, alpaca, openrouter, credentials]
sources: [../../deploy/new-pipeline/preflight.mjs, ../../deploy/new-pipeline/Dockerfile, ../../deploy/new-pipeline/build-image.sh, ../../deploy/new-pipeline/deploy-job.sh, PR#291, homebase-PR#8]
---

# Entity — GCP credential preflight

## What it is

A manual Cloud Run Job that checks whether the pipeline's existing Alpaca and
OpenRouter credentials work from GCP. It makes one bounded read of the latest SPY daily bar
and one OpenRouter current-key metadata read, then logs only `ok`,
`missing_credentials`, or `request_failed` per provider. It does not call an
LLM, publish data, or schedule itself. The first shadow execution succeeded;
that proves credential reachability for these two calls, not pipeline health.

## Where used

`deploy/new-pipeline/` builds from a two-file context, so portal `.env` files
cannot enter the image upload. The job runs under a dedicated identity with
access to three slot-specific Secret Manager secrets. The initial deployment
uses the existing billed GCP project. The owner later chose that same project
for the separately named new slot after dedicated-project billing was blocked.
See [[concept-gha-cloud-parity]] for the wider execution and observation
boundary. Portal PR #292 records the unapplied Terraform foundation.

## Known failures

- Deploy needs the three Secret Manager secrets to exist and the runner identity
  to hold Secret Accessor on each; secret and job names are overridable.

- Billing-project quota blocked the separate project's billing linkage, and
  the selected shared-project slot does not establish project-level isolation.
- The hydration script used to depend on an AWS DynamoDB Alpaca budget; that
  budget was removed on 2026-10-20 ([[decision-no-shared-alpaca-budget]]). This preflight deliberately does not
  run that script; it makes one manual vendor read only.
- A passing key check does not establish Alpaca feed entitlement for other
  feeds, OpenRouter model availability, rate budget, output validity, or
  downstream publication.

## Open questions

- Which billed project or quota increase will host the isolated slot?
- Nothing coordinates Alpaca's minute limit across pipelines now ([[decision-no-shared-alpaca-budget]]). Does the
  future GCP worker need its own pacing to stay under it?

## See also

- [[entity-ticker-universe-pipeline]] — the existing Alpaca hydration path
- [[concept-mobile-web-parity]] — this operational job does not change client parity
- [[concept-sync-requirements]] — no mobile port is required for the preflight
