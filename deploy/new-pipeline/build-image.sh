#!/usr/bin/env bash
# Build the preflight image without uploading the portal repo or .env*.
# Usage: PROJECT=... IMAGE=REGION-docker.pkg.dev/PROJECT/REPOSITORY/IMAGE:TAG ./build-image.sh
set -euo pipefail

: "${PROJECT:?Set PROJECT to the GCP project ID}"
: "${IMAGE:?Set IMAGE to the separate Artifact Registry image URL}"

deploy_dir="$(cd "$(dirname "$0")" && pwd)"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT

cp "$deploy_dir/Dockerfile" "$context/Dockerfile"
cp "$deploy_dir/preflight.mjs" "$context/preflight.mjs"

gcloud builds submit "$context" \
  --config "$deploy_dir/cloudbuild.yaml" \
  --substitutions "_IMAGE=$IMAGE" \
  --project "$PROJECT"
