#!/usr/bin/env bash
#
# Deploy the FREE_MODEL_CHAIN refresh as a GCP Cloud Run Job + weekly Cloud
# Scheduler trigger. Idempotent — safe to re-run. No local Docker needed
# (image is built by Cloud Build).
#
# Prereqs (secrets — provisioned separately):
#   gcloud secrets create openrouter-api-key   --data-file=- <<< "$OPENROUTER_API_KEY"
#   gcloud secrets create free-model-gh-token   --data-file=- <<< "$GH_TOKEN"
#   (GH_TOKEN pushes the refreshed chain; grant the job SA secretAccessor on both.)
#
# Then: PROJECT=ttb-lang1 bash deploy/free-model-refresh/deploy-gcp.sh
set -euo pipefail

PROJECT="${PROJECT:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${REGION:-us-central1}"
JOB="${JOB:-free-model-refresh}"
SCHEDULE="${SCHEDULE:-0 9 * * 1}"          # Mondays 09:00
IMAGE="${IMAGE:-gcr.io/${PROJECT}/${JOB}:latest}"
DOCKER_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$DOCKER_DIR/../.." && pwd)"

echo "==> Project=$PROJECT Region=$REGION Job=$JOB Image=$IMAGE"

echo "==> Building image with Cloud Build (context = repo root, so Dockerfile can COPY scripts/run-refresh-remote.sh)"
gcloud builds submit "$REPO_ROOT" \
  --config "$DOCKER_DIR/cloudbuild.yaml" \
  --substitutions "_IMAGE=${IMAGE}" \
  --project "$PROJECT"

echo "==> Deploying Cloud Run Job"
gcloud run jobs deploy "$JOB" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT" \
  --tasks 1 --max-retries 1 --task-timeout 600 \
  --set-secrets "OPENROUTER_API_KEY=openrouter-api-key:latest,GH_TOKEN=free-model-gh-token:latest"

echo "==> Creating/updating weekly Cloud Scheduler trigger"
SA="$(gcloud run jobs describe "$JOB" --region "$REGION" --project "$PROJECT" \
        --format='value(template.template.serviceAccount)')"
if [[ -z "$SA" ]]; then
  # A Job deployed without an explicit --service-account uses the project's
  # default compute SA, but `describe` returns an empty string for that case
  # rather than the resolved email — resolve it ourselves or Scheduler
  # creation below fails/misconfigures.
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
  SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
  echo "==> Job has no explicit service account; falling back to default compute SA: $SA"
fi
RUN_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"

if gcloud scheduler jobs describe "${JOB}-weekly" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "${JOB}-weekly" --location "$REGION" --project "$PROJECT" \
    --schedule "$SCHEDULE" --uri "$RUN_URI" --http-method POST \
    --oauth-service-account-email "$SA"
else
  gcloud scheduler jobs create http "${JOB}-weekly" --location "$REGION" --project "$PROJECT" \
    --schedule "$SCHEDULE" --uri "$RUN_URI" --http-method POST \
    --oauth-service-account-email "$SA"
fi

echo "==> Done. Run once now:  gcloud run jobs execute $JOB --region $REGION --project $PROJECT"
