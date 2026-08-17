# Playwright TODO

Working list of what's blocking the `e2e/` suite from being useful, and where
it should grow next. Written 2026-08-17 against the build-out described in
`docs/e2e.md` and `docs/wiki-portal/entity-playwright-e2e.md` — read those
first for the *why* behind any item here.

---

## Blockers (nothing downstream works until these are resolved)

### 1. Nothing here is committed

`git status --short` shows `e2e/`, `playwright.config.ts`,
`.github/workflows/e2e-resiliency.yml`, and
`scripts/nulogdash-merge-e2e.mjs` all untracked. This is the exact
written-but-never-committed failure `concept-test-strategy.md` already flags
for 19 of 29 vitest files, and `wiki-guard` exists specifically because it
happened to wiki content twice. Nothing in this list matters until this is
fixed — a clone right now gets zero of this suite.

**Action:** `git add e2e/ playwright.config.ts .github/workflows/e2e-resiliency.yml scripts/nulogdash-merge-e2e.mjs package.json package-lock.json .env.example docs/e2e.md docs/wiki-portal/entity-playwright-e2e.md` and commit. Don't split across many small commits — one PR, since the pieces only work together.

### 2. Clerk test user — created, not fully wired yet

**Status: partially done (2026-08-17).** A dedicated Clerk test user was
created and `E2E_CLERK_TEST_EMAIL`/`PASSWORD` are set in `.env.local`. Two
things still needed before the `frontend` project (16 of 31 tests —
`nuai-fault-injection`, `portfolio-health`, `signal-timing`) actually works:

- [ ] **Add the test user's email to `NULOGDASH_ADMIN_EMAILS`** — currently
      empty/unset in `.env.local`. Needed for future-test-idea #5 (nulogdash
      admin-gate coverage) and for anything that exercises admin-only paths.
      Not required for the existing `frontend` specs, which don't touch
      nulogdash.
- [ ] **Give the test user a subscription tier that unlocks Pro-gated
      features** (`hasEntitlement` checks in `portfolio/health-ai`, `nuai`),
      so fault-injection tests reach the code paths behind them, not just the
      403 upgrade wall. Not yet confirmed done.
- [ ] Run `npm run test:e2e:login` once (`--headed` is already wired into
      that script) to prove the handshake works end to end and catch a Clerk
      UI change before CI does.
- [ ] **Push `E2E_CLERK_TEST_EMAIL`/`PASSWORD` to GitHub Actions secrets** —
      see blocker 4, now scriptable via `bash scripts/sync-e2e-secrets.sh`
      (wraps the new `secrets-sync` skill's shared script; never pastes a
      value through a chat session — see `docs/env-rotation.md` for why that
      discipline matters here specifically).

### 3. GCP Workload Identity Federation pool isn't provisioned

`.github/workflows/e2e-resiliency.yml` references
`secrets.GCP_WIF_PROVIDER` / `secrets.GCP_SERVICE_ACCOUNT`, both currently
undefined. `docs/e2e.md` §8 documents the workflow side; the GCP-console side
is now scriptable (2026-08-17):

**Action:**
```bash
bash scripts/sync-e2e-secrets.sh --provision-wif [gcp-project-id]
```
Provisions a WIF pool + OIDC provider scoped to
`adamaslan/nuwrrrld-portal`, creates a service account, and prints the two
resulting identifiers for review before pushing them. **Still manual after
that:** grant the printed service account the specific least-privilege IAM
role the MCP identity-token step actually needs (e.g. `roles/run.invoker` on
the `gcp3-backend` Cloud Run service) — the script deliberately grants
nothing beyond `roles/iam.workloadIdentityUser`. Do this before merging
blocker 1 — an unauthenticated `auth` job step will hard-fail every CI run
otherwise.

### 4. Repo secrets — 11/13 done (2026-08-17)

`ANTHROPIC_API_KEY` was eliminated entirely (2026-08-17) — it was unused
dead code end to end (unread by any route, `lib/env.ts`'s schema field was
never imported anywhere, `@anthropic-ai/sdk` is a `package.json` dependency
nothing calls). Removed from `lib/env.ts`, `.env.example`,
`e2e/preflight/credentials.spec.ts`, `scripts/sync-e2e-secrets.sh`,
`.github/workflows/e2e-resiliency.yml`, and `docs/e2e.md`'s env contract
table. The contract is now 13 vars, not 14.

`bash scripts/sync-e2e-secrets.sh` has run once. **11/13 pushed** —
confirmed via `gh secret list` (names only, no values):
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `OPENROUTER_API_KEY`,
`MCP_BACKEND_URL`, `DATABASE_URL`, `STRIPE_SECRET_KEY`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_MONTHLY`,
`IP_HASH_SECRET`, `E2E_CLERK_TEST_EMAIL`, `E2E_CLERK_TEST_PASSWORD`.

**Still not pushed** (placeholder/empty in `.env.local`, skipped by the
script rather than failed):
- [ ] `NULOGDASH_ADMIN_EMAILS` — empty. Add the Clerk test user's email here.
- [ ] `STRIPE_WEBHOOK_SECRET` — see `docs/stripe-todo.md`.
- [ ] `STRIPE_PRICE_ANNUAL` — see `docs/stripe-todo.md`.
- [ ] `PORTAL_PUSH_SECRET` — see `docs/stripe-todo.md` (not Stripe-specific,
      but grouped there since it's another "generate/create this yourself"
      value with no existing reference to copy from).

**Action once those four are filled in `.env.local`:**
```bash
bash scripts/sync-e2e-secrets.sh --dry-run   # confirm what would be pushed, by name only
bash scripts/sync-e2e-secrets.sh             # actually push
```
Wraps the `secrets-sync` skill's shared script
(`~/.claude/scripts/sync-secrets.sh`) — never prints a real value. Run it
locally yourself — see `docs/env-rotation.md` for why this shouldn't be run
by pasting `.env.local` contents into a chat session first.

### 5. `.nulogdash/latest.json` merge has never run against real browser results

`scripts/nulogdash-merge-e2e.mjs` was verified against a `preflight`-only run
(all failures, since blockers 2–4 weren't resolved yet) — it has never
actually merged a `frontend`-tier pass/fail into the dashboard. The
`browserResults`/`browserCounts` rendering in
`app/dashboard/nulogdash/page.tsx` is unverified against real data as a
result.

**Action:** once blocker 2 is resolved, run
`npm run test:e2e:nulogdash` locally and actually load
`/dashboard/nulogdash` to confirm the browser-tier section renders sensibly
— particularly that long `DIAGNOSE:`/`EXPOSE:` test titles don't break the
table layout.

---

## Optimization (works today, worth tightening)

- **`data-testid` hooks.** Every frontend spec currently targets CSS classes
  (`.nuai-error`, `.port-health-error`, `.signal-score`) or text/ARIA roles.
  These are more prone to silent drift than dedicated test hooks — a
  Tailwind refactor could rename a class without anyone noticing the tests
  broke until CI runs. Not yet decided whether to add `data-testid` or
  accept the tradeoff (asserting on real classes also catches accidental
  visual regressions a testid wouldn't). See `entity-playwright-e2e.md`
  open questions.
- **Shard count tuning.** `e2e-resiliency.yml` hardcodes `shard: [1,2,3,4]`.
  Once the full suite actually runs in CI, check whether 4 shards is
  over-provisioned for ~31 tests (likely — this was sized for the
  eventual suite, not today's). Fewer shards = less GHA minutes burned on
  startup/teardown overhead per shard.
- **`fullyParallel: false` locally.** Currently serial by design (shared
  route mocks, live-provider rate limits). Once `frontend` specs stop
  sharing `page.route()` state in ways that would break under parallelism,
  revisit whether local runs can parallelize within a project — faster
  iteration loop while writing new tests.
- **`STALE_AFTER_MS` (6 days) has never been exercised.** Nobody has run this
  suite for 6+ consecutive days yet, so the auto-re-auth path in
  `auth.setup.ts` is unverified in practice. Worth deliberately testing by
  backdating the mtime on `playwright/.auth/user.json` once real credentials
  exist (`touch -t` to 7 days ago, confirm `auth-setup` re-runs rather than
  skipping).
- **CI blob-report retention vs. local `test-results/`.** Local runs
  currently leave `test-results/` and `playwright-report/` on disk
  indefinitely (gitignored, but not cleaned). Consider a `pretest:e2e`
  script that clears both before each local run, so a stale trace from a
  fixed bug doesn't get mistaken for a new one.
- **`e2e/ci/refresh-free-models.spec.ts` needs live network.** 2 of its 5
  tests hit real `openrouter.ai` endpoints (confirmed during this
  build-out — this sandbox's connectivity was intermittent, which is a real
  signal: these tests are flaky exactly where the underlying script is
  flaky). Consider whether `--offline`-safe versions are worth adding
  alongside, so the safety-invariant checks (never write on dry-run, refuse
  to run without a key) can run without a real network dependency, keeping
  the live ones as an explicit opt-in tier the way vitest's `live` project
  already works.

---

## Future robust test ideas

Ranked roughly by how much they'd raise confidence per unit of effort, in
the spirit of `concept-test-strategy.md`'s own "what would actually raise
confidence" section.

1. **Cross-tab / concurrent-session Stripe checkout race.** Two tabs both
   hitting "Upgrade" for the same user — does the webhook handler
   double-provision, or does the second checkout session correctly no-op?
   Nothing in the current suite touches concurrent state.
2. **Clerk session expiry mid-interaction.** The `auth-setup` project
   guarantees a *fresh* session at test start, but nothing simulates a
   session expiring 30 seconds into a long-running interaction (e.g.
   mid-stream on `/dashboard/nuai`). Real users will hit this; the app's
   behavior here is currently untested end to end.
3. **Webhook replay / idempotency for Stripe.** `app/api/webhooks/stripe`
   presumably has idempotency handling — no e2e test currently fires the
   same webhook event twice and confirms a single side effect.
4. **`/api/signals/refresh` and `/api/signals/digest`'s internal
   bearer-secret path** (`PORTAL_PUSH_SECRET`) — the non-Clerk
   server-to-server auth lane described in `.env.example` has zero coverage
   in `e2e/`. Worth a small `ci`-tier suite (no browser needed) that POSTs
   with a correct/incorrect/missing bearer token and asserts the three
   distinct outcomes.
5. **nulogdash dashboard's own admin gate**, browser-tier. `nulogdash-admin.test.ts`
   covers `isNulogdashAdmin` at the unit level; nothing exercises the actual
   404-vs-200 behavior in a real browser session for an allowlisted vs.
   non-allowlisted user. Needs a second Clerk test user (non-admin) alongside
   the one from blocker 2.
6. **Mobile viewport fault injection.** Every `frontend` spec runs
   `devices['Desktop Chrome']` only. `gcp3-mobile` is a separate app, but the
   *web portal* itself is presumably responsive — nothing here confirms the
   fault-injection UI states (error banners, disabled buttons) remain usable
   at a phone viewport width.
7. **Rate-limit exhaustion for `/api/nuai`'s daily token budget.** The
   incident doc notes `health-ai` is unmetered but `/api/nuai` has
   `checkRateLimit`/`getRemainingBudget`. No e2e test currently drives a
   session to the actual daily limit and confirms the "Daily limit reached"
   UI state (`nuai-limit` class, confirmed to exist in `NuAIChat.tsx`) renders
   correctly rather than just unit-testing the budget math.
8. **Disclaimer-gate regression suite.** `entity-disclaimer-system` gates
   `/verdict`, `/signals`, `/portfolio-intelligence`, and
   `/dashboard/holdfold/[ticker]` behind an acknowledgement flow — no
   `frontend`-tier spec currently confirms the gate actually blocks/unblocks
   correctly across all four surfaces in one pass.
9. **`docs/nulogdash-dashboard-plan.md`'s browser tier, properly.** Right now
   `nulogdash-merge-e2e.mjs` folds *this* Playwright suite's own results into
   the dashboard as a proxy for "browser tier." The plan doc's original
   intent was closer to nulogdash driving its own scripted browser checks per
   catalogued feature (the `--browser` flag mentioned in the plan, tier-2,
   "using the existing `browser-use` skill") — worth deciding whether that's
   still wanted as a distinct thing from this fault-injection suite, or
   whether this suite supersedes that plan item.
10. **Visual regression on the three landing-page motion components**
    (`CouncilScrollDebate`, `MagneticCTA`, `ParallaxStage` — currently
    `components/landing/*.test.tsx` unit-tests behavior, not appearance).
    Playwright's screenshot comparison could catch a CSS regression that
    breaks the scroll-triggered reveal visually while every unit assertion
    still passes.

---

## See also

- `docs/e2e.md` — the full operating manual (env contract, VS Code
  extension guide, CI workflow rationale, common-template traps)
- `docs/wiki-portal/entity-playwright-e2e.md` — wiki-side summary + known
  failures / open questions (some overlap with this file by design — the
  wiki page is the durable record, this file is the actionable checklist)
- `docs/wiki-portal/concept-test-strategy.md` — the three vitest layers this
  suite sits above, and its own still-unresolved contradictions (nothing
  runs `npm test` in CI either, as of this writing)
