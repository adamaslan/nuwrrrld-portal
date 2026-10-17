# New slot credential preflight

This Cloud Run Job image makes two bounded read-only requests:

- One SPY daily-bar request to Alpaca's IEX historical bars API.
- One authenticated OpenRouter current-key metadata request. It does not call
  a model or spend credits.

It reports only `ok`, `missing_credentials`, or `request_failed` for each
provider and exits nonzero unless both checks pass. It does not contact the
portal, use AWS, write production data, or schedule itself.

Build into the new slot's separate Artifact Registry repository:

```sh
PROJECT=your-project \
IMAGE=us-central1-docker.pkg.dev/your-project/new-slot/preflight:phase1 \
bash deploy/new-pipeline/build-image.sh
```

The build script uploads only `Dockerfile` and `preflight.mjs`. Supply
`ALPACA_API_KEY`, `ALPACA_API_SECRET`, and `OPENROUTER_API_KEY` through the Cloud
Run Job environment or Secret Manager at deployment time. Do not put them in
the image. Deploy the immutable image with `deploy-job.sh`:

```sh
PROJECT=your-project \
IMAGE_DIGEST=us-central1-docker.pkg.dev/your-project/new-slot/preflight@sha256:... \
RUNNER_SERVICE_ACCOUNT=nwf-shadow-runner@your-project.iam.gserviceaccount.com \
bash deploy/new-pipeline/deploy-job.sh
```

The job has no schedule. Run it manually with
`gcloud run jobs execute nwf-shadow-preflight --project=your-project
--region=us-central1 --wait` and check the sanitized status in Cloud Logging.

On 2026-10-15 the first image was built and a manual execution succeeded in
the existing `ttb-lang1` project (`alpaca=ok openrouter=ok`). The dedicated
new-slot project could not be billed because the billing account's project
quota was exhausted. This is a credential and deployment smoke check, not a
production pipeline or evidence of new-slot data isolation.
