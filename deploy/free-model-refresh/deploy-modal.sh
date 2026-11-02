#!/usr/bin/env bash
#
# One-shot Modal deploy for the read-only FREE_MODEL_CHAIN health check.
# Run from the repo root inside the `modal1` mamba env AFTER `modal token new`.
#
#   mamba run -n modal1 bash deploy/free-model-refresh/deploy-modal.sh
#
# Reads the three secrets from the environment (source them; never paste inline):
#   set -a; . ./.env.local; set +a           # provides OPENROUTER_API_KEY
#   GH_TOKEN must be a separately provisioned token with repository contents:read.
#   Export that read-only GH_TOKEN before running this script.
#   export NTFY_TOPIC=nwf-...                 # ntfy alert topic
set -euo pipefail

: "${OPENROUTER_API_KEY:?source .env.local first}"
: "${GH_TOKEN:?export a separately provisioned read-only GH_TOKEN with contents:read first}"
: "${NTFY_TOPIC:?export NTFY_TOPIC first}"

echo "==> Creating/replacing Modal secret 'free-model-refresh'"
modal secret create free-model-refresh \
  "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
  "GH_TOKEN=${GH_TOKEN}" \
  "NTFY_TOPIC=${NTFY_TOPIC}" \
  --force

echo "==> Deploying weekly cron app"
modal deploy deploy/free-model-refresh/modal_app.py

echo "==> Done. Trigger a one-off run with:  modal run deploy/free-model-refresh/modal_app.py"
