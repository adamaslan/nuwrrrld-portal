---
date: 2026-08-17
type: entity
tags: [testing, playwright, e2e, ci, clerk, gcp-wif, fault-injection, automation]
sources: [../../playwright.config.ts, ../../e2e, ../../.github/workflows/e2e-resiliency.yml, ../../docs/e2e.md, ../../package.json, ../../.env.example]
---

# Entity — Playwright E2E Suite

## What it is

The fourth test layer, sitting above [[concept-test-strategy]]'s three vitest
projects: a **credential-gated, browser-driven fault-injection suite** under
`e2e/`, configured by `playwright.config.ts`, and run either from VS Code, the
CLI (`npm run test:e2e`), or CI (`.github/workflows/e2e-resiliency.yml`). Full
design rationale lives in `docs/e2e.md` (the operating manual this entity page
summarizes and keeps in sync with, not duplicates).

The suite is organized as dependent Playwright *projects*, not one flat test
list — mirroring the same "cheap layer gates the expensive one" instinct
[[concept-test-strategy]] applies to `live` vs `unit`:

| Project | What it checks | Depends on |
|---|---|---|
| `preflight` | **core** credentials only: Clerk, OpenRouter, `DATABASE_URL` — shape (prefix, no placeholder, no whitespace) plus one cheap authenticated call per provider. Never logs a value | — |
| `preflight-billing` | Stripe shape + liveness, **gating nothing else** | — |
| `health` | `/api/health`'s aggregate dependency verdict (mcp/neon/stripe/openrouter/clerk) is `ok`, and its latency budget | `preflight` |
| `auth-setup` | signs in a **dedicated** Clerk test user once, saves `storageState` to `playwright/.auth/user.json` | `preflight` |
| `frontend` | route-level fault injection (mocked 429s, stalled SSE, contract-drift payloads) against real components, already authenticated | `auth-setup` |
| `ci` | `scripts/*.mjs` + their GHA workflows, via subprocess — no browser | — |

`dependencies: [...]` means a failed `preflight` blocks the projects that
actually depend on it — `health`, `auth-setup`, and transitively `frontend`
— not the whole suite: `preflight-billing` and `ci` are independent and run
regardless. A revoked `OPENROUTER_API_KEY` fails one `preflight` test instead
of producing forty confusing red `frontend` failures. Same "blocked is not
fail" distinction `scripts/nulogdash.mjs` already applies to feature results.

> **The gate is split by concern, and that split was learned the hard way
> (2026-08-17).** Originally one `preflight` project asserted *every*
> credential, Stripe included. Because `auth-setup` depended on it,
> a placeholder `STRIPE_WEBHOOK_SECRET` made a Clerk sign-in test unrunnable —
> and therefore made a green CI run impossible for a reason unrelated to
> anything under test. **A gate should block what depends on it, not
> everything.** `preflight-billing` is deliberately excluded from the CI `e2e`
> job until `docs/stripe-todo.md`'s unset values are real.

**Auth handshake.** `e2e/auth.setup.ts` uses `@clerk/testing`'s `clerkSetup()`
— rather than the "copy a `__session` cookie out of devtools" pattern
`scripts/nulogdash.mjs`'s `NULOGDASH_SESSION_COOKIE` uses. Two credentials
drive it: `E2E_CLERK_TEST_EMAIL` / `E2E_CLERK_TEST_PASSWORD`, for a dedicated
test user only. The resulting session is cached on disk and reused for up to 6
days (`STALE_AFTER_MS`, inside Clerk's 7-day default session lifetime) before
re-authenticating automatically — "stay logged in for a week" without a
password touching disk more than once per week.

**CI handshake specifically.** `.github/workflows/e2e-resiliency.yml` signs in
**once**, in a dedicated `auth` job — not once per shard — then uploads
`storageState` (a session artifact, never the password) with 1-day retention
for the four `e2e` shard jobs to download. Only the `auth` job's env block
carries `E2E_CLERK_TEST_EMAIL`/`PASSWORD`; the sharded jobs never see them.

## Where used

- `playwright.config.ts` — project graph, `webServer` (starts `next dev` for
  gutter/CLI runs), `trace: 'retain-on-failure'` (never `'on'` — traces embed
  request headers, i.e. `Authorization: Bearer <key>`).
- `e2e/preflight/credentials.spec.ts` — the ~18-var env contract from
  `.env.example`, asserted on shape and liveness only.
- `e2e/health/dependencies.spec.ts` — wraps `/api/health`
  ([[entity-portfolio-intelligence]]'s health route is a *different* health
  check; this one is the aggregate dependency probe in `app/api/health/route.ts`).
- `e2e/frontend/nuai-fault-injection.spec.ts` — `/dashboard/nuai`
  ([[entity-ai-council]]'s consumer-facing chat surface), stalled-SSE and 429
  fault injection against real `.nuai-*` selectors.
- `e2e/frontend/portfolio-health.spec.ts` — see "Diagnostic role" below.
- `.github/workflows/e2e-resiliency.yml` — 4-shard matrix, keyless GCP
  Workload Identity Federation (`id-token: write`, no service-account JSON in
  secrets), blob-report merge, idempotent PR comment (`<!-- e2e-resiliency-bot -->`
  marker, updates in place rather than spamming per push).
- VS Code: `ms-playwright.playwright` extension reads `playwright.config.ts`
  directly — `docs/e2e.md` §7 documents the sidebar controls, run-mechanics
  (green/grey triangle, per-step timing), and the extension's own env-loading
  gap (`dotenv.config()` in the config is required because the extension
  spawns a Node process that does not inherit the shell's `.env.local`).

## Diagnostic role (not just regression coverage)

`e2e/frontend/portfolio-health.spec.ts` was written specifically to
disambiguate the failure class documented in
[[incident-2026-07-26-portfolio-health-endpoint-missing]] — **identical
user-facing strings hiding distinct root causes.** Each test isolates one
layer and names it in the failure message rather than reproducing the
ambiguous symptom:

- gcp3 `/api/portfolio/health` returning non-ok (404-never-registered, 5xx,
  timeout) all collapse to the portal's own flat `502 upstream error` — the
  test documents that the portal's response *cannot* distinguish these; you
  have to check gcp3's own logs.
- A contract-drift payload (`ai_grade`/`ai_insights` instead of
  `score`/`factors[]`/`summary`) must not silently render as a real score —
  the incident's "worse than an error" failure mode.
- `health-ai`'s ungrounded-narrative signal (`X-Portfolio-Health-Grounded`
  header / `grounded` field) must actually reach the UI, not just exist in the
  response.
- `TrackRecordBadge` ([[entity-backtest-engine]]) — the same 204-collapses-
  everything ambiguity (unset `SIGNALS_ENGINE_URL` vs. unreachable engine vs.
  `isBacktestResult()` shape mismatch) is tested the same way: reproduce each
  cause independently rather than asserting on the merged "unavailable" state
  alone.

**Correction to a stale claim while writing these tests:** the incident doc's
"Resolution" step 4/"Also landed" section claims `/api/portfolio/health-ai`
received `Accept`-based content negotiation alongside `/api/nuai`. Reading
`PortfolioClient.tsx` directly (2026-08-17) shows `runHealthCheck()` **does**
send `Accept: "text/event-stream, application/json"` — so that part of the
incident doc is accurate as written. `e2e/frontend/portfolio-health.spec.ts`'s
"PortfolioClient sends no Accept header" test therefore asserts the *positive*
case (header present) and is expected to pass; treat a failure there as a
genuine regression, not confirmation of the old incident.

## Known failures

1. **The sharded `e2e` job has never run — GCP WIF is unprovisioned.**
   `auth` now passes in CI (run `32089144456`, 2026-08-17), so all four shards
   start and then fail immediately at "Authenticate to GCP (keyless)" because
   `GCP_WIF_PROVIDER` is empty. Fix with
   `bash scripts/sync-e2e-secrets.sh --provision-wif`, then grant the printed
   service account only the role the MCP identity-token step needs. Getting
   `auth` green took seven distinct fixes — see
   [[incident-2026-08-17-e2e-ci-cascade]] for the chain and the recurring
   lesson that the error message named the wrong layer nearly every time.
2. **`e2e/frontend/*` specs target one page each** (`/dashboard/nuai`,
   `/dashboard/portfolio`, `/dashboard/signals`). `docs/e2e.md`'s illustrative
   §§1–3 examples reference routes that don't exist in this app (`/ai-chat`,
   `/upload`, `/analytics`) — those were adapted to real routes during
   build-out; don't copy the doc's example selectors verbatim without
   re-verifying against current component markup, the way the Nu AI and
   Portfolio specs did.
3. **`dotenv` and `@playwright/test`/`@clerk/testing` are now real
   dependencies** (added 2026-08-17), not aspirational — `docs/e2e.md`
   written before this build-out described a stub `.github/workflows/
   playwright.yml` (default `npm init playwright` scaffold, no env, no
   sharding) that has since been **deleted and replaced**, not left running
   alongside `e2e-resiliency.yml`.
4. **No selectors have `data-testid`.** Tests target Tailwind-adjacent class
   names (`.nuai-error`, `.port-health-error`) and ARIA roles/text, which are
   more prone to drift than dedicated test hooks. Not yet a decided tradeoff
   — see open questions.

## Open questions

- ❓ Should component markup gain `data-testid` hooks specifically for the
  classes these specs already depend on (`.nuai-error`, `.nuai-typing`,
  `.port-health-error`, `.port-watch-empty`), or is asserting on real CSS
  classes + ARIA roles preferred because it also catches accidental class
  renames? Not decided.
- ❓ `E2E_CLERK_TEST_EMAIL`/`PASSWORD` need a real, dedicated Clerk test user
  provisioned before `auth-setup` can run anywhere — local or CI. Not yet
  created; every `frontend`-project test is currently blocked on this.
- ❓ Should `e2e/health/dependencies.spec.ts`'s "frontend renders a usable page
  when `/api/health` reports down" test stay `EXPOSE`-labeled (documenting a
  known gap — `DashboardCockpit` has no `role="alert"` banner today) or should
  the gap be fixed first? Currently documents, does not fix.

## See also

- [[concept-test-strategy]] — the three vitest layers this suite sits above;
  shares the "cheap gate before expensive layer" and "skip loudly, never
  fabricate a credential" principles
- [[entity-portfolio-intelligence]] · [[entity-backtest-engine]] — the two
  entities `portfolio-health.spec.ts` diagnoses
- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — the incident
  this suite's diagnostic tests were written to disambiguate
- [[entity-ai-council]] · [[entity-openrouter-client]] — what
  `nuai-fault-injection.spec.ts` exercises
- `docs/e2e.md` — the full operating manual (env contract table, VS Code
  extension guide, CI workflow rationale, "traps in common hardened workflow
  templates"); this page is the wiki-side summary, not a replacement
