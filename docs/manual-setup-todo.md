# Manual setup TODO — things only a human with dashboard access can do

Everything in this file is blocked on a login, a signature, or a value that
does not exist yet. None of it is a code change. It is the complete set of
external tasks standing between the current branch and a production-ready
deploy, gathered 2026-08-29 while finishing
[docs/todo-auth-cookies-tracking.md](todo-auth-cookies-tracking.md).

Ordered by what unblocks the most.

---

## 0. What is actually broken right now

The `integration` CI job fails on **every** branch — `feat/consent-cookies-tracking`
(PR #77) and `feat/auth-cookies-phase-1-3-6` (PR #78) alike. It predates both.

```
env:
  NEON_API_KEY:                       <- empty
ERROR: Cannot run interactive auth in CI
```

`.github/workflows/integration-tests.yml` creates an ephemeral Neon branch per
run. With no API key, `neonctl` falls back to interactive auth and dies. This is
the single highest-value fix in this document: it turns CI green on two PRs at
once.

> **A caution about the lists below.** `gh secret list` returned 14 secrets early
> in the session and 0 rows minutes later, so any "missing from GitHub" claim
> here is unverified. What *is* verified: `NEON_API_KEY` resolved empty at
> runtime in the failing job, and the six values in §1 are absent from
> `.env.local`. Re-run `gh secret list` yourself before acting on §2.

---

## 1. Values that do not exist yet — you must create or fetch them

These are not in `.env.local`, so there is nothing to copy. Each has to be
generated or retrieved from a dashboard.

| Secret | Where to get it | Needed by |
|---|---|---|
| `NEON_API_KEY` | Neon console → Account settings → API keys → Generate | `integration-tests.yml` **(the live failure)** |
| `NEON_PROJECT_ID` | Neon console → Project settings → General. Looks like `wispy-forest-12345678` | `integration-tests.yml` |
| `CRON_SECRET` | Generate one: `openssl rand -hex 32`. Must match what the cron caller sends. | `afternoon-pipeline.yml`, `/api/retention/*` |
| `PORTAL_URL` | Just the deployed origin, e.g. `https://financial.nuwrrrld.com` | `afternoon-pipeline.yml` |
| `GCP_WIF_PROVIDER` | GCP → IAM → Workload Identity Federation. Full resource path. | `e2e-resiliency.yml` |
| `GCP_SERVICE_ACCOUNT` | GCP → IAM → Service accounts. The `...@....iam.gserviceaccount.com` address. | `e2e-resiliency.yml` |

The `secrets-sync` skill can provision the two GCP ones (keyless WIF, no JSON key
file) if you'd rather not click through it.

---

## 2. Values that exist locally — push them to GitHub Actions

These are all in `.env.local` already. **Verify what's actually set first**
(`gh secret list`), then push only what's genuinely absent.

```
ALPACA_API_KEY  ALPACA_API_SECRET  CLERK_SECRET_KEY  DATABASE_URL
IP_HASH_SECRET  MCP_BACKEND_URL  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY  NULOGDASH_ADMIN_EMAILS
OPENROUTER_API_KEY  PORTAL_PUSH_SECRET  STRIPE_PRICE_ANNUAL
STRIPE_PRICE_MONTHLY  STRIPE_SECRET_KEY  STRIPE_WEBHOOK_SECRET
```

Do it locally so no value passes through a chat session:

```bash
# from the repo root, with .env.local present
while IFS='=' read -r k v; do
  case "$k" in
    ALPACA_API_KEY|ALPACA_API_SECRET|CLERK_SECRET_KEY|DATABASE_URL|\
    IP_HASH_SECRET|MCP_BACKEND_URL|NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|\
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY|NULOGDASH_ADMIN_EMAILS|\
    OPENROUTER_API_KEY|PORTAL_PUSH_SECRET|STRIPE_PRICE_ANNUAL|\
    STRIPE_PRICE_MONTHLY|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)
      printf '%s' "${v%\"}" | sed 's/^"//' | gh secret set "$k"
      echo "set $k" ;;
  esac
done < .env.local
```

**Caveat worth pausing on:** `DATABASE_URL` in `.env.local` points at your real
Neon database. CI should get a *branch* connection string, not production —
that's exactly what `NEON_API_KEY` + `NEON_PROJECT_ID` exist to provide. Don't
push production `DATABASE_URL` as the CI secret if the workflow can mint its own.

---

## 3. Clerk — Phase 1.1 / 1.2 of the tracking plan

Currently running a **Development** instance (`pk_test_…`). Dev mode locally is
correct; dev mode in production is the bug.

- [ ] Create/activate the **Production** instance (needs a verified domain + DNS
      for `clerk.financial.nuwrrrld.com`).
- [ ] Put `pk_live_…` / `sk_live_…` in **Vercel project env vars only**. Keep
      `pk_test_…` in local `.env.local` deliberately.
- [ ] Verify: production build shows no Clerk dev badge, and `__session` is
      issued from the production domain rather than `*.accounts.dev`.
- [ ] Confirm the dev-instance shared JWT signing key is **not** trusted by any
      production API route.
- [ ] Set an explicit session lifetime + inactivity timeout. This is a financial
      product; the default multi-day session is too long.
- [ ] Audit the served session cookie attributes in production: `Secure`,
      `HttpOnly`, `SameSite=Lax`, and `Domain` scoped to the apex only if
      subdomain sharing with mobile is genuinely needed.
- [ ] Decide and write down whether `gcp3-mobile` shares this Clerk instance. If
      it does, a session revocation on one surface must revoke on the other —
      **test it, don't assume it.**

---

## 4. Stripe

- [ ] Confirm `STRIPE_WEBHOOK_SECRET` is a real `whsec_…` for the **production**
      endpoint, not a placeholder or a CLI-forwarding secret.
      `app/api/health` already surfaces this — check it before trusting the env.
- [ ] Confirm `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL` are live-mode price
      IDs. Checkout 500s on a placeholder, and the health route flags it.
- [ ] Point the production webhook endpoint at `/api/webhooks/stripe` and verify
      a test event is accepted (signature verification is already implemented).

---

## 5. Neon

- [ ] Generate the API key + project ID from §1 — that alone fixes CI.
- [ ] Confirm the migration you ran applied all four new tables:
      ```sql
      SELECT table_name FROM information_schema.tables
      WHERE table_name IN ('consent_records','legal_consent_events',
                           'privacy_requests','user_attribution');
      ```
      Expect 4 rows.
- [ ] Decide a retention/backup posture for `privacy_requests` — it is
      deliberately excluded from the erasure cascade and is the evidentiary
      record that a deletion request happened.

---

## 6. Legal / vendor — blocks Phases 3.1, 4.2–4.4, 7

These need a signature or a qualified review, not a login.

- [ ] **Pick an analytics vendor and sign a DPA.** PostHog EU cloud is the
      recommendation in the plan. `lib/analytics.ts` is built and validating
      already — wiring a vendor is filling in one function body (`deliver()`).
- [ ] **Confirm the LLM providers' terms in writing.** `app/api/council/*` and
      `app/api/nuai/*` send user prompt text and watchlist context to OpenRouter
      and its upstreams. Nobody has verified zero-retention or no-training terms,
      and the free-model chain changes on its own, which can change the answer
      silently. This is the largest outbound flow of user-authored content in the
      system and the most under-examined item in this file.
- [ ] **Confirm DPAs exist** for Clerk, Neon, Vercel, Stripe, Resend. See
      [docs/privacy-register.md](privacy-register.md) §2 — every row marked
      `*verify*` is an assumption, not a fact.
- [ ] **Qualified pre-launch review of the privacy policy.** Plan §7 requires it,
      and `docs/privacy-register.md` is written to be the input. Do not publish
      the retention table until the enforcement job exists (§7 below).
- [ ] If any ad platform is used later: Meta and Google both restrict
      financial-services advertising and may require account verification before
      spend.

---

## 7. Engineering work that is still open (for completeness)

Not blocked on you — listed so this file is the full picture.

- **Retention enforcement job.** `docs/privacy-register.md` §3 documents targets;
  nothing enforces them. Until it exists, the policy must not publish that table
  or it repeats the over-promise this whole effort set out to close.
- **Restriction of processing (GDPR Art. 18).** Promised by privacy policy §8,
  still the one right with no mechanism.
- **Mobile parity.** `gcp3-mobile` tracks with no consent gate and has no
  data-subject-rights path, against the same Clerk identity. Two compliance
  asymmetries on one account. See `docs/wiki-portal/concept-sync-requirements.md`
  items 6, 7 and 8.

---

## Suggested order

1. **Neon API key + project ID** (§1) — turns CI green on both open PRs.
2. **Push the existing secrets** (§2) — unblocks the e2e and pipeline workflows.
3. **Clerk Production** (§3) — the live production bug.
4. **Stripe verification** (§4) — cheap, and checkout silently breaks without it.
5. **LLM provider terms** (§6) — the biggest unexamined risk here.
6. Everything else.
