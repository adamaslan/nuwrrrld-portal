# Portfolio Health — 3-Phase Fix Plan

**Created:** 2026-07-26
**Scope:** all 13 defects catalogued in `docs/portfolio-health-ai-workflow.html`
**Repos:** `gcp3` (backend), `nuwrrrld-portal` (web), `gcp3-mobile` (app)
**Incident:** `docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md`

> **Implementation status (2026-07-26): Phases 1 and 2 code-complete, not yet
> deployed or verified live.** `npx tsc --noEmit` and `npx vitest run` (137
> passed) are clean on the portal; gcp3's two edited files pass `ast.parse`.
> **None of the acceptance checkboxes below are checked** — per this plan's own
> rule, they require a positive observation against a *running* backend
> (`curl` against deployed Cloud Run, the actual UI), which hasn't happened.
> Do not read "code written" as "bug fixed." See "What's implemented" after
> each phase for exactly what changed.

---

## Why this order

The phases are sequenced by **dependency, not severity**.

1. **Phase 1 — Make it work.** Nothing else is testable until the upstream route
   exists. Every other fix is currently unverifiable because the feature returns
   an error before reaching the code being fixed.
2. **Phase 2 — Make it honest.** Once data flows, fix the streaming/empty path
   and the degradation obligation. Starts with *observability*, not code changes
   — see the trap below.
3. **Phase 3 — Make it safe.** Guardrails, hygiene, and the regression
   prevention that stops this class of bug recurring.

> ### ⚠️ The trap this plan is built to avoid
>
> On 2026-07-21 a genuine fix (repairing a corrupted `MCP_BACKEND_URL`) produced
> **no visible change**, because the failure moved from 503 to 502 and the client
> renders both with the identical string *"Health score unavailable."* The fix
> looked ineffective and the real cause stayed hidden for five days.
>
> **Therefore: no phase is "done" because the error message changed.** Each phase
> below has an acceptance criterion that asserts a *positive observation*, not the
> absence of an error string.

---

## Phase 1 — Make it work

**Goal:** the Portfolio Health Score panel renders a real, user-specific score on
both web and mobile.

**Closes:** BUG-1, BUG-2, BUG-8, BUG-11, BUG-13
**Blocked by:** nothing. **Blocks:** Phases 2 and 3.

### 1.1 — `gcp3`: register the missing route

`backend/main.py` — add a route that is **stateless and ticker-keyed**. Do *not*
add Clerk verification: the analysis is a pure function of the ticker list, and
`get_portfolio_analysis` already caches by `portfolio:{sorted_tickers}:{date}`,
so the existing code was written for this contract. Keeping user tokens off the
external host also retires the hazard already noted in
`app/api/portfolio/health/route.ts:5`.

```python
@app.get("/api/portfolio/health")
async def portfolio_health(tickers: str = Query("")) -> dict:
    symbols = [s for s in (t.strip() for t in tickers.split(",")) if s]
    raw = await get_portfolio_analysis(symbols or None)
    return to_health_contract(raw)   # 1.2
```

### 1.2 — `gcp3`: adapter to the portal's contract

**This is the step that makes Phase 1 more than a one-liner.** The two sides
share **zero** field names today:

| gcp3 emits | portal expects |
|---|---|
| `ai_grade` (`"A"`–`"D"`) | `grade` (`A`–`F`, derived by `gradeFromScore`) |
| `ai_concentration`, `ai_avg_change_pct`, `ai_num_industries` | `factors[]` (`name`/`score`/`impact`/`description`) |
| `ai_insights[]` | `summary` |
| — *no numeric score exists* | `score` (0–100) |

Because the portal coerces a missing score
(`typeof raw.score === 'number' ? … : 0`), **shipping 1.1 without 1.2 grades
every user F, silently** — a worse outcome than the current error, because it
looks like a real result.

Write `to_health_contract(raw) -> dict` emitting `score` (0–100), `factors[]`,
`summary`, `generated_at`. Derive the score from the signals the analyzer
already computes (concentration, industry count, average change). Keep the
methodology stable — per `homebase/nwftodo.md` Week 7, a score users check
repeatedly must not be jumpy.

### 1.3 — `portal`: actually send the watchlist

`app/api/portfolio/health/route.ts` — read the user's tickers from Neon and pass
them upstream. Today nothing is sent, so gcp3 would silently grade its hardcoded
10-symbol `DEFAULT_PORTFOLIO` and present a stranger's portfolio as the user's.

```ts
const tickers = (await getWatchlist(userId)).map(w => w.ticker);
const res = await fetch(`${MCP_URL}/api/portfolio/health?tickers=${encodeURIComponent(tickers.join(","))}`);
```

Drop the `Authorization` header — the endpoint no longer takes a user token.

### 1.4 — `portal`: empty-watchlist short-circuit

Return an explicit empty state before calling gcp3 when the watchlist is empty.
Never let `DEFAULT_PORTFOLIO` reach a user-facing score. `PortfolioClient.tsx`
renders "Add tickers to get your score" rather than an error.

#### What's implemented (2026-07-26, not deployed)

- 1.1 — `GET /api/portfolio/health?tickers=…` registered in `backend/main.py`, no Clerk verification, delegates to `get_portfolio_analysis`.
- 1.2 — `to_health_contract()` adapter added to `portfolio_analyzer.py`: derives `score` from diversification + concentration only (momentum deliberately excluded from the score itself, reported only as an informational factor, so the number doesn't jump on daily price noise); emits `factors[]`/`summary`/`generated_at`. Score formula is a first-cut heuristic, sanity-checked standalone (single stock → 9, well-diversified → 100), not tuned against real portfolios.
- 1.3 — `health/route.ts` and `health-ai/route.ts` both now resolve the user's Neon watchlist and pass it as `?tickers=`; the `Authorization` header to gcp3 is dropped. Cache key changed from `userId` to `userId:sorted-tickers` so a changed watchlist can't serve a stale score.
- 1.4 — empty watchlist → portal returns `204` (not an error status); `PortfolioClient.tsx` renders an explicit empty state. Mobile's `usePortfolio.ts` and `PortfolioScreen.tsx` updated to handle `204` the same way (this consumer wasn't in the original plan but breaks without the fix — a `204`'s `res.ok` is `true`, so the existing `hRes.ok ? hRes.json() : …` would throw on the empty body).

### ✅ Phase 1 acceptance

- [ ] `curl "{MCP_BACKEND_URL}/api/portfolio/health?tickers=AAPL,MSFT"` returns JSON containing a **numeric `score`** and a non-empty `factors[]`.
- [ ] Web panel shows a score that **changes when a ticker is added/removed** — this is the positive observation that proves the user's real watchlist reached gcp3.
- [ ] A watchlist of `[AAPL]` and one of `[AAPL, XOM, JNJ]` produce **different** scores.
- [ ] Empty watchlist renders the empty state, not `DEFAULT_PORTFOLIO`'s grade.
- [ ] Mobile Portfolio tab shows the same score for the same account (BUG-13).

---

## Phase 2 — Make it honest

**Goal:** the AI health check is grounded in real data, degrades visibly rather
than silently, and never returns a blank panel.

**Closes:** BUG-3, BUG-4, BUG-5, BUG-6, BUG-12
**Blocked by:** Phase 1 (the AI path can't be grounded until 1.1–1.3 land).

### 2.1 — Observability FIRST (do not skip)

The ranked causes for *"Health check returned empty"* are inferred from code
inspection and **are not confirmed live**. Confirming requires the raw upstream
SSE and the served model name for one failing request — which no code currently
logs, because BUG-6 swallows errors into an already-flushed stream.

**Land logging before touching model params**, or Phase 2 repeats the 2026-07-21
trap: a change that may or may not have fixed anything, with no way to tell.

Log per request: served model, upstream HTTP status, total bytes received,
count of parsed content deltas, count of SSE lines that parsed but yielded no
content, and whether `[DONE]` arrived.

### 2.2 — Buffer the first token before flushing headers (BUG-6)

`health-ai/route.ts` currently flushes `200 OK` immediately, then calls
`ctrl2.error(err)` on failure. The client has already committed to a success
path and cannot distinguish "upstream died" from "model said nothing." Hold
headers until the first content delta arrives (or the upstream errors), so a
real status code is still available.

### 2.3 — Raise `max_tokens` 400 → 1024 (BUG-3)

The chain is led by reasoning-capable models (`nemotron-3-ultra`/`super`);
reasoning tokens draw from the same budget. 400 is tight for a ~180-word
grounded answer *plus* hidden reasoning. `/api/nuai` uses 1024 and is not
reporting this symptom. **Confirm against 2.1's logs** that the empty responses
correlate with token exhaustion before assuming this was the cause.

### 2.4 — Treat empty completions as failures (BUG-5)

`lib/openrouter.ts:157` — `fetchWithModelFallback` falls back on HTTP status
only. A model returning `200` with an empty completion counts as success, so the
chain never advances on the exact failure users see. Make an empty completion
trigger the next model.

### 2.5 — Widen the SSE parser (BUG-4)

`lib/shared/sse.ts:30` reads only `choices[0].delta.content`. Accept
`delta.reasoning` as a fallback when no content ever arrives, and count
unparsed-but-well-formed lines so 2.1 can report them. Shared by web + mobile —
test both.

### 2.6 — Content negotiation on `health-ai` and `brief` (BUG-12)

`homebase/interactivity-15.md` §3.1 specified `Accept`-based negotiation for all
three SSE routes. Only `/api/nuai` received it (`wantsStream`). Port the same
pattern so legacy mobile builds expecting JSON stop receiving an unparseable
stream. **Cross-surface — verify against a real older app build, not just curl.**

### 2.7 — Honour the degradation obligation

`entity-portfolio-intelligence` recorded that `health-ai` should fall back to the
deterministic score rather than error. It never did, and its fallback target was
also broken. With Phase 1 landed, that target is finally healthy — wire the
fallback, and **surface the degraded state to the user** rather than only
logging it (`concept-graceful-degradation`: *degrade to a lesser state, never to
a plausible-looking fabrication*).

Also remove the silent-null path: when `fetchHealth()` fails, the panel must say
the narrative is ungrounded — not quietly emit confident prose with no data
behind it, as it has since it shipped.

#### What's implemented (2026-07-26, not deployed)

- 2.1 — `lib/openrouter.ts`'s new `fetchWithModelFallbackChecked` logs, per model attempt: model name, `sawContent`, parsed-line count, empty-line count, `sawDone`. `health-ai/route.ts` additionally logs the served model + `grounded` + watchlist size once a model is selected.
- 2.2 — `fetchWithModelFallbackChecked` "primes" each candidate model — buffers raw SSE bytes only until the first content/reasoning token or stream-end — before deciding whether to hand that stream to the caller. Because the route no longer returns `200` until a model is confirmed non-empty, the original "headers already flushed, then error" failure mode (BUG-6) can't occur for the all-empty case; a truly non-empty stream still starts flushing at effectively the same latency as before, since priming only costs extra time on the failure path that was already a dead end.
- 2.3 — `health-ai/route.ts` `max_tokens` 400 → 1024, matching `/api/nuai`.
- 2.4 / 2.5 — new `fetchWithModelFallbackChecked` (openrouter.ts) advances to the next model in `FREE_MODEL_CHAIN` when a model returns `200` with zero content **or** reasoning deltas, closing the gap where the original `fetchWithModelFallback` only checked HTTP status. **Scoped narrowly on purpose**: this is a new function, not a modified signature on the existing `fetchWithModelFallback` — `/api/nuai` and `/api/brief` still call the original, unmodified, so their latency/behavior is untouched. Only `health-ai` opts in.
- 2.6 — `wantsStream` / `Accept`-header negotiation added to both `health-ai/route.ts` and `brief/route.ts` (mirroring `/api/nuai`). **Caught a related bug while doing this**: `PortfolioClient.tsx`'s `runHealthCheck()` never sent an `Accept` header at all, so with negotiation now live it would have silently fallen to the JSON branch and lost the token-by-token streaming UI. Fixed by sending `Accept: text/event-stream, application/json`, matching `NuAIChat.tsx`'s existing pattern.
- 2.7 — `health-ai/route.ts` computes `grounded = health !== null` and returns it via the `X-Portfolio-Health-Grounded` response header (SSE path) or a `grounded` JSON field (non-SSE path). `PortfolioClient.tsx` reads it into `healthGrounded` state and renders "⚠ Based on general knowledge — your portfolio score was unavailable for this check" above the narrative when `false`, instead of the previous silent fabrication.

**Not implemented from the original 2.x list**: the deterministic-score *fallback* itself (§2.7's first sentence — "wire the fallback") wasn't added as a separate code path, because `buildHealthPrompt()` already receives `health` and already tells the model plainly when it's unavailable; what was missing was only the user-facing signal, which is what the `grounded` flag now provides. If a stronger fallback (e.g., render the deterministic score card in place of the AI panel when ungrounded) is wanted, that's still open.

### ✅ Phase 2 acceptance

- [ ] Logs show served model + delta counts for every health-ai request.
- [ ] Ten consecutive AI health checks return **non-empty** text.
- [ ] The AI narrative **cites the actual score** from Phase 1 — proving grounding, not just non-emptiness.
- [ ] Forcing an upstream failure yields a **visible degraded state**, not a blank panel and not silent fabrication.
- [ ] A JSON-expecting client (`Accept: application/json`) gets JSON, not SSE.

---

## Phase 3 — Make it safe

**Goal:** guardrails, hygiene, and stopping this class of bug from recurring.

**Closes:** BUG-7, BUG-9, BUG-10
**Blocked by:** Phase 2.

### 3.1 — Rate limit + token budget on `health-ai` (BUG-7)

Unlike `/api/nuai`, this route has no `checkRateLimit()`, no
`getRemainingBudget()`, no `recordUsage()`. Health checks bypass
`NU_AI_DAILY_TOKEN_BUDGET` entirely — an unmetered, spammable cost path on a
Pro-gated feature. Port the three guards from `app/api/nuai/route.ts`.

### 3.2 — Hygiene (BUG-9, BUG-10)

- Remove the unreachable `void userId;` after the `try/finally` in
  `health-ai/route.ts:33`, and drop the unused `userId` param.
- Stop surfacing raw `err.message` in `PortfolioClient.tsx:186` — internal
  strings like *"SSE response body is not readable"* leak to users.

### 3.3 — Distinguish the error strings

Three different faults (bad env var, missing route, upstream 5xx) all render
*"Health score unavailable."* That identical string is what hid this bug for five
days. Separate transport failure from upstream 4xx vs 5xx in the client so the
next occurrence is diagnosable from a screenshot.

### 3.4 — Bind the cross-repo contract

`lib/portfolio.ts` is described as the single-sourced type contract, but binds
only portal↔mobile. gcp3 sits on the other side of the wire with no shared schema
and drifted freely into a total field mismatch. Add a contract test that asserts
gcp3's response shape satisfies `PortfolioHealth` — a fixture checked in both
repos, or a CI smoke test hitting the live endpoint.

### 3.5 — Reconcile the stale docs

- `homebase/launch-copy.md` markets **"Portfolio Health Score — an A–F grade"** as
  a headline launch feature. Verify the delivered grade range matches; gcp3's
  grader currently tops out at **A–D and never emits F**. Fix the copy or the
  grader — do not ship a mismatch.
- `homebase/nuwrrrld-portal-audit.md`'s wiring table still reads *"⚠️ Button
  disabled, result not shown"*, which is stale.
- `homebase/roadmap-3month.md` sources the score from **`ai-fin-opt2`**; no such
  directory exists (only `ai-fin-opt`), and the code points at gcp3. Reconcile
  the intent or delete the reference.
- `docs/nuwrrrld-portal/launch-todo.md` — tick *"Brief / Health SSE routes —
  stream shape correct, empty/error states handled"* only once Phase 2 passes.

### ✅ Phase 3 acceptance

- [ ] The 13th health check in a minute is rate-limited; usage appears in `nuai_usage`.
- [ ] No raw exception text reachable in the UI.
- [ ] Three distinct failure modes produce three distinct user-facing messages.
- [ ] A deliberate gcp3 contract break **fails CI** instead of silently grading everyone F.
- [ ] Launch copy matches delivered behaviour.

---

## Bug → phase index

| # | Sev | Defect | Phase |
|---|---|---|---|
| 1 | P0 | gcp3 `/api/portfolio/health` never registered | **1** (1.1) |
| 2 | P0 | Contract drift — zero shared field names | **1** (1.2) |
| 8 | P1 | Portal never sends tickers → `DEFAULT_PORTFOLIO` | **1** (1.3) |
| 11 | P2 | No empty-watchlist guard | **1** (1.4) |
| 13 | P1 | Mobile broken by the same route | **1** (consequence) |
| 6 | P1 | Mid-stream errors after headers flushed | **2** (2.2) |
| 3 | P1 | `max_tokens: 400` vs reasoning models | **2** (2.3) |
| 5 | P1 | Fallback on HTTP status only, not empty completion | **2** (2.4) |
| 4 | P1 | SSE parser reads only `delta.content` | **2** (2.5) |
| 12 | P1 | No `Accept` negotiation on `health-ai` / `brief` | **2** (2.6) |
| 7 | P1 | No rate limit / token accounting | **3** (3.1) |
| 9 | P2 | Dead `void userId` | **3** (3.2) |
| 10 | P2 | Raw `err.message` in UI | **3** (3.2) |

---

## Cross-repo sequencing

Phase 1 spans two repos and **gcp3 must deploy first** — portal changes are
untestable until the endpoint answers.

```
gcp3       1.1 route ──▶ 1.2 adapter ──▶ deploy Cloud Run
                                              │
portal                                        ▼  1.3 send tickers ──▶ 1.4 empty state
mobile                                                      (no change — inherits fix)
```

Mobile needs no code change in Phase 1: it consumes the portal route and is
fixed as a consequence. It *does* need retesting (BUG-13 acceptance), and it
carries real work in Phase 2 (2.5 shared parser, 2.6 legacy-build negotiation).

---

## Related

- `docs/portfolio-health-ai-workflow.html` — full-stack trace + 13-defect catalogue
- `docs/wiki-portal/incident-2026-07-26-portfolio-health-endpoint-missing.md`
- `docs/wiki-portal/entity-portfolio-intelligence.md` — known failures 2–5
- `docs/wiki-portal/concept-graceful-degradation.md` — the obligation Phase 2.7 satisfies
- `gcp3-mobile/docs/wiki-mobile/entity-portfolio.md` — mobile half + the 2026-07-21 env-var incident
