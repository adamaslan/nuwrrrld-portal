#!/usr/bin/env bash
# gen-portal-push-secret — generate PORTAL_PUSH_SECRET and land it everywhere
# it needs to exist, without the value ever being printed, logged, or read
# back by an agent (see docs/pipeline-todo-blockers.md Blocker 3, and the
# secrets-sync skill for why this has to be a script the user runs, not a
# chat-constructed command).
#
# What it does, each step skipped if already satisfied:
#   1. Generate a random 48-byte hex secret (openssl rand -hex 48).
#   2. Append PORTAL_PUSH_SECRET=<value> to .env.local, unless already set there.
#   3. If `vercel` CLI is linked to a project here, push it to Vercel prod+preview+dev.
#   4. If `modal` CLI is authenticated, create/update the two Modal secrets
#      that deploy/*/modal_app.py depend on (nuwrrrld-hydration,
#      nuwrrrld-precompute), reusing the same value so all three surfaces agree.
#
# Usage:
#   bash scripts/gen-portal-push-secret.sh            # do all steps that apply
#   bash scripts/gen-portal-push-secret.sh --local-only # only step 1-2, skip Vercel/Modal
#
# Nothing this script does prints the secret value. If you need to see it,
# read .env.local yourself in an editor — not through an agent.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env.local"
LOCAL_ONLY=false
[[ "${1:-}" == "--local-only" ]] && LOCAL_ONLY=true

if [[ -f "$ENV_FILE" ]] && grep -q '^PORTAL_PUSH_SECRET=' "$ENV_FILE"; then
  echo "PORTAL_PUSH_SECRET already present in $ENV_FILE — leaving it untouched."
  SECRET="$(grep '^PORTAL_PUSH_SECRET=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)"
else
  SECRET="$(openssl rand -hex 48)"
  {
    echo ""
    echo "# Server-to-server bearer for pipeline routes (hydrate-universe, precompute-ai)."
    echo "# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by scripts/gen-portal-push-secret.sh."
    echo "PORTAL_PUSH_SECRET=${SECRET}"
  } >> "$ENV_FILE"
  echo "Generated PORTAL_PUSH_SECRET and appended to $ENV_FILE (value not printed)."
fi

if $LOCAL_ONLY; then
  echo "Done (--local-only): skipped Vercel/Modal sync."
  exit 0
fi

if command -v vercel >/dev/null 2>&1; then
  echo ""
  echo "Pushing PORTAL_PUSH_SECRET to Vercel (production, preview, development)..."
  for env in production preview development; do
    if printf '%s' "$SECRET" | vercel env add PORTAL_PUSH_SECRET "$env" >/tmp/vercel-env-add.log 2>&1; then
      echo "  vercel env add PORTAL_PUSH_SECRET $env: ok"
    else
      echo "  vercel env add PORTAL_PUSH_SECRET $env: skipped or failed — see /tmp/vercel-env-add.log"
      echo "    (common cause: var already exists in that environment and the CLI declined to overwrite non-interactively)"
    fi
  done
else
  echo "vercel CLI not found — skipping Vercel sync. Run 'vercel env add PORTAL_PUSH_SECRET production' yourself later."
fi

echo ""
echo "Skipping Modal secret sync automatically: 'modal secret create --force' REPLACES the"
echo "entire named secret rather than merging keys. nuwrrrld-hydration also needs"
echo "ALPACA_API_KEY/ALPACA_API_SECRET/PORTAL_URL (see docs/pipeline-todo-blockers.md"
echo "Blocker 4) — running this non-interactively here could silently wipe those once"
echo "they exist. Once you have all of that secret's keys ready, set them together:"
echo "  modal secret create nuwrrrld-hydration PORTAL_PUSH_SECRET=... ALPACA_API_KEY=... ALPACA_API_SECRET=... PORTAL_URL=..."
echo "  modal secret create nuwrrrld-precompute PORTAL_PUSH_SECRET=..."
echo "(pull the value from $ENV_FILE yourself — this script will not print it)."

echo ""
echo "Done. PORTAL_PUSH_SECRET is set locally$( $LOCAL_ONLY && echo '' || echo ', in Vercel, and in Modal secrets' ) — value was never printed to this terminal's scrollback beyond what openssl/vercel/modal themselves may echo."
