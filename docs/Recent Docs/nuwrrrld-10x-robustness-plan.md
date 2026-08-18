# 10x Robustness & Efficiency Plan — nuwrrrld-portal & holdemfoldemapp

_Written 2026-08-12. Derived from the compiled project summary (repo source, wiki docs, git history). Scope: hardening and speeding up **existing** features only — no new product surface._

Guiding principle: both apps already degrade gracefully in most places. The 10x wins come from
(1) eliminating the handful of single points of failure, (2) closing the correctness gaps between
what's coded and what's deployed, and (3) collapsing redundant round-trips with caching and
precomputation.

---

## 0. Priority matrix (do these first)

| # | Item | App | Why it's first |
|---|------|-----|----------------|
| P0 | Reconcile `backend/cloud-run/main.py` (v2) with local `main.py` (v6) | holdfold | Production silently returns `null` for P&L, Fibonacci, options payoff — a **correctness** bug, not a robustness one |
| P0 | Auth + rate limiting on `/api/analyze` | holdfold | Publicly callable compute endpoint = cost and abuse exposure |
| P0 | CHAIR synthesis fallback | portal | The one hard 503 in the Council pipeline |
| P1 | Cache key: add period (holdfold) + per-ticker brief cache (portal) | both | Cheap fixes, immediate correctness + latency wins |
| P1 | Generated types from Pydantic → TS | holdfold | Kills an entire class of drift bugs |
| P1 | Live-model golden tests in CI | portal | The free-model chain is the least-tested most-critical path |
| P2 | Migrate production corpus; close watchlist→signals loop; re-sync `lib/subscription.ts` | portal | Known gaps #1, #4, #7 |

---

## 1. nuwrrrld-portal

### 1.1 AI Council (`/api/council`, `/api/council/deliberate`)

**Robustness**

- **Break the CHAIR single point of failure.** Today CHAIR synthesis failure = 503 while
  everything else degrades. Add a two-stage fallback:
  1. Retry CHAIR with the next model in `FREE_MODEL_CHAIN` (different provider family if possible).
  2. If all models fail, emit a **degraded verdict**: majority-vote across the six seat outputs
    (they already exist at that point) with a `synthesis: "fallback-vote"` flag in the response
    so the UI can label it. A labeled degraded answer beats a 503 every time.
- **Live-model golden tests.** Unit tests cover parsing/critique/validation, but nothing proves a
  real 7B free model emits parseable output. Add a weekly CI job (piggyback on the existing Monday
  `refresh-free-models.mjs` run) that fires 3–5 canned deliberations against each model in the
  fresh `FREE_MODEL_CHAIN` and asserts the outputs parse through `council-validate.ts`. Models
  that fail get **dropped from the chain before it ships** — the refresh job becomes a quality
  gate, not just a list update.
- **Per-seat timeout + salvage.** In `deliberate`, wrap each seat in its own timeout; a hung seat
  should be replaced by a "seat abstained" marker rather than stalling the whole debate. Six seats
  with one flaky free model shouldn't cost the user the other five opinions.
- **Structured failure telemetry.** Log every model call as `{model, seat, latency, parse_ok,
  retry_count}` to Neon. This is the dataset that tells you which free models to demote — right
  now that knowledge is anecdotal.

**Efficiency**

- **Parallelize seats fully** (if not already) and stream partial results: emit each seat's take
  over SSE (the `lib/shared/sse.ts` plumbing already exists) so perceived latency drops from
  "slowest seat + CHAIR" to "first seat".
- **Cache deliberations.** Key on `(ticker, grounding_pack_version, question_hash)` with a short
  TTL (15–60 min market hours, longer off-hours). Repeat questions about NVDA within the hour are
  common and identical.
- **Slice grounding lazily.** Per-seat sliced grounding means 6 slices per deliberation — compute
  the slices once per `(ticker, pack_version)` and store in the existing Neon cache rather than
  re-slicing per session.

### 1.2 Grounding pipeline

- **Migrate the real corpus** (known gap #1). The compiled pack is a placeholder — everything
  downstream of `lib/grounding/resolve.ts` is running on sample data. This is the highest-leverage
  content fix; the four-tier ladder is only as good as tier data.
- **Version + checksum the pack.** Stamp each weekly compile with `{version, git_sha, corpus_hash,
  row_count}`. The deliberate endpoint records which pack version it used. Enables: rollback to
  last-good pack, and detecting a silently-empty compile (add a CI assertion: new pack row count
  ≥ 80% of previous, else fail the job and keep serving the old pack).
- **Fail-open compile.** If Monday's `compile_grounding_pack.mjs` fails, the previous pack must
  keep serving. Make that explicit: compile into a staging table, validate, then swap — never
  truncate-then-insert.

### 1.3 Signal data plane (`/api/signals/*`, `/api/holdfold`, `/api/brief`, `/api/backtest`)

**Robustness**

- **Close the watchlist loop** (known gap #4). Adding a ticker should enqueue a signal compute,
  not just persist a row. Minimal fix: the existing `refresh`/`drain` queue endpoints — on
  watchlist insert, enqueue the ticker; the drain worker warms the Neon L2 cache. Then "add stock
  → see signals" works without a cold-path backend round-trip on first view.
- **Harden cache-then-degrade with staleness labels.** The policy is right; make it observable.
  Every degraded response should carry `{served_from: "l2-cache", age_seconds}` so the UI can show
  "as of 14 min ago" instead of implying freshness. Silent staleness is how users lose trust.
- **Backtest engine visibility** (known gap #5): if `SIGNALS_ENGINE_URL` is unset, render an
  explicit "track record unavailable" state rather than nothing — dark features rot because
  nobody notices they're dark. Add an env-schema warning at build time.
- **Circuit-break the gcp3 backend.** Add a simple rolling-error-rate breaker in front of gcp3
  calls: after N consecutive failures, serve L2-only for a cooldown window instead of hammering a
  down backend and eating timeout latency on every request.

**Efficiency**

- **Cache per-ticker Council briefs** (known gap #6). N briefs = N backend round-trips today. Add
  a Neon-backed brief cache keyed `(ticker, day)` with market-hours TTL; batch-warm it from the
  digest job for watchlisted tickers. This turns the most common read path into a single DB hit.
- **Coalesce concurrent identical requests** (request de-duplication): if 50 users hit
  `/api/signals/live` for SPY in the same second, one upstream fetch should serve all 50.
  A tiny in-flight-promise map in the route handler does this.
- **ETag/`s-maxage` on read endpoints.** `digest`, `card`, `brief`, and OG share cards
  (`/api/og/verdict/[ticker]`) are ideal for CDN caching on Vercel — set `Cache-Control:
  s-maxage=300, stale-while-revalidate=3600` and let the edge absorb the traffic.

### 1.4 Billing & auth

- **Finish the Stripe incident.** The 2026-07-27 invalid-header fix shipped but manual dashboard
  steps are outstanding — close them and add a smoke test: a CI job that creates a test-mode
  checkout session weekly and asserts 200. Billing is the subsystem where "it worked last month"
  is not evidence.
- **Webhook idempotency + replay.** Ensure `/api/webhooks/stripe` dedupes on event ID (Stripe
  retries) and log every event to Neon so missed webhooks can be replayed. Same for Clerk/svix.
- **Re-sync `lib/subscription.ts` with mobile** (known gap #7). `parseSubscriptionMetadata()`
  landed portal-side only; move it into `lib/shared/` and let the existing drift-detection gate
  (portal PR #52 / mobile PR #33) enforce it. The entitlement contract is exactly the file that
  must never drift.
- **Entitlement cache with short TTL.** Clerk `publicMetadata` reads on every gated request add
  latency; a 60s in-memory cache per user cuts it with negligible staleness risk.

### 1.5 Shared core & parity

- **Ratchet the parity number.** ~66% synced (single-source ~44%) as of 2026-08-08. Make the
  drift gate a ratchet: PRs may not *decrease* single-source parity. Cheapest path to 10x fewer
  cross-platform bugs is moving more of `lib/shared/` to genuinely single-source.
- **Add contract tests for `sse.ts` and `signal-policy.ts`** — the two shared modules where a
  silent behavioral divergence would be least visible and most damaging.

### 1.6 Ops

- **Env-schema validator → hard gate.** It exists; make unknown/missing env vars fail the Vercel
  build, not warn. Half the recorded incidents (portfolio-health missing, backtest dark) are
  configuration-shaped.
- **Migration safety.** `prebuild` runs `db-migrate.mjs` — add a `--dry-run` diff step in CI so a
  destructive migration is visible in the PR, not discovered at deploy.

---

## 2. holdemfoldemapp

### 2.1 The deployed-vs-local backend split (⛔ the big one)

`cloud-run/main.py` (v2) is missing multi-lot P&L, Fibonacci, the options payoff engine, the
suppression pipeline, and Firestore — production returns `null` for fields the UI renders.

- **Pick one entrypoint.** Either promote local `main.py` (v6) to Cloud Run, or explicitly kill
  the v6-only features. The current state — two hand-maintained mains — guarantees recurring
  drift. Recommended: single `main.py` with a `FEATURE_SET` env flag if a slim deployment is
  genuinely needed; `deploy-backend.sh` already assembles a build context, so shipping the full
  app is mostly a Dockerfile/environment.yml exercise.
- **Deployment parity test.** Add a post-deploy smoke check to `deploy-backend.sh`: call
  `/api/analyze?symbol=AAPL` on the fresh revision and assert the fields the frontend renders
  (`fib_levels`, `position_pnl`, payoff fields) are non-null. Would have caught this gap on day one.
- **Version endpoint.** `/api/version` returning `{app_version, feature_set, git_sha}`; the
  frontend logs it, and the portal's live-analysis panel (via `MCP_ANALYZE_URL`) can assert it
  gets the feature set it expects.

### 2.2 Security & abuse

- **Auth on `/api/analyze`.** Minimum viable: a shared bearer token checked in FastAPI middleware,
  held by the Next.js proxy and the portal (`MCP_ANALYZE_URL` caller). CORS is not access control.
- **Rate limiting.** Per-IP token bucket at the FastAPI layer (or Cloud Run + Cloud Armor).
  yfinance + Gemini calls are the expensive path; an unauthenticated public endpoint that fans out
  to `asyncio.gather(4 analyses)` is a cost amplification vector.
- **Request validation caps.** Bound `period`, symbol format (regex), and reject batch-shaped
  abuse early, before any fetch.

### 2.3 Correctness & types

- **Generate TS types from Pydantic** (known gap #3). `HoldFoldVerdict` in `page.tsx` is
  hand-rolled. Emit JSON Schema from the Pydantic model (`model_json_schema()`) and generate TS
  via `json-schema-to-typescript` in a CI step; fail the build on diff. One command, entire drift
  class eliminated — and the portal's live-analysis panel can consume the same generated types.
- **Fix the cache key** (known gap #4): key Firestore on `(symbol, period)` — currently 1mo and
  1y responses collide under a symbol-only key with 1h TTL. Two-line fix, real correctness bug.

### 2.4 Data & analysis pipeline

- **Harden the yfinance → Alpha Vantage fallback.** Add per-source health tracking: if yfinance
  error rate spikes (it does, regularly), pre-emptively route to Alpha Vantage for a cooldown
  window rather than paying the timeout on every request. Log which source served each verdict.
- **Stale-while-revalidate on Firestore cache.** Currently stale → *synchronous* re-fetch, so one
  user eats the full pipeline latency every hour per symbol. Serve the stale verdict immediately
  with `stale: true`, kick a background refresh. P99 latency drops from "full pipeline" to
  "Firestore read" for warm symbols.
- **Keep the rule-based ranking floor sacred.** The Gemini circuit breaker + rule-based floor is
  the best pattern in either codebase. Add a regression test asserting the pipeline completes
  end-to-end with the Gemini path force-disabled, so nobody accidentally makes it load-bearing.
- **Pin the vendored `mcp-finance1` snapshot.** It's vendored at Docker build time from a sibling
  repo working tree — record the exact git SHA vendored into the image (build arg → `/api/version`)
  so a verdict can be traced to the analysis code that produced it.

### 2.5 AI Council commentary

- **Fallback for `ai-text-opt-1024`** (known gap #5). The proxy 503s if the RAG server is down.
  Options in order of effort: (a) friendly degraded message with retry, (b) fall back to a plain
  LLM call without RAG (label it "general commentary"), (c) cache last-good commentary per
  `(ticker, verdict_bias)` and serve stale with a timestamp. Even (a) is a big UX improvement
  over a raw 503.

### 2.6 Frontend

- **Render `null` honestly.** Until 2.1 lands, the UI should show "not available in this
  deployment" for null Fibonacci/payoff/P&L sections instead of empty or broken sections.
- **Expand the Playwright suite** beyond `e2e/app.spec.ts` happy path: backend-down, stale-cache,
  null-fields, and disclaimer-not-acked states. These are exactly the states users actually hit.

---

## 3. Cross-cutting

- **One shared status/telemetry convention.** Both apps degrade in multiple places
  (cache-then-degrade, circuit breakers, seat abstention, stale-serve). Standardize a response
  envelope: `{data, meta: {served_from, age_seconds, degraded: [...], versions: {...}}}` across
  portal API routes and the holdfold backend. UIs stop guessing, and debugging a "weird result"
  becomes reading `meta` instead of spelunking logs.
- **Synthetic monitoring.** A scheduled probe (every 15 min market hours) hitting: portal
  `/api/signals/live`, `/api/council` (cheap single-seat), holdfold `/api/analyze`, and Stripe
  checkout (test mode, daily). Alert on failure or on `degraded` present for > 3 consecutive
  probes. All three recorded incidents were discovered reactively; this makes them proactive.
- **Unify the two `/api/holdfold`s conceptually.** The name collision (portal's own route vs. the
  holdfold backend) is documented as convergent-not-shared — fine, but give them distinct internal
  names in logs/telemetry (`portal-holdfold` vs `hf-api`) so incident triage never confuses them.
- **`mcp-finance1` as the shared root.** Both apps ultimately depend on it (portal transitively
  via gcp3, holdfold by vendoring). Any indicator/signal change there should trigger CI in both
  consumers — a lightweight repository-dispatch hook from the mcp-finance1 repo is enough.

---

## 4. Sequencing (4 weeks, roughly)

**Week 1 — correctness:** holdfold entrypoint reconciliation + post-deploy smoke test + cache-key
fix; portal CHAIR fallback vote.

**Week 2 — security & drift:** holdfold auth + rate limiting; Pydantic→TS type generation;
re-sync `lib/subscription.ts` into `lib/shared/`.

**Week 3 — efficiency:** brief cache + request coalescing + edge caching (portal);
stale-while-revalidate + data-source health routing (holdfold).

**Week 4 — verification:** live-model golden tests in the Monday model-refresh CI; grounding pack
staging-swap + checksums; synthetic monitoring probes; expanded Playwright states.

Corpus migration (portal gap #1) runs in parallel throughout — it's content work, not code work,
and everything grounding-related is placeholder-quality until it lands.
