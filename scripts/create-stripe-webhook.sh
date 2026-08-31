#!/usr/bin/env bash
# Create the portal's live Stripe webhook endpoint and capture its signing secret.
#
# Why this exists: the only live endpoint on the account points at the gcp3
# Cloud Run backend, not the portal, so the portal receives no events at all.
# Stripe reveals whsec_... exactly once — at creation — so this script writes it
# straight into .env.local rather than printing it.
#
#   ./scripts/create-stripe-webhook.sh --dry   # show what would be created
#   ./scripts/create-stripe-webhook.sh
set -euo pipefail

URL="${PORTAL_WEBHOOK_URL:-https://financial.nuwrrrld.com/api/webhooks/stripe}"
ENV_FILE=".env.local"
DRY="${1:-}"

# All five types app/api/webhooks/stripe/route.ts switches on. The existing
# gcp3 endpoint omits customer.subscription.created.
EVENTS=(
  checkout.session.completed
  customer.subscription.created
  customer.subscription.updated
  customer.subscription.deleted
  invoice.payment_failed
)

[ -f "$ENV_FILE" ] || { echo "error: $ENV_FILE not found; run from the repo root" >&2; exit 1; }
SK=$(grep -m1 '^STRIPE_SECRET_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"')
[ -n "$SK" ] || { echo "error: STRIPE_SECRET_KEY missing from $ENV_FILE" >&2; exit 1; }

case "$SK" in
  sk_live_*) MODE="LIVE" ;;
  sk_test_*) MODE="TEST" ;;
  *) echo "error: STRIPE_SECRET_KEY is not a recognizable Stripe secret key" >&2; exit 1 ;;
esac

args=(-s https://api.stripe.com/v1/webhook_endpoints -u "$SK:"
      -d "url=$URL" -d "description=NuWrrrld portal (Next.js) — subscription lifecycle")
for e in "${EVENTS[@]}"; do args+=(-d "enabled_events[]=$e"); done

echo "mode:   $MODE"
echo "url:    $URL"
echo "events: ${EVENTS[*]}"

if [ "$DRY" = "--dry" ]; then
  echo
  echo "(dry run — nothing created)"
  exit 0
fi

if [ "$MODE" = "LIVE" ]; then
  printf '\nThis creates a LIVE webhook endpoint on the Stripe account. Continue? [y/N] '
  read -r ans; [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "aborted"; exit 1; }
fi

resp=$(curl "${args[@]}")

# Parse without echoing the secret.
read -r WID WSEC < <(printf '%s' "$resp" | python3 -c '
import sys, json
d = json.load(sys.stdin)
if "error" in d:
    sys.stderr.write("Stripe error: " + d["error"].get("message", "unknown") + "\n"); sys.exit(1)
print(d.get("id", ""), d.get("secret", ""))
')

[ -n "$WSEC" ] || { echo "error: no signing secret returned" >&2; exit 1; }

cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
if grep -qE '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE"; then
  python3 - "$ENV_FILE" "$WSEC" <<'PY'
import re, sys
p, v = sys.argv[1], sys.argv[2]
s = open(p).read()
open(p, "w").write(re.sub(r'^STRIPE_WEBHOOK_SECRET=.*$', f'STRIPE_WEBHOOK_SECRET={v}', s, flags=re.M))
PY
else
  printf 'STRIPE_WEBHOOK_SECRET=%s\n' "$WSEC" >> "$ENV_FILE"
fi

echo
echo "created $WID"
echo "STRIPE_WEBHOOK_SECRET written to $ENV_FILE (${#WSEC} chars, not printed)"

# Push straight to Vercel Production. The value is piped from this shell into
# the CLI; it is never echoed and never reaches a chat transcript. Production
# currently holds a whsec_placeholder..., so this replaces rather than adds.
if command -v vercel >/dev/null 2>&1 && [ -f .vercel/project.json ]; then
  printf '\nPush STRIPE_WEBHOOK_SECRET to Vercel Production now? [y/N] '
  read -r vans
  if [ "$vans" = "y" ] || [ "$vans" = "Y" ]; then
    vercel env rm STRIPE_WEBHOOK_SECRET production --yes >/dev/null 2>&1 || true
    if printf '%s' "$WSEC" | vercel env add STRIPE_WEBHOOK_SECRET production >/dev/null 2>&1; then
      echo "  ✓ Vercel Production updated"
      echo "  ! redeploy for it to take effect: vercel --prod"
    else
      echo "  ✗ Vercel update failed — set it manually in the dashboard" >&2
    fi
  else
    echo "  skipped Vercel; production keeps the placeholder and will reject events"
  fi
else
  echo
  echo "vercel CLI or .vercel/project.json missing — set STRIPE_WEBHOOK_SECRET in the dashboard"
fi

cat <<'NOTE'

Next:
  1. Redeploy so production picks up the new secret:  vercel --prod
  2. ./scripts/push-github-secrets.sh
  3. Send a test event from the Stripe dashboard and confirm a 200.

The old gcp3 endpoint (we_1ThMVuRo4oSNMCPPDVd86EUJ ->
gcp3-backend-...run.app/webhooks/stripe) is left untouched. Disable it only if
that backend no longer needs Stripe events.
NOTE
