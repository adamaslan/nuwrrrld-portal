#!/usr/bin/env bash
# Push secrets from .env.local to GitHub Actions repo secrets.
#
# Values are piped file -> gh directly. Nothing is echoed, and no value ever
# passes through a chat session. Run from the repo root.
#
#   ./scripts/push-github-secrets.sh          # push the local-backed set
#   ./scripts/push-github-secrets.sh --dry    # show what would be pushed
set -euo pipefail

ENV_FILE=".env.local"
DRY="${1:-}"

# Secrets that exist in .env.local and are consumed by a workflow.
# Deliberately EXCLUDES DATABASE_URL: CI mints an ephemeral Neon branch via
# NEON_API_KEY + NEON_PROJECT_ID and must not receive the production URL.
KEYS=(
  PORTAL_PUSH_SECRET
  STRIPE_PRICE_MONTHLY
  STRIPE_PRICE_ANNUAL
  STRIPE_WEBHOOK_SECRET
  ALPACA_API_KEY
  ALPACA_API_SECRET
)

[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found; run from the repo root" >&2; exit 1; }

read_val() {
  # Last assignment wins, strip one layer of surrounding quotes.
  local k="$1" v
  v=$(grep -E "^${k}=" "$ENV_FILE" | tail -n1 | cut -d= -f2-) || return 1
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

for k in "${KEYS[@]}"; do
  v="$(read_val "$k" || true)"
  if [ -z "$v" ]; then
    echo "skip   $k (absent or empty in $ENV_FILE)"
    continue
  fi
  if [ "$DRY" = "--dry" ]; then
    echo "would  $k (${#v} chars)"
  else
    printf '%s' "$v" | gh secret set "$k"
    echo "set    $k (${#v} chars)"
  fi
done

cat <<'NOTE'

PORTAL_URL is already set (2026-08-30). Still missing from GitHub:
  CRON_SECRET          openssl rand -hex 32, then: gh secret set CRON_SECRET
                       (distinct from PORTAL_PUSH_SECRET — see docs/manual-setup-todo.md)
  STRIPE_WEBHOOK_SECRET
                       run ./scripts/create-stripe-webhook.sh first — the portal
                       has no webhook endpoint yet, so there is no secret to push
  GCP_WIF_PROVIDER     no pool exists yet; see docs/manual-setup-todo.md §1
  GCP_SERVICE_ACCOUNT  no service account exists yet; same section
NOTE
