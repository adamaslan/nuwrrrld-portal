# Manual setup TODO — things only a human with dashboard access can do

Everything in this file is blocked on a login, a signature, a value that does
not exist yet, or a decision only the owner can make. None of it is a code
change. It is the complete set of external tasks standing between the current
branch and a production-ready deploy, gathered 2026-08-29 while finishing
[docs/todo-auth-cookies-tracking.md](todo-auth-cookies-tracking.md).

**Updated 2026-08-30** with the blocked items from
[docs/ship-to-clients-top-25.md](ship-to-clients-top-25.md) — that document
ranks *all* remaining work by revenue impact; this one holds only the subset a
human has to unblock. Where they overlap, this file is the checklist and that
one is the reasoning. New here: the expanded Stripe section (§4), CI/test
infrastructure (§5b), observability (§5c), and the explain-quality product
decision (§6b).

**Also verified against live APIs 2026-08-30** (Neon API, `gcloud`,
`gh secret list`). Several claims in the 08-29 draft were already stale — the
Neon items are done, and the two GCP ones cannot be fetched at all. Those
corrections live in §0–§1.2 below, with the original reasoning preserved
rather than silently deleted.

Ordered by what unblocks the most.

---

## 0. State as of the 2026-08-30 verification pass

The 08-29 draft opened by calling the `integration` CI failure "the single
highest-value fix in this document." **That is now resolved.** A Neon project
named `portal-ci` was created 2026-08-30 06:24 UTC, and `NEON_PROJECT_ID` was
pushed to GitHub Actions at 06:24 — one minute later. `NEON_API_KEY` had
already been pushed at 06:10. Both are confirmed present via `gh secret list`.

The draft also warned that `gh secret list` had returned 14 rows and then 0
rows minutes apart, and told the reader to re-run it. That was done. The list
is stable and is reproduced in §2.

One correction worth stating plainly, because the draft asserted the opposite:
**`NEON_API_KEY` was in `.env.local` the whole time.** The draft's §1 listed it
under "values that do not exist yet — there is nothing to copy." It did exist.
The CI job read empty because the *GitHub secret* was unset, not because the
value was unavailable locally. The distinction matters: the fix was a push, not
a dashboard visit.

`NEON_DB_API_KEY`, also in `.env.local`, is **dead** — it returns
`not authenticated`. It is not referenced by any workflow. Delete it or
regenerate it; leaving a dead credential in `.env.local` invites someone to
try it and misread the failure.

---

## 0.5 `PORTAL_PUSH_SECRET` vs `CRON_SECRET` — not the same secret

This came up as a direct question and the answer is **no, they are distinct**,
deliberately so. They are two different bearer tokens guarding two different
route families, and conflating them would widen the blast radius of either one
leaking.

| | `PORTAL_PUSH_SECRET` | `CRON_SECRET` |
|---|---|---|
| **In `.env.local`?** | yes | **no — must be generated** |
| **In GitHub Actions?** | **no — must be pushed** | **no — must be created** |
| **Who sends it** | Modal universe-hydration job, precompute-AI workflow, e2e-resiliency | scheduled pipeline workflows |
| **Routes** | `/api/signals/{drain,live,refresh,digest,top}`, `/api/pipeline/{precompute-ai,hydrate-universe}`, `/api/privacy/delete` | `/api/pipeline/{signals-refresh,council-run,theses-score,council-validate-distribution,followed-tickers,followed-tickers-select,followed-tickers-judge}`, `/api/retention/{digest-email,trial-nudge}` |

The codebase is explicit about the separation. `middleware.ts:17-18` documents
both as `internal-secret` callers, and
`app/api/pipeline/followed-tickers-select/route.ts:15-16` carries a comment
written specifically to stop this substitution:

> `Auth: Bearer CRON_SECRET (not PORTAL_PUSH_SECRET — the workflow sends CRON_SECRET, per the doc's "Secrets required")`

`.github/workflows/hydrate-universe.yml:18` makes the same point from the
workflow side. **Do not set them to the same value.** The reason the separation
is worth its cost: `PORTAL_PUSH_SECRET` reaches a third-party runtime (Modal),
while `CRON_SECRET` stays inside GitHub Actions. One shared value would mean a
Modal compromise also grants the retention and council-run endpoints.

`PORTAL_URL` is not a secret at all — it is just the deployed origin
(`https://financial.nuwrrrld.com`). It is stored as an Actions secret only
because some workflows read it via `secrets.PORTAL_URL`; others already read
`vars.PORTAL_URL` with that same origin as an inline default
(`precompute-ai.yml:47`, `hydrate-universe.yml:113`). **Set 2026-08-30.**

---

## 1. Values that still do not exist — you must create or fetch them

Two of the six rows in the 08-29 draft are now done. What remains:

| Secret | Status | Where to get it | Needed by |
|---|---|---|---|
| `NEON_API_KEY` | ✅ **done** — in `.env.local`, pushed 06:10 | — | `integration-tests.yml` |
| `NEON_PROJECT_ID` | ✅ **done** — `portal-ci`, pushed 06:24 | — | `integration-tests.yml` |
| `CRON_SECRET` | ❌ **missing everywhere** | `openssl rand -hex 32`, then `gh secret set CRON_SECRET`. Must **not** equal `PORTAL_PUSH_SECRET` — see §0.5. | `afternoon-pipeline.yml`, `track/select/judge-followed-tickers.yml`, `/api/retention/*` |
| `PORTAL_URL` | ✅ **done** — set 2026-08-30 | — | `afternoon-pipeline.yml` and the three followed-tickers workflows |
| `GCP_WIF_PROVIDER` | ❌ **nothing to fetch — see §1.1** | must be *provisioned*, not looked up | `e2e-resiliency.yml` |
| `GCP_SERVICE_ACCOUNT` | ❌ **nothing to fetch — see §1.1** | must be *created*, not looked up | `e2e-resiliency.yml` |

### 1.1 The two GCP values cannot be "fetched" — nothing exists yet

The 08-29 draft said to get these from "GCP → IAM → Workload Identity
Federation" and "GCP → IAM → Service accounts," which reads as though the
values are sitting in a console waiting to be copied. **They are not.**
Verified 2026-08-30 against project `nuwrrrld-auth-1` (project number
`614983520880`):

```
$ gcloud iam service-accounts list --project=nuwrrrld-auth-1
Listed 0 items.

$ gcloud iam workload-identity-pools list --location=global --project=nuwrrrld-auth-1
Listed 0 items.
```

Zero service accounts. Zero identity pools. `e2e-resiliency.yml:197-198`
already says as much in a comment — "GCP_WIF_PROVIDER and GCP_SERVICE_ACCOUNT
were never created (no workload identity pool …)" — and that comment is
accurate. This is a provisioning task, not a retrieval task.

Nine GCP projects are visible on the account. The plausible targets are
`nuwrrrld-auth-1` (`614983520880`) and `nuwrrrld-financial-1`
(`881236483085`); **which one should host the pool is an open decision**, and
it should be made before provisioning rather than discovered afterward.

The `secrets-sync` skill provisions this keyless (WIF, no JSON key file). Once
the pool exists, `GCP_WIF_PROVIDER` takes the form:

```
projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/providers/<PROVIDER_ID>
```

**Before doing any of this, confirm the work is still wanted.** `e2e-resiliency.yml`
is the only consumer, commit `bbd70fb` is titled *"fix(e2e): drop the GCP auth
step that nothing used,"* and the surrounding comment says the job hits
`/market-overview` with no credential. It is entirely possible these two
secrets are vestigial and the correct action is to delete the references rather
than provision a pool to satisfy them. That question is cheaper to answer than
the provisioning is to perform.

---

## 1.2 Neon: which project is which

Four projects exist under org `Adam Timur`:

| Project ID | Name | Role |
|---|---|---|
| `delicate-flower-88386753` | **`portal-ci`** | CI. Created 2026-08-30, Postgres 17, `aws-us-east-1`, single default branch `main`. This is the `NEON_PROJECT_ID` value. |
| `aged-river-88233274` | `fin-app1` | unrelated |
| `calm-voice-03527469` | `ttb1a` | unrelated |
| `fancy-tree-64646574` | `dfl-auth1` | unrelated |

**The production database is not among them.** The `DATABASE_URL` in
`.env.local` points at endpoint `ep-muddy-firefly-ahh8328s-pooler`, which
matches no endpoint in any of the four projects this API key can see, and the
key's org has no shared projects. Production therefore lives under a different
Neon account or org.

That is not a problem for CI — `portal-ci` is a purpose-built empty project and
CI mints ephemeral branches from it. But it does mean **`NEON_API_KEY` cannot
reach production**, so do not reach for it expecting to inspect or migrate the
live database. Two consequences worth writing down:

- The §5 migration check below must be run against production credentials, not
  this API key.
- The draft's own warning against pushing production `DATABASE_URL` into CI is
  now structurally enforced rather than merely advised: the CI project and the
  production project are genuinely different projects.

---

## 2. Values that exist locally — push them to GitHub Actions

`gh secret list` re-run 2026-08-30, stable across runs. **16 secrets present:**

```
CLERK_SECRET_KEY          CLOUDFLARE_ACCOUNT_ID   CLOUDFLARE_API_TOKEN
DATABASE_URL              E2E_CLERK_TEST_EMAIL    E2E_CLERK_TEST_PASSWORD
IP_HASH_SECRET            MCP_BACKEND_URL         NEON_API_KEY
NEON_PROJECT_ID           NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY               NULOGDASH_ADMIN_EMAILS
OPENROUTER_API_KEY        STRIPE_PRICE_MONTHLY    STRIPE_SECRET_KEY
```

Plus `PORTAL_URL`, set during this pass. **`gh variable list` is empty** —
worth noting because `precompute-ai.yml:47` and `hydrate-universe.yml:113` read
`vars.PORTAL_URL`, which is unset and silently falls back to the hardcoded
`https://financial.nuwrrrld.com`. That fallback happens to be correct, so
nothing is broken, but the two workflows are reading a variable that does not
exist.

### Still absent from GitHub, present in `.env.local`

```
PORTAL_PUSH_SECRET    STRIPE_PRICE_ANNUAL    STRIPE_WEBHOOK_SECRET
ALPACA_API_KEY        ALPACA_API_SECRET
```

`STRIPE_PRICE_ANNUAL` being absent while `STRIPE_PRICE_MONTHLY` is present is
the kind of asymmetry that produces a checkout that works on one plan and 500s
on the other. Worth fixing even before the §4 live-mode audit.

Push them with the committed script, which pipes each value from the file
straight into `gh` — no value is printed, and none passes through a chat
session:

```bash
./scripts/push-github-secrets.sh --dry   # confirm the set first
./scripts/push-github-secrets.sh
```

It deliberately **excludes `DATABASE_URL`** for the reason in §1.2: CI mints its
own ephemeral branch from `portal-ci`, and pushing the production URL would
point integration tests at the live database.

Then create the one secret that exists nowhere yet:

```bash
openssl rand -hex 32 | tr -d '\n' | gh secret set CRON_SECRET
```

and set the same value in the Vercel project env so the routes can verify what
the workflows send. A `CRON_SECRET` that differs between the caller and the
portal fails closed — every scheduled pipeline 401s — which is the safe
direction, but it fails silently from the workflow's point of view.

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

## 4. Stripe — **this section is where money is actually lost**

Ranked by revenue consequence, not effort. The first two items are the reason
this app cannot currently take a paying customer end-to-end. Full reasoning and
retrieval steps: [docs/stripe-todo.md](stripe-todo.md); business framing:
[docs/ship-to-clients-top-25.md](ship-to-clients-top-25.md) items 1–6.

- [ ] **`STRIPE_WEBHOOK_SECRET` — a real `whsec_…` for the production endpoint.**
      Currently a `whsec_placeholder_*` value. Until it's real,
      `app/api/webhooks/stripe/route.ts` logs a `CONFIG_ERROR` and **rejects
      every event Stripe sends**. Concretely: a customer completes checkout,
      Stripe charges their card, the portal never learns about it, and they stay
      on the free tier. They paid and got nothing, with no error visible to
      them. This is the single most expensive open item in the repo.
      Stripe shows the signing secret **once** at endpoint creation. **Roll
      secret** invalidates the old value immediately — only roll if you can
      update `.env.local`, Vercel, and GHA secrets in the same window.
      `app/api/health` surfaces the current state; check it rather than trusting
      the env file.
- [ ] **`STRIPE_PRICE_ANNUAL` — create the price, then set it.** Unset today, so
      `lib/stripe.ts`'s `PRICES.annual` resolves to `''`. The pricing page
      advertises the annual plan ("Best value — save 34%"), and selecting it
      sends an empty price ID to Checkout, which errors. **You are advertising a
      plan you cannot sell.**
      Decide the amount *before* creating it: Stripe price objects are
      immutable, so changing it later means archive-and-recreate, and archiving
      only affects new subscriptions — you would be grandfathering the wrong
      number. Also confirm `STRIPE_PRICE_MONTHLY` is a **live-mode** ID.
      Fixing this one variable also re-enables the whole `preflight-billing`
      Playwright tier, which is disabled by design while `/api/health` reports
      Stripe `not_configured`.
- [ ] **Rotate `STRIPE_SECRET_KEY`.** Recorded as already exposed in
      [docs/env-rotation.md](env-rotation.md), separate from the unset values
      above. This is a create-charges-and-issue-refunds credential. After
      rotating, confirm the old key is **revoked**, not merely superseded — a
      rotated-but-still-valid key is not rotated.
- [ ] Point the production webhook endpoint at `/api/webhooks/stripe` and verify
      a test event is accepted (signature verification is already implemented).
      Confirm the endpoint's selected event list actually includes what the
      route's switch handles — check the file, don't select "all events".
- [ ] **Verify one real paid signup end to end**, not a unit test: checkout →
      webhook received → Clerk `publicMetadata.subscription_status` → the three
      entitlement-gated routes (`/dashboard/nuai`, `/dashboard/signals`,
      `/dashboard/portfolio`) render instead of redirecting to `/pricing`.
      **The trap:** `subscription_status` has no `'pro'` value. Valid values are
      `free | trialing | active | past_due | canceled | paused`, and
      `tierFromStatus()` (`lib/subscription.ts:88`) derives the tier from them.
      Writing `'pro'` literally is silently rejected by `isSubscriptionStatus()`
      and falls back to `'free'` — a paying customer with no access and no error
      anywhere. Assert on the **rendered gated page**, never on the metadata
      write succeeding.
- [ ] **Verify cancellation and downgrade**, the path nobody tests until a
      chargeback arrives. Confirm `customer.subscription.deleted` and
      `invoice.payment_failed` are both in the endpoint's event list and handled.
      A canceled subscriber should lose access at period end — not immediately
      (charging through the 28th and cutting off on the 3rd is a refund request)
      and not never.
      Decide `past_due` explicitly: `tierFromStatus()` currently maps it to
      `pro`, so a failed payment keeps full access. That is a defensible grace
      period, but make it a bounded *choice* rather than an accident.
- [ ] **Decide `PORTAL_PUSH_SECRET` — generate it or delete the dependency.**
      Binary, and deferring it again is the only wrong answer. If either caller
      is real (`refresh-signals.py` pushing to `/api/signals/refresh`, or an
      internal reader of `/api/signals/digest`), run `openssl rand -hex 32` and
      set the same value in both places. If neither is deployed, it is dead
      config — `/api/signals/refresh` rejects pushes and `/api/signals/digest`
      correctly falls back to requiring a Clerk session. Remove the placeholder
      so `sync-e2e-secrets.sh` stops reporting a permanent false blocker.

---

## 5. Neon

- [x] Generate the API key + project ID from §1 — **done 2026-08-30**;
      `portal-ci` (`delicate-flower-88386753`) is the CI project.
- [ ] Run the table check below against **production** credentials, not
      `NEON_API_KEY` — that key cannot see the production project (§1.2).
- [ ] Decide what to do with the dead `NEON_DB_API_KEY` in `.env.local` (§0).
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

## 5b. CI and test-infrastructure blockers

These keep a 34-test Playwright suite and two CI checks permanently red. A suite
that always fails for an environmental reason is worse than no suite: people
learn to ignore it, which also masks the real failures underneath.

- [ ] **Provision the GCP Workload Identity Federation pool.** All four `e2e`
      shards fail immediately at "Authenticate to GCP (keyless)" because
      `GCP_WIF_PROVIDER` is empty (§1 above).
      → `bash scripts/sync-e2e-secrets.sh --provision-wif`, then grant the
      printed service account **only** `roles/run.invoker` on `gcp3-backend`.
      Resist broader roles to make it work faster — a CI service account with
      excess IAM is a finding on any client security review.
      Needs `gcloud` auth with IAM permissions on the target project.
- [ ] **Re-run the `frontend` Playwright tier and confirm two known bugs are
      actually closed.** The E2E user's Pro entitlement was patched
      (`known-bugs.md` item 1) but the tier was **never re-run to verify**. Item
      3 (portfolio-suggestions failure) is explicitly suspected to be the same
      redirect-to-`/pricing` cause. You may be one command from closing both,
      and right now you don't know which recorded failures are still real.
- [ ] **Resolve `shared-drift-check`.** `lib/subscription.ts` has drifted from
      its `gcp3-mobile` counterpart. This is a genuine cross-repo decision —
      which repo owns the canonical tier logic — not a lint failure to suppress.
      Note it guards exactly the file whose `subscription_status` semantics the
      §4 trap lives in: drift here means the two surfaces can disagree about who
      is a paying customer.
- [ ] **Disable the Cloudflare Pages integration.** One API call; see
      [docs/cloudflare-pages-assessment.md](cloudflare-pages-assessment.md).

---

## 5c. Observability — you currently cannot detect an outage

Not dashboard-blocked in the same way as the sections above, but both need an
account and a decision, so they belong on a human's list.

- [ ] **Wire error monitoring.** There is none: grepping `lib/` and `app/` for
      `sentry|posthog|datadog|opentelemetry` returns nothing across all 44 API
      route files. Today the detection mechanism for a broken paid feature is a
      customer emailing you, so mean-time-to-detect equals customer patience.
      Sentry's Next.js SDK is the shortest path. The bar is low — *any* alerting
      beats none. Wire it, trigger one deliberate error, confirm it lands.
      (Note this pairs with the analytics DPA decision in §6: if PostHog is
      chosen there, it can cover part of this.)
- [ ] **Point an external uptime monitor at `/api/health`.** The route already
      exists and reports per-dependency status — it is what surfaces the Stripe
      misconfiguration in §4. Nothing is watching it. This is the cheapest item
      in this file and covers the half that Sentry cannot: out-of-process death,
      as opposed to in-process exceptions.

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

## 6b. The one product decision only you can make

- [ ] **Decide how to close the explain-quality gate — before selling the AI
      tier, not after.** This is the largest open item in the whole project and
      the least visible from outside.
      The live pipeline run in
      [docs/pipeline-todo-blockers.md](pipeline-todo-blockers.md) proved the
      coverage claim is real (54 symbols, 108 cards, **0 model calls**, 100% of
      the active universe). It also proved this: `topCards()` — the
      explain-eligible ranking the AI batch reads from — returns **empty**.
      Every ETF card fails `isExplainable()`, which needs `dataQuality >= 0.8`
      and zero missing fields. gcp3's ETF payload fills **1 of 5** taxonomy
      inputs (`confluenceScore`); `rsi`, `macdCross`, `adx`, and
      `volatilityPercentile` are out of scope for its ETF model entirely. Every
      card lands at `dataQuality: 0.20`.
      **Plainly: the AI-explanation feature behind the paid tier returns nothing
      for the entire current universe, today, permanently, until one of these
      ships.**
      - **(a)** Extend gcp3 to compute RSI/MACD/ADX/volatility for its 54 ETFs.
        It already has `features_rsi.py` and friends; they are simply not wired
        into the ETF path. Lower ceiling, much shorter runway.
      - **(b)** Ship the Modal stock lane and accept that ETF cards stay
        coverage-only forever — real coverage, never explainable.
      Every other item in this file is recoverable after a customer complains.
      This one means the complaint is "the product does nothing."

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

**One Stripe dashboard session covers three items** — the webhook secret, the
annual price, and the key rotation (§4). Do them together rather than three
separate logins.

1. **Stripe: webhook secret + annual price** (§4) — until these are set you
   cannot record a payment, and you are advertising a plan you cannot sell.
   Everything else assumes revenue works.
2. ~~Neon API key + project ID~~ — **done 2026-08-30** (§1). `portal-ci`
   exists and both secrets are in GitHub Actions.
3. **Push the five remaining local secrets + create `CRON_SECRET`** (§2) —
   `./scripts/push-github-secrets.sh` covers the first five; `CRON_SECRET`
   must be generated and must **not** equal `PORTAL_PUSH_SECRET` (§0.5).
4. **Clerk Production** (§3) — the live production bug.
5. **Rotate `STRIPE_SECRET_KEY`** (§4) — same dashboard session as step 1.
6. **Decide the explain-quality path** (§6b) — the AI tier currently produces
   nothing; this gates whether the paid feature exists at all.
7. **Error monitoring + uptime check** (§5c) — cheap, and until then an outage
   is detected by customer email.
8. **Decide whether the GCP/WIF work is wanted at all** (§1.1), *then*
   provision and re-run the frontend tier if so (§5b). Nothing exists to
   fetch, and `bbd70fb` already dropped the e2e auth step that used it —
   the references may be vestigial. Answering that is cheaper than
   provisioning a pool to satisfy them.
9. **LLM provider terms** (§6) — the biggest unexamined legal risk here.
10. Everything else.
