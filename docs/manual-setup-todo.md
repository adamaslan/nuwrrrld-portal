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

**Updated 2026-09-03** with §0a — the nightly universe hydration has been dead
for 15 days on three missing secrets. This is now the top item in the file. The
`gh secret list` caveat below has also been **resolved**: the command was
re-run successfully and its output is recorded in §2.

Ordered by what unblocks the most.

---

## 0a. 🔴 The nightly universe hydration has been dead since 2026-08-19

**Verified 2026-09-03**, and this outranks everything else in this file:
`ticker_cards` holds 1,864 rows whose newest `bar_date` is **2026-08-19**.
Today is 2026-09-03. The universe has not been carded in 15 days.

Eleven consecutive scheduled runs have failed, each in ~25 seconds, before
touching Alpaca:

```
$ gh run list --workflow=hydrate-universe.yml --limit 12
completed  failure  Nightly universe hydration  schedule  2026-09-03T00:30:33Z  27s
completed  failure  Nightly universe hydration  schedule  2026-09-02T00:24:45Z  30s
… unbroken back to 2026-08-19 …

$ gh run view 33699802622 --log-failed
##[error]PORTAL_PUSH_SECRET is not set — the portal will reject every POST.
```

Cause: **`PORTAL_PUSH_SECRET`, `ALPACA_API_KEY` and `ALPACA_API_SECRET` do not
exist as repository secrets.** Seventeen others do (§2). All three exist in
`.env.local` — this is purely the §2 sync that was never run.

- [ ] `scripts/sync-hydration-secrets.sh`, then
      `gh secret list | grep -E 'PORTAL_PUSH_SECRET|ALPACA'` → expect 3 rows
- [ ] Smoke test: `gh workflow run hydrate-universe.yml -f limit=25`
- [ ] Confirm `max(bar_date) FROM ticker_cards` advances to the last trading day

**The workflow's own guard worked perfectly** — it named the missing secret and
failed red rather than writing zero cards and reporting green. What is missing
is anything that tells a human the red exists. Two follow-ups, both code, both
in Phase 1 of
[docs/signal-engine-three-phase-plan.md](signal-engine-three-phase-plan.md):

- [x] An `if: failure()` notification step on the workflow. **Done on
      `feat/signal-engine-phases-1-3`** — opens/updates a `hydration-failure`
      tracking issue on every red run (`issues: write` added to the workflow).
- [x] A **freshness check independent of the writer**. **Done** —
      `scripts/check-card-freshness.mjs` + `.github/workflows/signal-freshness-check.yml`
      (weekday 13:00 UTC) read `GET ?meta=freshness` and go red when
      `max(bar_date)` is more than `MAX_STALE_TRADING_DAYS` (default 3) old.
      Test the alert with `MAX_STALE_TRADING_DAYS=0`, not by waiting.

Also verified while here: `hydrate-universe.yml` reads `${{ vars.PORTAL_URL }}`,
but `PORTAL_URL` is registered as a **secret**, not a variable. The lookup
misses and falls through to the hardcoded `https://financial.nuwrrrld.com`.
That default is correct, so nothing is broken — but the reference reads as
configurable and is not.

- [x] Changed the workflow to `secrets.PORTAL_URL` on
      `feat/signal-engine-phases-1-3`. Registering `PORTAL_URL` as a *variable*
      instead is still fine if you prefer that; either way the misleading
      `vars.` lookup is gone.

### Still blocking — only a human can do these (unchanged by the code PR)

- [ ] **Push the three secrets** — `scripts/sync-hydration-secrets.sh`, then
      `gh secret list | grep -E 'PORTAL_PUSH_SECRET|ALPACA'` → expect 3 rows.
      Nothing in `feat/signal-engine-phases-1-3` can do this; the whole pipeline
      stays dead until it runs.
- [ ] **Smoke test** (Phase 1.2): `gh workflow run hydrate-universe.yml -f limit=25`,
      then `gh run watch`. Expect green, `written=50`, `calc-errors=0`.
- [ ] **First full scheduled run green**, then confirm `max(bar_date)` is the
      last trading day and the new freshness workflow passes.
- [ ] **Add repo labels** `hydration-failure` and `stale-signals` (or let the
      first failing run create them — `github-script` will 422 without
      pre-existing labels on some repo configs; safest to create them once).
- [ ] **(signals-app, Phase 1.6)** `OPENROUTER_API_KEY` is missing from that
      repo's secrets and blocks its production run — structurally identical to
      this outage. Do it in the same session.

Full analysis: [docs/signal-engine-parity-across-hosts.md](signal-engine-parity-across-hosts.md) §0.1.

---

## 0b. Signal-engine three-phase plan — what `feat/signal-engine-phases-1-3` did, and what it deliberately did not

That branch implements the **code-only** parts of Phases 1–3 of
[docs/signal-engine-three-phase-plan.md](signal-engine-three-phase-plan.md):

**Landed (code + tests):**

- Phase 1.3/1.4/1.5 — workflow `secrets.PORTAL_URL` fix, failure→issue alert,
  independent freshness check (see §0a).
- Phase 2.1 — Alpaca `next_page_token` pagination in `scripts/hydrate-local.mjs`
  with a per-chunk `pages= symbols=X/Y bars=` log line and a `pages>1` warning.
- Phase 2.2 — `lib/shared/hydration-constants.json` as the single source
  (`LOOKBACK_DAYS=365`, `CHUNK_SIZE=35`, `feed=iex`, `adjustment=split`,
  `MIN_BARS=40`, `MIN_COVERAGE_RATIO=0.95`), re-exported by `.ts` and `.mjs`,
  drift-pinned by a test. **Modal (`deploy/universe-hydration/modal_app.py`) is
  NOT wired to the JSON twin yet** — it lives in this repo but Modal reads its
  own constants. Porting that is the remaining half of 2.2.
- Phase 2.3 — `normalizeToAlpaca()` in `seed-signals-universe.mjs` rewrites
  `BRK-B`→`BRK.B` at ingest. **`BRK-B`/`BF-B` are still deactivated in
  `ticker_universe`** — re-run the seeder and `prune-universe.mjs --dry-run` to
  reactivate them (Phase 2.5), and verify `SCHW-PD` separately.
- Phase 2.4 — `isCryptoShaped()` rejects `*-USD`-style pairs at the `PUT`
  registration route. Existing crypto rows already in `ticker_universe` are not
  retroactively removed — deactivate them once (`UPDATE ticker_universe SET
  active=false WHERE ticker ~ '-USD$'`).
- Phase 3.2 — real `dataQuality`: `completeness(input) × barQuality(frameStats)`
  where `frameStats` (`barCount`, `nanRatio`, `staleTradingDays`) is measured by
  the compute host and threaded through the ingest route. Backward compatible —
  a host that omits `frameStats` gets the old completeness-only number.

**Deferred — needs a decision, a migration, or a full-universe run first:**

- [ ] **Phase 3.2 `reasons` persistence.** `qualityReport()` returns
      human-readable reasons but there is **no `ticker_cards` column** to store
      them. Adding one is a schema migration (`migrations/`) — do it deliberately,
      not as a drive-by. Until then reasons are compute-time only.
- [ ] **Phase 3.1 — one confluence implementation.** Not started. The plan wants
      confluence computed once in `lib/shared/card-policy.ts` with Modal and
      `hydrate-local.mjs` deleting their copies. The interim drift-pinning test
      (JS `confluence` vs captured Python `_confluence`) also needs **reference
      values captured by running `modal_app.py`'s `_confluence`** — do that
      capture before writing the test, or it pins nothing.
- [ ] **Phase 3.3 — relative strength / sector rank.** Not started. Needs the
      full ~950-symbol run to exist (Phase 2.6) and a server-side or
      second-pass computation — it cannot run inside a 35-symbol chunk. The CSV's
      `sector_group` column is parsed and discarded today.
- [ ] **Phase 3.4–3.6 — remaining detector families, MTF composite.** Not
      started; gated on 3.1 landing so detectors aren't ported twice.

---

## 0. What was broken (historical — see the 2026-09-03 resolution note below)

**`NEON_API_KEY`/`NEON_PROJECT_ID` now exist (set 2026-08-30) — the diagnosis
below is preserved for context, not the current cause of any remaining
failure.** If `integration` is still red, re-run it and read the fresh log
rather than assuming this is why.

The `integration` CI job originally failed on **every** branch —
`feat/consent-cookies-tracking` (PR #77) and `feat/auth-cookies-phase-1-3-6`
(PR #78) alike. It predated both.

```
env:
  NEON_API_KEY:                       <- empty
ERROR: Cannot run interactive auth in CI
```

`.github/workflows/integration-tests.yml` creates an ephemeral Neon branch per
run. With no API key, `neonctl` falls back to interactive auth and dies.

> **The earlier caution about `gh secret list` is resolved.** That command was
> flaky during the 2026-08-30 session (14 secrets, then 0 rows), so every
> "missing from GitHub" claim was marked unverified. It was re-run cleanly on
> **2026-09-03** and returned 17 secrets; the resulting present/absent split is
> recorded in §2 and is now fact, not assumption. Note that `NEON_API_KEY` and
> `NEON_PROJECT_ID` **do now exist** (set 2026-08-30) — so §1's first two rows
> are done, and the integration job's failure, if it persists, has a different
> cause than the one recorded above. Re-run it and re-read the log.

**Also broken (verified 2026-09-03 by live probe):** the `afternoon-pipeline.yml`
scheduler has no routes to call — `/api/pipeline/{signals-refresh,theses-score,
council-run,council-validate-distribution}` are absent from the repo and 404 in
production. `CRON_SECRET` is absent from `.env.local`; unless it is exported into
the environment another way (`scripts/local-trigger.mjs` layers `process.env`
over `.env.local`), local triggering has no token either. The GitHub Actions
secret state is unverified here — see the caution above. The `followed-tickers*`
routes are deployed but 503 unauthenticated. Full breakdown + probe table:
[docs/pipeline-route-status-issues.md](pipeline-route-status-issues.md).

---

## 1. Values that do not exist yet — you must create or fetch them

These are not in `.env.local`, so there is nothing to copy. Each has to be
generated or retrieved from a dashboard.

| Secret | Where to get it | Needed by | Status 2026-09-03 |
|---|---|---|---|
| `NEON_API_KEY` | Neon console → Account settings → API keys → Generate | `integration-tests.yml` | ✅ **set 2026-08-30** |
| `NEON_PROJECT_ID` | Neon console → Project settings → General. Looks like `wispy-forest-12345678` | `integration-tests.yml` | ✅ **set 2026-08-30** |
| `PORTAL_URL` | Just the deployed origin, e.g. `https://financial.nuwrrrld.com`. Also add to `.env.local` — `scripts/local-trigger.mjs` Path C reads it there. | `afternoon-pipeline.yml` + the other scheduled callers | ✅ set — but as a *secret*, see §0a |
| `CRON_SECRET` | Generate one: `openssl rand -hex 32`. Must match what the cron caller sends. Set it in **three** places: `.env.local` (for local `curl` / `scripts/local-trigger.mjs`), Vercel project env, and `gh secret set`. Not in `.env.local` today — only `PORTAL_PUSH_SECRET` is, and it is **not** interchangeable. | `afternoon-pipeline.yml`, `track/select/judge-followed-tickers.yml`, `precompute-ai.yml`, `hydrate-universe.yml`, `/api/retention/*` | ❌ absent |
| `GCP_WIF_PROVIDER` | GCP → IAM → Workload Identity Federation. Full resource path. | `e2e-resiliency.yml` | ❌ absent |
| `GCP_SERVICE_ACCOUNT` | GCP → IAM → Service accounts. The `...@....iam.gserviceaccount.com` address. | `e2e-resiliency.yml` | ❌ absent |

Three of the six are now done. **If the `integration` job is still red, its
cause has changed** — re-run it and read the current log rather than acting on
§0's recorded diagnosis.

The `secrets-sync` skill can provision the two GCP ones (keyless WIF, no JSON key
file) if you'd rather not click through it.

---

## 2. Values that exist locally — push them to GitHub Actions

These are all in `.env.local` already. **`gh secret list` was re-run cleanly on
2026-09-03** — the split below is verified, not assumed. Push only the absent
column.

**Absent from GitHub Actions — push these:**

| Secret | Consequence today |
|---|---|
| `PORTAL_PUSH_SECRET` | 🔴 **nightly hydration dead 15 days** (§0a) |
| `ALPACA_API_KEY` | 🔴 same job, second guard |
| `ALPACA_API_SECRET` | 🔴 same job, third guard |
| `STRIPE_WEBHOOK_SECRET` | every Stripe event rejected (§4) |
| `STRIPE_PRICE_ANNUAL` | annual plan advertised, unsellable (§4) |

The last two are **not** simple pushes — both are placeholder/empty locally, so
§4 must create real values first. Only the three Alpaca/portal secrets are a
straight file-to-CLI copy, and they are the highest-value three in this file.

**Already present (verified 2026-09-03) — do not re-push blindly:**

```
CLERK_SECRET_KEY  CLOUDFLARE_ACCOUNT_ID  CLOUDFLARE_API_TOKEN  DATABASE_URL
E2E_CLERK_TEST_EMAIL  E2E_CLERK_TEST_PASSWORD  IP_HASH_SECRET  MCP_BACKEND_URL
NEON_API_KEY  NEON_PROJECT_ID  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY  NULOGDASH_ADMIN_EMAILS  OPENROUTER_API_KEY
PORTAL_URL  STRIPE_PRICE_MONTHLY  STRIPE_SECRET_KEY
```

Two notes on that list. `NEON_API_KEY` / `NEON_PROJECT_ID` were set 2026-08-30,
which closes §1's first two rows. And `PORTAL_URL` is present as a **secret**,
which is why `hydrate-universe.yml`'s `vars.PORTAL_URL` lookup silently misses
(§0a).

Still absent and still blocking, per §1: `CRON_SECRET`, `GCP_WIF_PROVIDER`,
`GCP_SERVICE_ACCOUNT`.

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
      Stripe reveals the endpoint signing secret in **Workbench → Webhooks**
      (view it any time, not only at creation). Rotation offers two expiry
      modes: **expire immediately** (old secret invalid at once) or **keep the
      previous secret valid for up to 24 h** (Stripe signs with both during the
      window). Pick the 24 h delay unless you can update `.env.local`, Vercel,
      and GHA secrets in one window; document which mode you chose, and verify
      every deployed copy holds the new value before the old one expires.
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
      Note the state of each value before pushing (§2): a **configured** live ID,
      an **empty** string, a **placeholder** literal, or **absent** entirely —
      only the first is safe to `gh secret set`, and §2's list must not push the
      others as if they were real.
      Setting this ID alone does **not** re-enable billing while
      `STRIPE_WEBHOOK_SECRET` is still a placeholder (the webhook route rejects
      every event). Re-enable the `preflight-billing` Playwright tier only after
      *all* required live Stripe values are configured and `/api/health` reports
      Stripe healthy.
- [ ] **Rotate `STRIPE_SECRET_KEY` — before §2 pushes secrets, or re-push
      after.** Recorded as already exposed in
      [docs/env-rotation.md](env-rotation.md), separate from the unset values
      above. This is a create-charges-and-issue-refunds credential. Ordering
      matters: §2's sync copies `STRIPE_SECRET_KEY` from `.env.local` to GitHub
      Actions, so rotating *after* that leaves CI on the old key. Either rotate
      first, or add an explicit re-sync of this one value after rotation. After
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
      `free | trialing | active | past_due | canceled | paused`, and the Stripe
      webhook writes `sub.status` (`app/api/webhooks/stripe/route.ts`), never
      `'pro'`. A manual `'pro'` metadata write *does* store, but
      `tierFromStatus()` and `parseSubscriptionMetadata()`
      (`lib/subscription.ts`) both read it as `'free'` — `isSubscriptionStatus()`
      guards *reads*, not the write. Result: a paying customer with no access and
      no error anywhere. Assert on the **rendered gated page**, never on the
      metadata write succeeding.
- [ ] **Verify cancellation and downgrade**, the path nobody tests until a
      chargeback arrives. Confirm `customer.subscription.deleted` and
      `invoice.payment_failed` are both in the endpoint's event list and handled.
      A canceled subscriber should lose access at period end — not immediately
      (charging through the 28th and cutting off on the 3rd is a refund request)
      and not never.
      Decide `past_due` explicitly: `tierFromStatus()` currently maps it to
      `pro`, so a failed payment keeps full access. That is a defensible grace
      period, but make it a bounded *choice* rather than an accident.
- [x] ~~**Decide `PORTAL_PUSH_SECRET` — generate it or delete the dependency.**~~
      **Answered 2026-09-03, by evidence rather than by decision: the caller is
      real.** This item framed it as possibly-dead config, weighing
      `refresh-signals.py` and `/api/signals/digest`. It missed the actual
      consumer — **`.github/workflows/hydrate-universe.yml`**, a live scheduled
      job that has been failing nightly on this exact secret since 2026-08-19.
      The value already exists in `.env.local`; it was never pushed. See §0a —
      it is now the top item in this file.
      The lesson worth keeping: "is this dependency real?" was answerable the
      whole time by grepping the workflows for the secret name, and deferring it
      as a *decision* cost 15 days of universe coverage. A secret referenced by
      a scheduled workflow is never dead config.

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

- [ ] **Wire error monitoring.** There is none, by behavior not just by grep:
      `app/error.tsx` and `app/global-error.tsx` only `console.error`,
      `lib/analytics.ts` drops validated events, and `package.json`,
      `next.config.ts`, and `middleware.ts` carry no monitoring integration.
      Today the detection mechanism for a broken paid feature is a customer
      emailing you, so mean-time-to-detect equals customer patience.
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

## 5d. Scheduled-pipeline routes — the afternoon pipeline calls nothing

Verified 2026-09-03 by probing every `/api/pipeline/*` route on production.
Full table + reasoning: [docs/pipeline-route-status-issues.md](pipeline-route-status-issues.md).

- [ ] **Land the 4 `afternoon-pipeline` routes** — `signals-refresh`,
      `theses-score`, `council-run`, `council-validate-distribution`. Absent from
      the repo, 404 in production; the workflow has been non-functional since PR
      #59 (2026-08-14). This is code, not a login — tracked here only because it
      blocks the same scheduler the secret items above do. `precompute-ai` and
      `hydrate-universe` (which shipped in PR #66) are the working template.
- [ ] **Or disable the workflow** meanwhile:
      `gh workflow disable afternoon-pipeline.yml` — it currently files a
      `pipeline-failure` issue on every gate-clearing run.
- [ ] **Create the `pipeline-failure` label** —
      `gh label create pipeline-failure --color B60205 --description "Scheduled pipeline run failed"`.
      Every scheduled workflow's `notify` job references it; it doesn't exist, so
      the notify job itself errors (`'pipeline-failure' not found`).
- [ ] **Investigate the `followed-tickers*` 503s** — `followed-tickers`,
      `followed-tickers-select`, `followed-tickers-judge` are deployed but return
      503 to an unauthenticated request (before the 401 the auth layer should
      give). Something in each handler throws on a missing dependency. Needs a
      code + Vercel-log read, not a dashboard click.

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
      the active universe). Two facts, kept separate because the code paths are:
      **(1)** every ETF card lands at `dataQuality: 0.20` — gcp3's ETF payload
      fills only **1 of 5** taxonomy inputs (`confluenceScore`); `rsi`,
      `macdCross`, `adx`, and `volatilityPercentile` are out of scope for its
      ETF model entirely — so every ETF card fails `isExplainable()`
      (`dataQuality >= 0.8`, zero missing fields). **(2)** the scheduled
      precompute job (`deploy/precompute-ai/modal_app.py`) sends only
      `maxSubjects`, so it runs the **watchlist** path, not `topCards()`;
      `topCards()` feeds the batch only when a caller explicitly passes
      `source: "ranking"`, and on that path it currently yields no ETF subjects.
      **Plainly: the AI-explanation feature behind the paid tier has no
      explain-eligible subjects in the current universe, today, until one of
      these ships.**
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

## 8. Open PR queue — `/bugmerge1` pass 2026-09-04

A `/bugmerge1` run on 2026-09-04 drained the review-clean half of the queue:
**#95, #93, #98, #102 merged** (CodeRabbit comments addressed, rebased
conflict-free). Two PRs could not be finished automatically and need a human to
nudge the review bot, then re-run `/bugmerge1` (or `/bugz`) on them:

- [ ] **PR #97** (`feat/moo-council-simulation`) — CodeRabbit has **never
      completed a review**: the initial pass hit "Review limit reached" and a
      manual `@coderabbitai review` on 2026-09-04 01:43 UTC came back
      *"Review rate limited."* Wait out the CodeRabbit capacity window (check
      <https://app.coderabbit.ai/dashboard/review-capacity>), re-post
      `@coderabbitai review`, then triage/fix/merge. Touches real code
      (`lib/openrouter.ts`, `app/api/council/*`, `app/page.tsx`) so it should
      not be merged without a review.
- [ ] **PR #101** (`feat/signal-engine-phases-1-3`) — same situation
      (rate-limited 2026-09-04 01:43 UTC, no review ever completed). Also shows
      `mergeable: CONFLICTING` against `main` — it will need a `/reb` rebase
      before it can merge. Touches `lib/shared/*.ts`, pipeline route, tests.
- [ ] **`gh label create pipeline-failure`** — every scheduled pipeline
      workflow's `notify` job does `gh issue create --label pipeline-failure`
      against a label that doesn't exist, so the notify job itself fails. One
      command: `gh label create pipeline-failure --color B60205 --description
      "Scheduled pipeline run failed"`. Full context in
      [docs/pipeline-route-status-issues.md](pipeline-route-status-issues.md)
      (Issue 4).

---

## Suggested order

**One Stripe dashboard session covers three items** — the webhook secret, the
annual price, and the key rotation (§4). Do them together rather than three
separate logins.

0. **Push the three hydration secrets** (§0a) — **5 minutes, no dashboard, no
   decision.** It is the cheapest item in this file and the only one where the
   product is currently producing nothing at all. Every signal the app shows is
   15 days stale until this runs.
1. **Stripe: webhook secret + annual price** (§4) — until these are set you
   cannot record a payment, and you are advertising a plan you cannot sell.
   Everything else assumes revenue works.
2. ~~**Neon API key + project ID** (§1)~~ — **done 2026-08-30.** Re-run the
   integration job and read the current failure, if any.
3. **Rotate `STRIPE_SECRET_KEY`** (§4) — do this *before* step 4 so the synced
   value is the rotated one; same dashboard session as step 1.
4. **Push the remaining existing secrets** (§2) — unblocks the e2e workflows.
5. **Clerk Production** (§3) — the live production bug.
6. **Decide the explain-quality path** (§6b) — the AI tier currently produces
   nothing; this gates whether the paid feature exists at all.
7. **Error monitoring + uptime check** (§5c) — cheap, and until then an outage
   is detected by customer email.
8. **GCP WIF + re-run the frontend tier** (§5b) — turns the e2e suite from
   decorative back into a gate.
9. **LLM provider terms** (§6) — the biggest unexamined legal risk here.
10. Everything else.
