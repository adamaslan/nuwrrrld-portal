#!/usr/bin/env bash
#
# One-shot Modal deploy for the FREE_MODEL_CHAIN refresh.
# Run from the repo root inside the `modal1` mamba env AFTER `modal token new`.
#
#   mamba run -n modal1 bash deploy/free-model-refresh/deploy-modal.sh
#
# Reads the two secrets from the environment (source them; never paste inline):
#   set -a; . ./.env.local; set +a           # provides OPENROUTER_API_KEY
#   export GH_TOKEN="$(gh auth token)"        # push credential
set -euo pipefail

: "${OPENROUTER_API_KEY:?source .env.local first}"
: "${GH_TOKEN:?export GH_TOKEN=\"\$(gh auth token)\" first}"

echo "==> Creating/replacing Modal secret 'free-model-refresh'"
modal secret create free-model-refresh \
  "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" \
  "GH_TOKEN=${GH_TOKEN}" \
  --force

echo "==> Deploying weekly cron app"
modal deploy deploy/free-model-refresh/modal_app.py

echo "==> Done. Trigger a one-off run with:  modal run deploy/free-model-refresh/modal_app.py"
