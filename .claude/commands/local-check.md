# /local-check — Full-Stack Local Environment Check

Runs the CLI inventory, env-var, and layer-bisection checks from
`docs/local-fullstack-testing-guide.md` against the current working tree, so
you know the local Next.js → GCP → OpenRouter → Neon → Clerk → Stripe stack
is actually ready to test against before you start debugging application
code. Takes no arguments; if the user passes a failing route or symptom
(e.g. `/local-check /api/portfolio/health`), skip straight to the layer
bisection in step 4 for that route instead of running the full inventory.

## Execute

```bash
# 1. CLI auth inventory
echo "== gcloud ==" && gcloud config list 2>&1
echo "== clerk ==" && clerk --version 2>&1 && clerk whoami 2>&1
echo "== stripe ==" && stripe config --list 2>&1
echo "== wrangler ==" && wrangler whoami 2>&1

# 2. Env var drift: missing/blank keys vs .env.example, and placeholders
echo "== missing/blank keys =="
comm -23 <(grep -oE '^[A-Z_]+=' .env.example | sort -u) \
         <(grep -E '^[A-Z_]+=.+' .env.local 2>/dev/null | grep -oE '^[A-Z_]+=' | sort -u)
echo "== placeholder values =="
grep -nE '^[A-Z_]+=.*(placeholder|changeme|xxx|your-|TODO)' .env.local 2>/dev/null

# 3. DB reachability + migration status
npm run db:migrate

# 4. GCP backend smoke test (only if MCP_BACKEND_URL is set)
if [ -n "$MCP_BACKEND_URL" ]; then
  curl -s -o /dev/null -w 'backend health: %{http_code}\n' "$MCP_BACKEND_URL/health"
fi

# 5. Fast test suite (deterministic, no network)
npm test
```

## Report

Summarize as a pass/fail table by layer (CLI auth, env vars, DB, GCP
backend, fast tests). For any failing layer, point to the matching section
of `docs/local-fullstack-testing-guide.md` (§1 CLI auth, §2 env vars, §3 DB,
§4 GCP backend, §5 OpenRouter/live tests, §6 Clerk/Stripe, §8 bisection)
rather than re-explaining the fix inline — the guide has the detail. Do not
run `npm run test:live` or `stripe trigger` automatically (they burn
free-tier quota / create real test-mode events); mention them as the next
step only if the fast suite passes and the change touches prompts, parsing,
or billing.
