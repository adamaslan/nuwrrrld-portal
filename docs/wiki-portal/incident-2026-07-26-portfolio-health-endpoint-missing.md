---
date: 2026-07-26
type: incident
tags: [portfolio, health-score, gcp3, contract-drift, degradation, cross-surface]
sources: [../../app/api/portfolio/health/route.ts, ../../app/api/portfolio/health-ai/route.ts, ../../app/dashboard/portfolio/PortfolioClient.tsx, ../../lib/shared/sse.ts, ../../lib/openrouter.ts, ../portfolio-health-ai-workflow.html]
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

## Open items

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

- [[entity-portfolio-intelligence]] — the surface this breaks
- [[concept-graceful-degradation]] — the obligation this violates
- [[entity-openrouter-client]] — `fetchWithModelFallback`'s status-only fallback
- [[decision-free-tier-model-chain]] — why the chain is reasoning-heavy and free
- `docs/portfolio-health-ai-workflow.html` — full-stack trace + 11-defect table
- `gcp3-mobile/docs/wiki-mobile/entity-portfolio.md` — the mobile half + the
  earlier env-var incident with the same user-facing string
