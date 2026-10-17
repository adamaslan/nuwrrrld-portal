#!/usr/bin/env bash
# Deploy the credential preflight as a manual, read-only Cloud Run Job.
set -euo pipefail

: "${PROJECT:?Set PROJECT to the target GCP project ID}"
: "${REGION:=us-central1}"
: "${IMAGE_DIGEST:?Set IMAGE_DIGEST to the full Artifact Registry URL with @sha256:...}"
: "${RUNNER_SERVICE_ACCOUNT:?Set RUNNER_SERVICE_ACCOUNT to the slot-specific service account email}"

case "$IMAGE_DIGEST" in
  *"@sha256:"*) ;;
  *) echo "IMAGE_DIGEST must contain an immutable @sha256: digest" >&2; exit 2 ;;
esac

gcloud run jobs deploy nwf-shadow-preflight \
  --project="$PROJECT" \
  --region="$REGION" \
  --image="$IMAGE_DIGEST" \
  --service-account="$RUNNER_SERVICE_ACCOUNT" \
  --set-secrets=ALPACA_API_KEY=nwf-shadow-alpaca-api-key:latest,ALPACA_API_SECRET=nwf-shadow-alpaca-api-secret:latest,OPENROUTER_API_KEY=nwf-shadow-openrouter-api-key:latest \
  --max-retries=0 \
  --task-timeout=60s \
  --tasks=1 \
  --parallelism=1 \
  --cpu=1 \
  --memory=512Mi \
  --labels=app=nwf,slot=new-pipeline
