#!/bin/bash
set -e

echo "🚀 Building and deploying to Cloudflare Pages..."

# Build
npm run build

# Deploy to Cloudflare Pages
DEPLOYMENT=$(wrangler pages deploy .next/static --project-name=nuwrrrld-portal 2>&1 | grep "Deployment complete" | grep -o "https://[^ ]*")

if [ -z "$DEPLOYMENT" ]; then
  echo "❌ Deployment failed"
  exit 1
fi

echo "✅ Deployed to: $DEPLOYMENT"

# Update DNS CNAME to point to latest deployment
SUBDOMAIN="financial"
DOMAIN="nuwrrrld.com"

echo "📝 To point $SUBDOMAIN.$DOMAIN to latest build:"
echo "   CNAME $SUBDOMAIN → $DEPLOYMENT"
echo ""
echo "Update manually at: https://dash.cloudflare.com/zones/$DOMAIN/dns/records"
