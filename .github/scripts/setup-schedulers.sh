#!/usr/bin/env bash
# Set up GCP Cloud Scheduler jobs and GitHub Actions secrets for the
# NuWrrrld portal pipeline. Run once from the repo root after cloning.
#
# Prerequisites:
#   gcloud auth login && gcloud config set project <PROJECT_ID>
#   gh auth login
#   CRON_SECRET env var must be set before running this script.
#
# Usage:
#   CRON_SECRET=<value> bash .github/scripts/setup-schedulers.sh

set -euo pipefail

PORTAL_URL="https://financial.nuwrrrld.com"
GCP_REGION="us-east1"
GCP_PROJECT="$(gcloud config get-value project 2>/dev/null)"
REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"

: "${CRON_SECRET:?CRON_SECRET must be set}"

echo "==> GCP project : ${GCP_PROJECT}"
echo "==> GitHub repo : ${REPO}"
echo "==> Portal URL  : ${PORTAL_URL}"
echo ""

# ── GCP Cloud Scheduler ────────────────────────────────────────────────────

echo "--- GCP Cloud Scheduler jobs ---"

# Helper: create or update a scheduler job
upsert_job() {
  local NAME="$1"; shift
  if gcloud scheduler jobs describe "$NAME" --location="$GCP_REGION" \
       --project="$GCP_PROJECT" &>/dev/null; then
    echo "  updating ${NAME}"
    gcloud scheduler jobs update http "$NAME" "$@" \
      --location="$GCP_REGION" --project="$GCP_PROJECT"
  else
    echo "  creating ${NAME}"
    gcloud scheduler jobs create http "$NAME" "$@" \
      --location="$GCP_REGION" --project="$GCP_PROJECT"
  fi
}

# Open check — 10:15 AM ET (market days)
upsert_job nuwrrrld-open-check \
  --schedule="15 10 * * 1-5" \
  --time-zone="America/New_York" \
  --uri="${PORTAL_URL}/api/signals/refresh" \
  --message-body='{"session":"open"}' \
  --headers="Authorization=Bearer ${CRON_SECRET},Content-Type=application/json" \
  --attempt-deadline=4m

# Main briefing — 12:15 PM ET (market days)
upsert_job nuwrrrld-main-briefing \
  --schedule="15 12 * * 1-5" \
  --time-zone="America/New_York" \
  --uri="${PORTAL_URL}/api/briefing/run" \
  --message-body='{"session":"main"}' \
  --headers="Authorization=Bearer ${CRON_SECRET},Content-Type=application/json" \
  --attempt-deadline=10m

# Post-close scorer — 4:30 PM ET (market days)
upsert_job nuwrrrld-post-close-scorer \
  --schedule="30 16 * * 1-5" \
  --uri="${PORTAL_URL}/api/verdicts/score" \
  --message-body='{"session":"post-close"}' \
  --headers="Authorization=Bearer ${CRON_SECRET},Content-Type=application/json" \
  --attempt-deadline=8m

echo ""
echo "--- GCP jobs status ---"
gcloud scheduler jobs list --location="$GCP_REGION" --project="$GCP_PROJECT"

# ── GitHub Actions secrets ─────────────────────────────────────────────────

echo ""
echo "--- GitHub Actions secrets ---"

gh secret set PORTAL_URL   --repo "$REPO" --body "$PORTAL_URL"
gh secret set CRON_SECRET  --repo "$REPO" --body "$CRON_SECRET"

echo ""
echo "--- Secrets now in ${REPO} ---"
gh secret list --repo "$REPO"

# ── Smoke-test: dry run of the afternoon workflow ──────────────────────────

echo ""
echo "--- Triggering dry-run of afternoon-pipeline ---"
gh workflow run afternoon-pipeline.yml \
  --repo "$REPO" \
  --field skip_market_check=true \
  --field dry_run=true

echo ""
echo "Watch it at:"
gh run list --repo "$REPO" --workflow=afternoon-pipeline.yml --limit 1 \
  --json url -q '.[0].url'

# ── Reference: manual-trigger and monitoring commands ─────────────────────

cat <<'EOF'

=== Useful day-to-day commands ===

# Trigger afternoon pipeline manually (skip weekend gate, log-only)
gh workflow run afternoon-pipeline.yml \
  --field skip_market_check=true --field dry_run=true

# Trigger in real mode (writing enabled, weekday-only gate active)
gh workflow run afternoon-pipeline.yml \
  --field skip_market_check=false --field dry_run=false

# Watch the latest run
gh run watch --repo <REPO> $(gh run list --workflow=afternoon-pipeline.yml --limit 1 --json databaseId -q '.[0].databaseId')

# Download artifacts from a run
gh run download <RUN_ID> --repo <REPO> --dir /tmp/pipeline-artifacts

# List GCP scheduler jobs
gcloud scheduler jobs list --location=us-east1

# Manually fire a GCP scheduler job (e.g. to test before market hours)
gcloud scheduler jobs run nuwrrrld-main-briefing --location=us-east1

# Pause / resume a GCP job
gcloud scheduler jobs pause  nuwrrrld-main-briefing --location=us-east1
gcloud scheduler jobs resume nuwrrrld-main-briefing --location=us-east1
EOF
