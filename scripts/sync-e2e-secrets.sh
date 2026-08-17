#!/usr/bin/env bash
#
# sync-e2e-secrets.sh — this repo's fixed variable contract for
# e2e-resiliency.yml + refresh-free-models.yml, wrapping the generic
# ~/.claude/scripts/sync-secrets.sh (see the secrets-sync skill for the full
# rationale: never route a real secret value through an LLM chat session —
# run this locally, don't paste its output anywhere).
#
#   bash scripts/sync-e2e-secrets.sh                # push every var below with a real value
#   bash scripts/sync-e2e-secrets.sh --dry-run       # names only, pushes nothing
#   bash scripts/sync-e2e-secrets.sh --provision-wif [gcp-project-id]
#       one-time GCP WIF setup — see docs/e2e.md §8 and playwright-todo.md blocker #3
#
# Requires: gh CLI authenticated (gh auth status); ~/.claude/scripts/sync-secrets.sh present.
#
# Does NOT rotate anything — see docs/env-rotation.md for what to rotate
# before running this, if a value was ever exposed to an agent's context.

set -euo pipefail

SYNC_SCRIPT="$HOME/.claude/scripts/sync-secrets.sh"
if [[ ! -f "$SYNC_SCRIPT" ]]; then
  echo "Missing $SYNC_SCRIPT — this repo's script wraps the shared secrets-sync skill script." >&2
  echo "See ~/.claude/skills/secrets-sync/SKILL.md." >&2
  exit 1
fi

if [[ "${1:-}" == "--provision-wif" ]]; then
  shift
  exec bash "$SYNC_SCRIPT" gcp-wif adamaslan/nuwrrrld-portal "${1:-}"
fi

# The exact contract e2e-resiliency.yml's sharded job + refresh-free-models.yml
# read from secrets.* (mirrors .env.example / docs/e2e.md §0). GCP_WIF_* are
# handled separately via --provision-wif above, not synced from .env.local.
exec bash "$SYNC_SCRIPT" gh .env.local "$@" \
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
  CLERK_SECRET_KEY \
  NULOGDASH_ADMIN_EMAILS \
  OPENROUTER_API_KEY \
  ANTHROPIC_API_KEY \
  MCP_BACKEND_URL \
  DATABASE_URL \
  STRIPE_SECRET_KEY \
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY \
  STRIPE_WEBHOOK_SECRET \
  STRIPE_PRICE_MONTHLY \
  STRIPE_PRICE_ANNUAL \
  PORTAL_PUSH_SECRET \
  IP_HASH_SECRET \
  E2E_CLERK_TEST_EMAIL \
  E2E_CLERK_TEST_PASSWORD
