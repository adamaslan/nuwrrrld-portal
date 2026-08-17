# Env Rotation — GitHub Actions Repo Secrets

Scope: which repo secrets `.github/workflows/e2e-resiliency.yml` and
`refresh-free-models.yml` need, how to set them with `gh secret set`, and
which underlying values must be **rotated** before being set, because they
were exposed in plaintext during an editor session on 2026-08-17 (an agent
had to `Read` `.env.local` in order to `Edit` it — a hard tool constraint,
not a choice — which put every value in that file into the agent's context).

This file names variable **names** and rotation **status** only. No real
values are written here — same policy as `.env.example` and the wiki
(`docs/wiki-portal/SCHEMA.md`).

---

## Rotate before setting as a GHA secret

These specific values were read in plaintext this session. Treat all four as
compromised regardless of how low you judge the actual risk — rotating is
cheap, re-deriving trust in an exposed production credential is not.

| Variable | Where to rotate | Priority |
|---|---|---|
| `CLERK_SECRET_KEY` (the **live** `sk_live_...` pair, not the `pk_test_`/`sk_test_` pair also present in the file) | Clerk Dashboard → API Keys → regenerate secret key for the production instance | **High** — production auth secret |
| `STRIPE_SECRET_KEY` (`sk_live_...`) | Stripe Dashboard → Developers → API keys → roll key | **High** — production billing secret |
| `DATABASE_URL` (Neon connection string, includes the DB password) | Neon Console → project `lingering-rain-31058530` → Reset password on the role, or create a new role and swap the connection string | **High** — full read/write DB access |
| `OPENROUTER_API_KEY` | OpenRouter Dashboard → API Keys → revoke + create new | Medium — usage/cost exposure, no data access |

**Not flagged for rotation, but worth fixing regardless:** `.env.local`
currently contains **two different Clerk key pairs** — a `pk_test_`/`sk_test_`
pair (lines 1–2, original) and a `pk_live_`/`sk_live_` pair (lines 38–39,
appended later). Whichever one dotenv resolves last wins, which as of this
writing is the **live** pair — meaning local dev has likely been running
against production Clerk, not a dev instance. Delete the duplicate pair you
don't intend to use; don't just rotate both and leave the ambiguity.

**Not exposed, no action needed:** `ANTHROPIC_API_KEY` is still the
`sk_placeholder_set_in_vercel` placeholder locally — nothing real to rotate
there. `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ANNUAL` are also still
placeholders.

---

## `gh secret set` — what each workflow needs

Run these from the repo root once new values are in hand. `gh secret set NAME`
prompts for a value on stdin (or pipe one in) — never pass the value as a
CLI argument, which would land in shell history.

### `.github/workflows/refresh-free-models.yml`

```bash
gh secret set OPENROUTER_API_KEY
```

### `.github/workflows/e2e-resiliency.yml`

**GCP Workload Identity Federation** — provisioned in the GCP console/`gcloud`
first (a WIF pool + provider trusting this repo's OIDC token, plus a service
account scoped to only what the MCP identity-token step needs). Not a
rotation — these don't exist yet.

```bash
gh secret set GCP_WIF_PROVIDER
gh secret set GCP_SERVICE_ACCOUNT
```

**App secrets** — same names as `.env.example`, set with the **rotated**
values from the table above where applicable:

```bash
gh secret set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
gh secret set CLERK_SECRET_KEY              # rotated value
gh secret set NULOGDASH_ADMIN_EMAILS
gh secret set OPENROUTER_API_KEY            # rotated value
gh secret set ANTHROPIC_API_KEY
gh secret set MCP_BACKEND_URL
gh secret set DATABASE_URL                  # rotated value
gh secret set STRIPE_SECRET_KEY             # rotated value
gh secret set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
gh secret set STRIPE_WEBHOOK_SECRET
gh secret set STRIPE_PRICE_MONTHLY
gh secret set STRIPE_PRICE_ANNUAL
gh secret set PORTAL_PUSH_SECRET
gh secret set IP_HASH_SECRET
```

**Clerk test-user credentials** — `auth` job only, per `playwright-todo.md`
blocker #2. `E2E_CLERK_TEST_EMAIL` was not itself exposed as a secret concern
(it's an email address, meant to be semi-public as an allowlist entry), but
`E2E_CLERK_TEST_PASSWORD` was read in plaintext this session — rotate it via
the Clerk Dashboard (Users → this test user → reset password) before setting:

```bash
gh secret set E2E_CLERK_TEST_EMAIL
gh secret set E2E_CLERK_TEST_PASSWORD       # rotated value
```

---

## Verify after rotating

```bash
gh secret list                              # confirms names are set, never shows values
npx playwright test --project=preflight     # local: confirms .env.local's new values pass shape+liveness checks
```

A green `preflight` run after rotation is the actual proof the new values
work — `gh secret list` only proves the name exists, not that the value is
correct.

## See also

- `playwright-todo.md` blockers #2–#4 — the account/WIF/secrets setup this
  rotation feeds into
- `docs/e2e.md` §0 — the full env-var contract table (names + failure modes)
- `.env.example` — canonical variable names for local dev
