#!/usr/bin/env bash
#
# sync-hydration-secrets.sh — this repo's variable contract for
# .github/workflows/hydrate-universe.yml, wrapping the generic
# ~/.claude/scripts/sync-secrets.sh.
#
# Run this yourself, in your own terminal. Do not paste its output anywhere.
# The point of the wrapper is that real values go straight from .env.local
# into `gh secret set`'s stdin and never pass through an agent's context, a
# chat transcript, or a file — see the secrets-sync skill for why that
# constraint exists (an agent's Edit requires a prior Read, so touching a
# secrets file at all would pull every value in it into context).
#
#   bash scripts/sync-hydration-secrets.sh              # push the vars below
#   bash scripts/sync-hydration-secrets.sh --dry-run    # names only, pushes nothing
#
# Requires: gh CLI authenticated (gh auth status); ~/.claude/scripts/sync-secrets.sh present.
#
# Why only two variables: the hydration workflow computes indicators in the
# runner and POSTs finished rows, so it needs the Alpaca pair to fetch bars and
# PORTAL_PUSH_SECRET to be accepted by the portal. PORTAL_PUSH_SECRET is
# already synced by scripts/sync-e2e-secrets.sh — it is listed here too because
# this workflow genuinely depends on it, and a contract that omits a dependency
# because some other script happens to cover it breaks the moment that script's
# list changes.

set -euo pipefail

SYNC_SCRIPT="$HOME/.claude/scripts/sync-secrets.sh"
if [[ ! -f "$SYNC_SCRIPT" ]]; then
  echo "Missing $SYNC_SCRIPT — this repo's script wraps the shared secrets-sync skill script." >&2
  echo "See ~/.claude/skills/secrets-sync/SKILL.md." >&2
  exit 1
fi

exec bash "$SYNC_SCRIPT" gh .env.local "$@" \
  ALPACA_API_KEY \
  ALPACA_API_SECRET \
  PORTAL_PUSH_SECRET
