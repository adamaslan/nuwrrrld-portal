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
  the proposed `ALPACA_SECRET_KEY` name exists. Secret containers follow the
  env var names: `nwf-new-alpaca-api-key`, `nwf-new-alpaca-api-secret`,
  `nwf-new-openrouter-api-key` (dedicated project) and the matching
  `nwf-shadow-*` names in `ttb-lang1`.
- The live backend references an `OPENROUTER_API_KEY` Secret Manager secret.
  The Terraform foundation declares distinct empty containers for a future
  dedicated project. The temporary shadow deployment uses distinct secret
  containers in the billed `ttb-lang1` project, with versions copied from
  the portal's local environment via `sync-shadow-secrets.mjs` with the
  explicit `shadow` slot argument.

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

### Shadow resources in `ttb-lang1` (temporary, not in Terraform)

These were created by hand inside the **current production project** and are
not covered by the isolation guard. They hold copies of the Alpaca and
OpenRouter credentials. Treat them as temporary and remove them once the
dedicated project is billed and applied:

| Resource | Name |
|---|---|
| Cloud Run Job | `nwf-shadow-preflight` |
| Artifact Registry repository | the separate shadow repository created for the job |
| Service account | the shadow runtime service account |
| Secrets | `nwf-shadow-alpaca-api-key`, `nwf-shadow-alpaca-api-secret`, `nwf-shadow-openrouter-api-key` |

Inventory (read-only; expect the rows above and nothing else with `nwf-shadow`):

```bash
gcloud run jobs list --project=ttb-lang1 --filter='metadata.name~nwf-shadow' --format='value(metadata.name)'
gcloud secrets list --project=ttb-lang1 --filter='name~nwf-shadow' --format='value(name)'
gcloud artifacts repositories list --project=ttb-lang1 --filter='name~nwf' --format='value(name)'
gcloud iam service-accounts list --project=ttb-lang1 --filter='email~nwf' --format='value(email)'
```

Teardown is destructive (the secrets lose their only copy in that project;
the source of truth stays in the portal env). Run it only after confirming the
inventory above, and with the owner's go-ahead:

```bash
gcloud run jobs delete nwf-shadow-preflight --project=ttb-lang1 --region=us-central1 --quiet
for s in nwf-shadow-alpaca-api-key nwf-shadow-alpaca-api-secret nwf-shadow-openrouter-api-key; do
  gcloud secrets delete "$s" --project=ttb-lang1 --quiet
done
```

Then delete the shadow Artifact Registry repo and service account found by the
inventory. `sync-shadow-secrets.mjs` leaves a secret that already has an
enabled version unchanged, so a rotated key is not copied; add a new version
by hand to rotate.

After the dedicated project's Terraform foundation is applied, populate its
empty secret containers with Node.js 20.12 or newer:

```bash
node infra/sync-shadow-secrets.mjs .env.local nwf-new-pipeline-20261015 new
```

The script requires the slot and its matching project ID, checks for existing
enabled versions, and does not print credential values. The temporary shadow
slot uses `ttb-lang1 shadow` instead. Do not run either command before its
secret containers exist.

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

The new image repository has immutable tags. Builds must use a unique tag for
each image, and deployments must pin the tested digest. Its cleanup policy is
in dry-run mode: it retains the two newest versions per package and proposes
deleting untagged versions older than one day. Review the dry-run findings
before allowing deletion; tagged historical images are outside that delete
rule. The artifact bucket and credential containers retain `prevent_destroy`;
rollback needs an explicit reviewed Terraform change before removing them.

## Local checks already run

`terraform init -backend=false`, `terraform validate`, and
`terraform fmt -check -recursive infra` succeeded with Terraform 1.5.7 and
Google provider 7.46.1. This checks configuration shape only; it does not
verify a cloud plan, provider permissions, or application behavior.
