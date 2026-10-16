# NWF new-pipeline GCP deployment

The [reviewed architecture](../docs/nwf-new-slot-terraform.md) calls for a
parallel slot. `slots/new-pipeline` is its Terraform root. It creates only
new-slot identity, image, artifact, and empty credential containers. It does
not manage `current`, deploy an application, publish data, change schedules,
or route production traffic.

## Verified local connections (2026-10-15)

- The current `gcp3-backend` Cloud Run service is in `ttb-lang1`.
- `gcp3/backend/cloudbuild.yaml` builds that service in the existing
  `cloud-run-source-deploy` Artifact Registry repository. This root does not
  import or change either resource.
- This portal already has `ALPACA_API_KEY`, `ALPACA_API_SECRET`, and
  `OPENROUTER_API_KEY` in its local environment and GitHub Actions secrets.
  Values were not printed during inventory or sync. The runtime maps
  `ALPACA_API_SECRET` to its own Secret Manager container; it never assumes
  the proposed `ALPACA_SECRET_KEY` name exists.
- The live backend references an `OPENROUTER_API_KEY` Secret Manager secret.
  The Terraform foundation declares distinct empty containers for a future
  dedicated project. The temporary shadow deployment uses distinct secret
  containers in the billed `ttb-lang1` project, with versions copied from
  the portal's local environment via `sync-shadow-secrets.mjs`.

## Cloud deployment status

The dedicated project `nwf-new-pipeline-20261015` was created but billing
linkage failed because the available billing account reached its project
quota. No Terraform was applied to that project.

For an immediate cloud proof, a separate Artifact Registry repository,
service account, three Secret Manager secrets, and a manual Cloud Run Job
were created in `ttb-lang1`. The image came from
[portal PR #291](https://github.com/adamaslan/nuwrrrld-portal/pull/291) and was deployed by immutable digest.
Execution `nwf-shadow-preflight-w85gh` finished successfully with sanitized
`alpaca=ok openrouter=ok` status. The job has no schedule and writes no NWF
data. It is a credential and deployment smoke check; the isolated production
slot still requires a billed dedicated project or a revised isolation design.

## Deployable foundation

1. Choose a dedicated, existing GCP project with billing enabled. Record its
   ID and the actual current production project ID in a local, ignored
   `terraform.tfvars` based on `terraform.tfvars.example`. The IDs must differ.
2. Bootstrap a **pre-existing** versioned GCS state bucket with restricted
   access. The GCS backend cannot create its own bucket. Put its name in a
   local, ignored `backend.hcl` based on `backend.hcl.example`; keep the
   `nwf/new-pipeline/terraform` prefix distinct from every other state.
3. Confirm the trusted GitHub repository and owner numeric IDs, default
   branch, region, bucket name, project APIs, permissions, and billing.
4. From `infra/slots/new-pipeline`, run:

   ```bash
   terraform fmt -check -recursive ../../
   terraform init -backend-config=backend.hcl -input=false
   terraform validate
   terraform plan -out=phase1.tfplan
   terraform show phase1.tfplan
   ```

   Review the whole plan for deletion, replacement, IAM scope, and project
   identity before an authorized `terraform apply phase1.tfplan`. The backend
   uses state locking and bucket versioning for recovery. Never commit state,
   plans, backend configuration, or populated tfvars.

The foundation grants GitHub's trusted numeric repository ID on the chosen
branch permission to impersonate only the new deploy service account. That
service account can write only the new image repository. The runtime identity
can read only the new slot's three secret containers. No identity receives a
role on the current project's resources. Cloud Run, Firestore, scheduling,
monitoring, and application code remain to be connected after the target
project and state ownership are verified.

## Local checks already run

`terraform init -backend=false`, `terraform validate`, and
`terraform fmt -check -recursive infra` succeeded with Terraform 1.5.7 and
Google provider 7.46.1. This checks configuration shape only; it does not
verify a cloud plan, provider permissions, or application behavior.
