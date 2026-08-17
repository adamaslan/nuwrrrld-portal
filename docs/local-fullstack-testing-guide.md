# Testing a Next.js + GCP + OpenRouter + DB Stack Locally

A generic, reusable playbook for standing up and exercising a full stack app
locally when the stack looks like: **Next.js frontend/API routes → GCP
backend service → OpenRouter/LLM providers → a hosted DB (Postgres/Neon,
Firestore, etc.) → auth (Clerk) → billing (Stripe)**. Written against this
repo's actual tooling so the commands are copy-pasteable, but the shape
applies to any project with this topology.

The goal: verify a change end-to-end on your machine, using the same CLIs
you'd use to debug production, before opening a PR.

---

## 1. Map the stack before testing it

Before running anything, know which of these five layers your change
touches — it determines which CLI you need and whether you can stub it out:

| Layer | This repo's instance | CLI |
|---|---|---|
| Frontend + API routes | Next.js (`app/`) | `next dev`, `npm run *` |
| Backend / signals service | GCP (Cloud Run, via `MCP_BACKEND_URL`) | `gcloud` |
| LLM providers | OpenRouter (+ Anthropic fallback) | none — HTTP, test via live suite |
| Database | Neon (Postgres) | Neon MCP tools, or `psql` via `DATABASE_URL` |
| Auth | Clerk | `clerk` CLI |
| Billing | Stripe | `stripe` CLI |
| Edge/CDN (if applicable) | Cloudflare | `wrangler` |

Run a quick inventory at the start of a session:

```sh
gcloud config list                 # active GCP project/account
clerk --version && clerk whoami    # Clerk CLI auth state
stripe config --list               # Stripe CLI active account/mode
wrangler whoami                    # Cloudflare, if the project uses Workers/Pages
```

If a CLI reports "not logged in," fix that before writing test code — most
local-testing failures in this kind of stack are expired CLI auth, not bugs.

---

## 2. Environment variables: one source, two consumers

Keep a single `.env.local` (git-ignored) that both `next dev` and any
standalone scripts read. Check it against `.env.example` at the start of a
session — for both *missing* keys and, more commonly, keys that are present
but **empty or still placeholders**:

```sh
# keys in .env.example that are missing or blank in .env.local
comm -23 <(grep -oE '^[A-Z_]+=' .env.example | sort -u) \
         <(grep -E '^[A-Z_]+=.+' .env.local | grep -oE '^[A-Z_]+=' | sort -u)

# keys that are set but to an obvious placeholder
grep -nE '^[A-Z_]+=.*(placeholder|changeme|xxx|your-|TODO)' .env.local
```

An empty or placeholder value is worse than a missing one: most code paths
treat "set" as "configured" and fail deep in a request instead of at boot.

Categorize what's missing:
- **Secrets you own** (API keys) — pull from the provider's dashboard or CLI
  (`stripe config`, `clerk env pull` if supported, GCP Secret Manager via
  `gcloud secrets versions access latest --secret=NAME`).
- **Generated secrets** (internal shared tokens, hash salts) — generate
  locally, they don't need to match prod: `openssl rand -hex 32`.
- **Free-tier keys with rate limits** (OpenRouter) — use a dedicated
  low-quota key for local dev so you don't burn the prod key's budget.

---

## 3. Database: prefer the project's own migration/seed scripts over ad hoc SQL

Don't hand-write schema changes against a shared dev DB. Use whatever the
repo already has:

```sh
npm run db:migrate           # idempotent schema apply (this repo: Neon)
npm run db:hydrate:dev       # seed/backfill dev data, if present
```

If a Neon (or similar hosted Postgres) MCP integration is available in your
agent, prefer it over raw `psql` for one-off inspection — it can run SQL,
diff schemas, and check for slow queries without you managing a connection
string:

```
list tables, describe a table, run a read-only query, check slow queries
```

For Firestore-backed backends (common on the GCP side of this kind of
stack), use the `firebase` CLI against emulators rather than touching a real
project:

```sh
firebase emulators:start --only firestore,auth
```

Point the app at the emulator via the relevant `FIRESTORE_EMULATOR_HOST` /
`FIREBASE_AUTH_EMULATOR_HOST` env vars instead of real GCP credentials —
this makes destructive test data safe to create and blow away.

---

## 4. GCP backend: hit it live, or run it locally, but know which one you're doing

Two valid modes — pick deliberately, don't mix silently:

**A. Point at a real deployed backend (fastest, least isolated)**
```sh
gcloud run services describe <service> --region <region> --format='value(status.url)'
# set MCP_BACKEND_URL (or equivalent) to that URL in .env.local
```
Good for frontend-only changes where you trust the backend is stable.

**B. Run the backend locally (slower setup, full isolation)**
```sh
gcloud auth application-default login   # ADC for local GCP SDK calls
# then run the backend's own local entrypoint (uvicorn/functions-framework/etc.)
```
Required when your change touches the backend itself — don't test backend
code changes against the deployed version.

Either way, confirm which mode you're in with a smoke request before relying
on it:
```sh
curl -s "$MCP_BACKEND_URL/health" | jq .
```

---

## 5. OpenRouter / LLM calls: separate deterministic tests from live tests

Non-deterministic model output cannot be asserted on directly. Split your
test suite the way this repo does (`vitest.config.ts` projects: `unit`,
`components`, `live`):

- **Fast suite** (`npm test`) — no network, mocks `fetch`/the provider
  client, asserts prompt construction, parsing, validation, fallback-chain
  logic. Run this constantly.
- **Live suite** (`npm run test:live`) — real calls to OpenRouter/Anthropic,
  run against actual free-tier quota. Asserts *invariants* only (non-empty,
  parses, arrives within budget) — never exact wording. Run this before a PR
  that touches prompts, parsing, or the provider fallback chain, not on
  every save (rate limits + latency).

Use a scoped OpenRouter API key for local live runs so a runaway loop can't
exhaust the production key's budget.

---

## 6. Auth (Clerk) and billing (Stripe) locally

**Clerk** — use a dedicated dev/test instance, not the prod instance, and
drive it with the CLI rather than clicking through the dashboard:
```sh
clerk --version && clerk whoami          # confirm linked + authenticated
clerk users list                          # inspect test users
```

**Stripe** — use test mode and the CLI's webhook forwarder so local routes
receive real webhook events without a public URL:
```sh
stripe listen --forward-to localhost:3000/api/webhooks/stripe
stripe trigger checkout.session.completed   # in a second terminal
```
Copy the `whsec_...` the listener prints into `STRIPE_WEBHOOK_SECRET` in
`.env.local` — it's different from the dashboard's webhook secret.

---

## 7. Running the app

```sh
npm run dev            # next dev — frontend + API routes
npm test                # fast suite, run on every change
npm run test:live       # before PRs touching prompts/parsing/providers
npm run test:integration  # if the repo has a DB-backed integration project
```

Smoke-test the golden path manually in a browser once automated tests pass —
type checks and unit tests verify code correctness, not feature correctness.
Check: sign-in (Clerk), the core data flow (GCP backend → DB → UI), an AI
feature (OpenRouter), and a billing action (Stripe test mode) if your change
touches any of them.

---

## 8. When it breaks: bisect by layer, don't debug through the UI

The expensive mistake in a stack this deep is debugging a five-layer failure
from the browser. Walk *inward* from the UI and stop at the first layer that
misbehaves — each step below removes one layer from the picture:

```sh
# 1. Is it the browser/client, or the server? Call the API route directly.
curl -s -i localhost:3000/api/<route> | head -20

# 2. Is it auth? Same call with and without a session/bearer token.
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/<route>
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
     localhost:3000/api/<route>

# 3. Is it the backend, or our call to it? Hit GCP directly.
curl -s "$MCP_BACKEND_URL/<path>" | jq .

# 4. Is it the DB, or the code reading it? Query it directly
#    (Neon MCP tools, or psql "$DATABASE_URL").

# 5. Is it the model provider? Check the provider, not your wrapper.
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  | jq '.data | length'
```

Reading the signal:

| Symptom | Almost always |
|---|---|
| `401`/`403` on every route | CLI or `.env.local` auth expired, not your code |
| `503` on AI routes only | missing/empty provider key (see §2) |
| Works via `curl`, fails in browser | client-side state, CORS, or a stale dev-server build |
| Route hangs, no error | an unawaited upstream call — check the GCP/DB layer directly |
| Passes locally, fails in CI | env var set locally but not in the CI/deploy environment |

Two force multipliers: keep `next dev`'s terminal visible (server-side
`console.error` lands there, not in the browser console), and restart the
dev server after editing `.env.local` — Next.js does **not** hot-reload
environment variables, which silently invalidates whatever you just tested.

---

## 9. Before opening a PR

- `npm run lint && npm test` clean.
- If you touched prompts/parsing/provider logic: `npm run test:live` clean.
- If you touched schema: `npm run db:migrate` ran clean against your dev DB.
- CLI auth states (`gcloud`, `clerk`, `stripe`) still point at dev/test
  accounts, not anything you'd regret pushing to by accident.
- No real secrets committed — diff `.env.local` was never staged:
  `git status --short | grep -v '^??' | grep '\.env'` should be empty.

---

## Quick reference: CLI commands by task

| Task | Command |
|---|---|
| Check GCP auth/project | `gcloud config list` |
| Get Cloud Run URL | `gcloud run services describe <svc> --format='value(status.url)'` |
| GCP Application Default Credentials | `gcloud auth application-default login` |
| Fetch a GCP secret | `gcloud secrets versions access latest --secret=<name>` |
| Firestore/Auth emulators | `firebase emulators:start --only firestore,auth` |
| Clerk auth check | `clerk whoami` |
| Stripe test-mode webhook forwarding | `stripe listen --forward-to localhost:3000/api/webhooks/stripe` |
| Trigger a Stripe test event | `stripe trigger <event.name>` |
| Cloudflare auth check (if applicable) | `wrangler whoami` |
| Generate a local shared secret | `openssl rand -hex 32` |
