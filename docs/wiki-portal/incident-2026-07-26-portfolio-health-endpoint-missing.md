---
date: 2026-07-26
type: incident
tags: [portfolio, health-score, gcp3, contract-drift, degradation, cross-surface]
sources: [../../app/api/portfolio/health/route.ts, ../../app/api/portfolio/health-ai/route.ts, ../../app/api/portfolio/suggestions/route.ts, ../../app/dashboard/portfolio/PortfolioClient.tsx, ../../lib/shared/portfolio-health-policy.ts, ../../lib/portfolio-health-local.ts, ../../lib/shared/sse.ts, ../../lib/openrouter.ts, ../portfolio-health-ai-workflow.html]
---

# Incident — Portfolio Health: upstream endpoint never existed

## Date & severity

**2026-07-26** (discovered; origin ~2026-07-15). **Severity: high** — two
user-facing panels dead on both web and mobile, on a feature named in launch
copy as a headline selling point.

## What happened

Two panels on `/dashboard/portfolio` fail persistently, with retry buttons that
never recover:

- **Portfolio Health Score** → *"Health score unavailable — try again shortly."*
- **Portfolio Health Check · AI** → *"Health check returned empty — try again."*

Mobile is affected identically: `gcp3-mobile`'s `lib/usePortfolio.ts` fetches the
same `/api/portfolio/health` route, so the Portfolio tab shows the same dead
score.

## Root cause

`{MCP_BACKEND_URL}/api/portfolio/health` **is not implemented on the gcp3
backend.** Neither `gcp3/backend/main.py` nor `gcp3/backend2/main.py` registers
any portfolio-health route. The analysis logic exists — `portfolio_analyzer.py`
holds `get_portfolio_analysis()` — but it was never wired to FastAPI. The portal
has been calling a route that has never existed.

Three compounding factors turned one missing route into two different symptoms
and a long detection delay:

1. **The score panel was previously disabled**, which hid the fault. The
   2026-07-15 audit catalogued the route as *"exists and calls GCP backend"* and
   treated the problem as pure UI wiring — it un-disabled the button. That
   un-disabling is what surfaced a backend break that predated it. The audit
   never verified the upstream endpoint answered.

2. **A prior fix masked the same symptom.** A malformed `MCP_BACKEND_URL` (a
   literal `\n` baked into the production env value) previously produced the
   *identical* "Health score unavailable" string — recorded in
   `gcp3-mobile/docs/wiki-mobile/entity-portfolio.md`. Repairing the env var
   moved the failure from *fetch throws* to *404 from gcp3*, both of which the
   client renders with the same message. The symptom never changed, so the fix
   looked ineffective and the real cause stayed hidden.

3. **The AI panel swallows the failure.** `fetchHealth()` in `health-ai/route.ts`
   catches everything and returns `null`, so the prompt silently becomes
   *"Portfolio health data: unavailable (no GCP3 backend connection)"*. The AI
   check has therefore been running **ungrounded since it shipped** — it
   produced plausible prose with no portfolio data behind it, which is worse
   than an error for a finance product.

## Contract drift (the trap behind the trap)

Even wiring the route naively would not have fixed it. The two sides share no
field names:

| gcp3 emits | portal expects |
|---|---|
| `ai_grade` (`"A"`–`"D"`) | `grade` (`A`–`F`, derived) |
| `ai_concentration`, `ai_avg_change_pct` | `factors[]` (`name`/`score`/`impact`/`description`) |
| `ai_insights[]` | `summary` |
| — *(no numeric score at all)* | `score` (0–100) |

The portal parses defensively —
`typeof raw.score === 'number' ? Math.round(raw.score) : 0` — so a naive wiring
yields **score 0, Grade F for every user, silently**. That is a worse outcome
than the current error, because it looks like a real result. Launch copy also
advertises an "A–F grade" while gcp3's grader tops out at A–D and never emits F.

## Resolution

### 2026-09-11 — resolved portal-side, by giving up on the upstream

**The gcp3 deployment never happened.** Re-checked 2026-09-11 against the live
backend's own OpenAPI: it registers `/signals`, `/industry-intel`,
`/market-overview`, `/screener` and 30-odd others, and **no portfolio path at
all**. `GET {gcp3-backend-url}/api/portfolio/health?tickers=AAPL,MSFT` → `404
{"detail":"Not Found"}`. The Phase-1 work below is real, sits in the gcp3
repo, and has now been undeployed for 47 days across at least three separate
confirmations (2026-08-18 `curl`, 2026-08-18 liveness suite, 2026-09-11
OpenAPI).

That duration is the finding. A fix that depends on another repo's deployment
is not a fix this repo can land, and continuing to wait was itself the
decision being made by default. So the dependency was inverted: the portal now
**scores the portfolio itself** from `ticker_cards`
([[entity-ticker-universe-pipeline]]) and treats gcp3 as an optimisation it
prefers when present. See
[[decision-local-portfolio-scoring-over-upstream-wait]].

What changed:

1. `lib/shared/portfolio-health-policy.ts` — pure scorer, no I/O, over
   `ticker_cards` rows. Four factors: signal strength (dataQuality-weighted
   mean card score), directional risk (BUY/SELL mix), diversification
   (breadth + ETF/stock mix), and coverage. `lib/portfolio-health-local.ts` is
   the Neon read beside it, split on the same rule as
   `card-policy`/`ticker-cards-db`.
2. **Coverage is reported but deliberately not scored.** Folding it in would
   make a thinly-covered portfolio arithmetically indistinguishable from an
   unhealthy one — the same "no data" vs "bad data" conflation that produced
   this incident's Grade-F trap, re-introduced one layer up.
3. `/api/portfolio/health` prefers upstream, falls back to local, and returns
   **503 with distinct copy** only when upstream is down *and* not one
   watchlist ticker has a card. That is the terminal honest state
   [[concept-graceful-degradation]] demanded and did not have.
4. **The contract-drift trap is closed at the source.** A 200 carrying gcp3's
   `ai_grade`/`ai_insights` shape no longer coerces to `score: 0` — a response
   without a finite numeric `score` is treated as a *miss* and routed to the
   local path. The drifted payload can no longer produce a number at all,
   which is strictly better than producing a wrong one the client then has to
   catch.
5. **The identical-error-strings problem is addressed on both sides.** The
   route logs `[portfolio-health] upstream_status=` / `upstream_contract_drift`
   / `upstream_unreachable` so the three faults are separable in logs, and the
   response carries `X-Portfolio-Health-Source: upstream|local` so a
   locally-computed score is *labelled* rather than silently substituted. The
   client renders that label.
6. `/api/portfolio/suggestions` got the same treatment. Its upstream is
   **also** unregistered (first noted 2026-08-18, never given its own page
   since the root cause is identical), and its `catch → []` rendered "check
   back after adding tickers" regardless of watchlist size — a failure that
   read as a quiet market.
7. `scripts/seed-watchlist-universe.mjs` — bulk-seeds the registered universe
   into a watchlist so the surface can be exercised at real scale. Requires an
   explicit target user and writes a per-run manifest that `--undo` reverses
   without touching rows the user added themselves.

**Verified live, which is the bar this section's own preamble set.** A
936-ticker watchlist scores 74 / Grade C with 932 covered, latest bar
2026-09-05; a 10-ticker watchlist scores 71 / Grade C with 7 covered. Both
read through `getWatchlist` → `localPortfolioHealth` against the real Neon
database, asserted by `__tests__/live/portfolio-health.live.test.ts`. The live
test was itself checked by temporarily throwing on its empty-watchlist branch,
to confirm it was scoring rather than passing trivially — the cheap trap for a
skip-guarded test that reports green because it did nothing.

**What is still not fixed:** `health-ai` remains ungrounded-by-default and
unmetered. It has a real score to fall back to now, for the first time since
it shipped, but nothing has been wired to consume it — see Open items.

### 2026-07-26 — Phases 1–2 (gcp3-side, never deployed)

**Code-complete for Phases 1–2 as of 2026-07-26; not deployed or verified
live.** Full detail: `docs/portfolio-health-fix-plan.md`. Per that plan's own
rule (see its "trap" callout, drawn from this incident's masking history), no
step below is treated as *fixed* until a positive observation against a
running backend confirms it — code passing `tsc`/`vitest` is necessary, not
sufficient.

1. ✅ *implemented* — gcp3 `GET /api/portfolio/health?tickers=…` registered in
   `backend/main.py`, **stateless, no Clerk token**. `get_portfolio_analysis`
   already cached by `portfolio:{sorted_tickers}:{date}`, so the existing code
   was written for this contract.
2. ✅ *implemented* — `portfolio_analyzer.to_health_contract()` adapter emits
   `score`/`factors[]`/`summary`/`generated_at`. Score is a first-cut heuristic
   (diversification + concentration only; momentum reported as an
   informational factor, deliberately excluded from the score so it doesn't
   jump on daily price noise) — sanity-checked standalone, not tuned against
   real portfolios.
3. ✅ *implemented* — portal resolves the user's Neon watchlist and passes it
   as `?tickers=`; empty watchlist returns `204` instead of falling through to
   gcp3's `DEFAULT_PORTFOLIO`. Cache key changed to `userId:sorted-tickers`.
   Mobile's `usePortfolio.ts`/`PortfolioScreen.tsx` updated for the new `204`
   (this consumer wasn't in the original plan — a naive `res.ok` check treats
   204 as success and would have thrown parsing an empty body).
4. ✅ *implemented, narrowly scoped* — new `fetchWithModelFallbackChecked` in
   `lib/openrouter.ts` treats an HTTP-200-but-empty completion as a failure and
   advances to the next model. Added as a **separate function**, not a change
   to the existing `fetchWithModelFallback` — `/api/nuai` and `/api/brief` are
   untouched; only `health-ai` opts in. `max_tokens` raised 400 → 1024.
5. ✅ *implemented* — the new function "primes" each candidate model (buffers
   until first token or stream-end) before returning a stream to the caller,
   so `health-ai` no longer flushes `200 OK` before knowing the model produced
   anything.

Also landed, beyond the original 5-step list: `Accept`-based content
negotiation on `health-ai` and `brief` (previously only `/api/nuai` had it —
and adding it surfaced that `PortfolioClient.tsx` never sent an `Accept`
header at all, which would have silently broken its own streaming UI); and a
`grounded` signal (`X-Portfolio-Health-Grounded` header / JSON field) so an
ungrounded AI narrative is now shown to the user with a warning instead of
presented as a normal result.

## Impact on design

- **Un-disabling a control is a backend change.** The audit treated
  "button is disabled" as a UI defect. Re-enabling a control asserts that
  everything behind it works; that assertion needs an end-to-end check, not a
  route-file grep.
- **Identical error strings across distinct causes defeat debugging.** Three
  different faults (bad env var, missing route, upstream 5xx) all render
  "Health score unavailable." The client should distinguish transport failure
  from upstream 4xx/5xx.
- **This is the counterexample to [[concept-graceful-degradation]].** That
  concept's stated obligation — *health-ai should fall back to the deterministic
  score, not error* — is unmet in both directions: `health-ai` does not fall
  back, and the score it would fall back **to** is itself broken. Degradation
  chains need a terminal honest state, not a chain of optional dependencies that
  can all be absent at once.
- **Cross-repo contracts need a shared fixture.** `lib/portfolio.ts` is described
  as the "single-sourced type contract" but only binds portal↔mobile. gcp3 is on
  the other side of the wire with no shared schema, and drifted freely.
- **A fix that lives in another repo's deploy queue is not a fix.** Phases 1–2
  were written, reviewed, and correct on 2026-07-26, and the user-facing panel
  stayed dead for another 47 days. Nothing in this repo's process distinguishes
  "fixed" from "fixed somewhere we do not control" — the incident stayed marked
  resolved-pending-deploy while the product stayed broken. The check that
  finally moved it was cheap and available the whole time: read the upstream's
  own OpenAPI and see whether the path exists.
- **Waiting is a decision, and it should be dated.** Each individual "wait for
  gcp3" was reasonable; the accumulated 47 days was never chosen by anyone.
  This is the same shape as [[incident-2026-08-18-modal-under-recommended]],
  where six locally-sound deferrals composed into an outcome nobody had
  evaluated. A deferral with no review date is indistinguishable from an
  abandonment.
- **Owning the data beats owning the contract.** The durable fix was not a
  better adapter between two field-name sets — it was noticing the portal
  already held `ticker_cards`, a full-universe signal layer built for an
  unrelated purpose, which answers the same question without the wire. The
  adapter work would have re-broken on the next upstream schema change.

## Open items

- ❗ **`health-ai` still does not consume the score that now exists.** This is
  the highest-value remaining item and the one the 2026-09-11 work deliberately
  did not take on. `fetchHealth()` still calls gcp3 directly and still degrades
  to "Portfolio health data: unavailable", so the AI narrative remains
  ungrounded even though `localPortfolioHealth()` would hand it a real,
  factor-level score. [[concept-graceful-degradation]]'s stated obligation —
  *health-ai falls back to the deterministic score* — is finally satisfiable
  and is still unsatisfied. Pointing `fetchHealth` at the local scorer is a
  small change; it was left out to keep the fallback change reviewable on its
  own.
- ❓ **Mobile gets the fix for free but cannot see the caveat.**
  `gcp3-mobile`'s `lib/usePortfolio.ts` calls the *portal's* route, so its
  Portfolio tab is repaired by this change with no mobile code edit. It does
  not read `X-Portfolio-Health-Source`, so it renders a locally-computed score
  with no provenance label — the honesty half of the fix is web-only. See
  [[concept-mobile-web-parity]].
- ❓ **The score is a first-cut heuristic and is not validated.** Weights
  (0.45 signal / 0.30 direction / 0.25 diversification) and the
  ten-name diversification target are reasoned, not fitted to any outcome.
  Nothing measures whether a Grade-B portfolio subsequently outperforms a
  Grade-D one. [[entity-backtest-engine]] is the obvious place that question
  would be answered and is not wired to it.
- ❓ **Sector concentration is unmeasured.** `ticker_universe` records only
  `etf`/`stock`, so "diversification" is breadth plus an asset-class mix — a
  book of 30 semiconductor names scores as well-diversified. The factor's own
  description says so, which is the honest floor, not a fix.
- ❓ **The cards can be stale and the score does not say how stale.** The
  verified run scored against a 2026-09-05 bar on 2026-09-11. `barDate` is in
  the summary text, but nothing degrades or flags on age — the same
  no-visible-age gap [[concept-cache-then-degrade]] records for stale-serve in
  `signal-lookup`. Given [[incident-2026-09-03-nightly-hydration-dead-15-days]],
  a silently-frozen `ticker_cards` is a demonstrated failure mode, not a
  hypothetical one.
- ❓ Nothing on `health-ai` records tokens or rate-limits, unlike `/api/nuai`
  (`checkRateLimit` + `getRemainingBudget` + `recordUsage`). Health checks bypass
  `NU_AI_DAILY_TOKEN_BUDGET` entirely — an unmetered cost path.
- ❓ `interactivity-15.md` §3.1 specified `Accept`-based content negotiation for
  `/api/nuai`, `/api/brief` **and** `/api/portfolio/health-ai`. Only `/api/nuai`
  received it; the other two always return SSE. Legacy mobile builds that expect
  JSON get a stream they cannot parse — an independent empty-result vector.
- ❓ The "returned empty" cause is ranked from code inspection, **not confirmed
  live**. Confirming needs the raw upstream SSE and served model logged for one
  failing request; no such logging exists today (errors are swallowed into an
  already-flushed stream).
- ❓ `homebase/roadmap-3month.md` sources the health score from `ai-fin-opt2`;
  no such directory exists (only `ai-fin-opt`), and the code points at gcp3.
  Intent drift worth reconciling before building.

## See also

- [[decision-local-portfolio-scoring-over-upstream-wait]] — the 2026-09-11 call to stop waiting on gcp3
- [[entity-portfolio-intelligence]] — the surface this breaks
- [[concept-graceful-degradation]] — the obligation this violates
- [[entity-openrouter-client]] — `fetchWithModelFallback`'s status-only fallback
- [[decision-free-tier-model-chain]] — why the chain is reasoning-heavy and free
- `docs/portfolio-health-ai-workflow.html` — full-stack trace + 11-defect table
- `gcp3-mobile/docs/wiki-mobile/entity-portfolio.md` — the mobile half + the
  earlier env-var incident with the same user-facing string
