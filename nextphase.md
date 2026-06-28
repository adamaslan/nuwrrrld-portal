# Next Phase — Making the Signed-In Dashboard 10% More Interactive & 10% More AI-Native

**Date:** 2026-06-27
**Scope:** `https://financial.nuwrrrld.com/dashboard` and everything reachable from the signed-in nav bar.
**Goal:** Move the dashboard out of the "wiring-up" phase. Give each core feature a **dedicated, robust page** (not a card that links to a thin view), raise interactivity by ~10%, and make ~10% of the surface genuinely AI-native (generative, conversational, or model-reasoned) rather than static fetched text.

---

## 1. Where we are today (audit)

| Surface | File | Interactivity today | AI-native today |
|---|---|---|---|
| Dashboard home | [app/dashboard/page.tsx](app/dashboard/page.tsx) | Static server component. A market bar + a grid of link cards. No client state. | Market `brief.summary` is model-generated text, shown read-only. |
| Signals | [app/dashboard/signals/page.tsx](app/dashboard/signals/page.tsx) | Server-rendered list. Only interaction is `<details>` "Why" + share button. No filter/search/sort. | `explanation` text is AI-generated, read-only. No per-signal "ask why" or "deepen". |
| Hold/Fold | [app/dashboard/holdfold/HoldFoldClient.tsx](app/dashboard/holdfold/HoldFoldClient.tsx) | **Strong.** Search, verdict filters, row selection, detail panel, **live AI Council (T1/T2 seats)**. This is the bar to match. | Council seats call OpenRouter live ([app/api/council/route.ts](app/api/council/route.ts)). |
| Nu AI | [app/dashboard/nuai/NuAIChat.tsx](app/dashboard/nuai/NuAIChat.tsx) | Chat with input, autoscroll, daily-limit state. | Conversational AI. **No streaming** (waits for full reply), no suggested prompts, no context chips. |
| Portfolio | [app/portfolio-intelligence/page.tsx](app/portfolio-intelligence/page.tsx) | Static landing/marketing page with a server fetch. Not a real signed-in tool. | `ai_score` / `ai_action` fields rendered read-only. |
| Share / Billing / Beta / Upgrade | — | Functional, transactional. Out of scope for this phase. | n/a |

**Key finding:** Hold/Fold is the only page that feels like a product. Signals, Portfolio, and the dashboard home are read-only server renders. Nu AI works but lacks streaming and entry points. The "10% more" target is best hit by **leveling the other pages up to the Hold/Fold standard** and threading AI affordances through every surface.

**Backend endpoints already live** (GCP3 MCP backend, no auth header required for reads): `/signals`, `/market-overview`, `/industry-intel`, `/holdfold`. AI generation goes through `/api/council` (OpenRouter, gated on `nu_ai` entitlement) and `/api/nuai`.

---

## 2. Design principles for this phase

1. **Every nav item gets a dedicated, stateful page** — not a marketing card. The dashboard home becomes a *launcher + glanceable overview*, and each feature owns a full working surface.
2. **Reuse the Hold/Fold interaction grammar:** search → filter → select → detail panel → "Ask the Council". Users learn it once.
3. **AI-native = generative on demand, in context.** Every data object (a signal, a sector, a verdict, a holding) should have a one-tap "explain / deepen / ask" that calls a model with that object's exact data as context. Reuse `buildCouncilPrompt`-style grounded prompts so answers cite real numbers.
4. **Keep server components for first paint, add a thin client island for interactivity.** Matches the existing Hold/Fold split (`page.tsx` server fetch → `HoldFoldClient` island).
5. **Gate consistently** with `hasEntitlement(...)`/`tierFromStatus(...)` as today; free users get a teaser + upgrade CTA, not a blank page.

---

## 3. Concrete changes per page

### 3.1 Dashboard home — from link grid to live cockpit
File: [app/dashboard/page.tsx](app/dashboard/page.tsx) (+ new `DashboardCockpit.tsx` client island)

**Interactivity (+):**
- Make the **market bar interactive**: clicking an index chip opens an inline mini-detail (52w range, tone) instead of being static text.
- Add a **"Movers" strip** above the tool grid — top 3 Hold/Fold verdicts + top gainer/loser sector, each clickable straight to its detail (deep-link, see §3.5).
- Convert tool cards to show a **live status line** (e.g. "5 new signals today", "Council answered 2 questions") so the grid reflects state, not just labels.

**AI-native (+):**
- Add a **"Daily Brief" generative block**: one button — *"Generate my brief"* — that POSTs the user's tier + today's market overview + top verdicts to `/api/council` (or a new `/api/brief`) and streams back a 4-sentence personalized morning read. This is the flagship AI-native moment on the home screen.

### 3.2 Signals — make it a workbench, not a feed
Files: [app/dashboard/signals/page.tsx](app/dashboard/signals/page.tsx) → add `SignalsClient.tsx`

**Interactivity (+):**
- Add **search + direction filter + sort** (by confidence / ticker / timeframe), mirroring `HoldFoldClient` controls.
- Add a **detail/expand panel** per signal (reuse Hold/Fold detail layout) instead of just `<details>`.
- Persist last filter in `localStorage`.

**AI-native (+):**
- On each signal's detail, add **"Go deeper"** → calls `/api/council` with the signal's exact indicators + explanation as grounded context, returning a 1–5 day trade framing. This is the same pattern Hold/Fold already proves works.

### 3.3 Nu AI — make the chat feel native
File: [app/dashboard/nuai/NuAIChat.tsx](app/dashboard/nuai/NuAIChat.tsx)

**Interactivity (+):**
- **Suggested prompt chips** on the empty state ("Explain today's signals", "Is my watchlist overconcentrated?", "What's the market tone?") that prefill + send.
- **Context chips**: let the user attach a ticker or "today's signals" to a message so answers are grounded.

**AI-native (+):**
- **Token streaming.** Switch `/api/nuai` to a streaming response and render tokens as they arrive (replace the "Nu AI is thinking…" block with live text). This is the single highest-impact AI-native upgrade — it changes the *feel* from request/response to assistant.

### 3.4 Portfolio — promote from landing page to a real signed-in tool
New file: `app/dashboard/portfolio/page.tsx` (server) + `PortfolioClient.tsx` (island). Keep `app/portfolio-intelligence/page.tsx` as the public marketing route; point the signed-in nav at the new `/dashboard/portfolio`.

**Interactivity (+):**
- A **watchlist manager** (the API already exists: [app/api/portfolio/watchlist/route.ts](app/api/portfolio/watchlist/route.ts) + `[ticker]`). Add/remove tickers, see them re-sort live.
- **Sector rotation view** from `/industry-intel`: clickable leaders/laggards that expand to returns + AI score.

**AI-native (+):**
- **"Health check"** button: POST watchlist + the portfolio health endpoint ([app/api/portfolio/health/route.ts](app/api/portfolio/health/route.ts)) into a council prompt → generative A–F explanation + one concrete rebalancing suggestion, grounded in the real factor data.

### 3.5 Cross-cutting: deep-linkable detail routes
Add a `[ticker]` detail route (e.g. `app/dashboard/holdfold/[ticker]/page.tsx`) so verdicts/signals are **shareable and linkable** from the movers strip and Nu AI answers. This is the pattern the sibling `code2/signals-app` already uses (`signals/[symbol]/page.tsx`) and is what makes the surfaces feel connected rather than siloed.

---

## 4. New / changed API surface

| Endpoint | Purpose | Notes |
|---|---|---|
| `POST /api/brief` (new) | Daily personalized brief for dashboard home | Wraps `/market-overview` + top verdicts into a grounded council prompt. Gate on `nu_ai`. |
| `POST /api/nuai` (change) | **Add streaming** (`ReadableStream` / SSE) | Biggest single AI-native win. |
| `POST /api/council` (reuse) | "Go deeper" on signals, portfolio health | Already grounded + gated — just new prompt builders. |
| `GET/POST/DELETE /api/portfolio/watchlist*` (reuse) | Backing store for the new portfolio tool | Already implemented. |

No new backend (GCP3) work is required for phase 1 — everything composes from existing read endpoints + OpenRouter.

---

## 5. Suggested file plan

```
app/dashboard/
  page.tsx                      ← add movers strip + live status; mount DashboardCockpit
  DashboardCockpit.tsx          ← NEW client island: interactive market bar + "Generate brief"
  signals/
    page.tsx                    ← server fetch (unchanged), render SignalsClient
    SignalsClient.tsx           ← NEW: search/filter/sort + detail + "Go deeper"
  nuai/
    NuAIChat.tsx                ← add streaming, prompt chips, context chips
  portfolio/
    page.tsx                    ← NEW signed-in tool (server fetch)
    PortfolioClient.tsx         ← NEW: watchlist manager + rotation + AI health check
  holdfold/
    [ticker]/page.tsx           ← NEW deep-link detail route
app/api/
  brief/route.ts                ← NEW grounded daily-brief endpoint
  nuai/route.ts                 ← CHANGE to streaming
lib/
  brief.ts                      ← NEW prompt builder for the daily brief
  prompts.ts                    ← extract buildCouncilPrompt + new signal/portfolio prompt builders
```

---

## 6. Phasing & estimated effort

**Phase 1 — Highest leverage, lowest risk (do first)**
1. Nu AI streaming + prompt chips. *(largest perceived-AI jump)*
2. Signals workbench (search/filter/sort + "Go deeper"). *(largest interactivity jump; copies a proven pattern)*
3. Dashboard "Generate my brief". *(flagship AI moment on the entry screen)*

**Phase 2 — Depth**
4. `/dashboard/portfolio` real tool with watchlist + AI health check.
5. Interactive market bar + movers strip on home.
6. `[ticker]` deep-link detail routes; wire movers + Nu AI answers to them.

Phase 1 alone clears the "+10% interactive / +10% AI-native" bar: it adds streaming, three new generative entry points, and full search/filter/sort to the page that currently has none.

---

## 7. Acceptance criteria

- [ ] Every signed-in nav item resolves to a **stateful** page (client interactivity, not a static render) — Signals and Portfolio specifically.
- [ ] At least **3 new in-context generative actions** exist beyond the Hold/Fold Council (brief, signal "go deeper", portfolio health check).
- [ ] Nu AI responses **stream**.
- [ ] Free vs. Pro gating is preserved on every new surface via `hasEntitlement`.
- [ ] No new GCP3 backend endpoints required for Phase 1.
- [ ] Detail views are deep-linkable so movers/Nu AI can route into them.

---

## 8. Notes & guardrails

- This repo runs a **non-standard Next.js** (see [AGENTS.md](AGENTS.md)). Read the relevant guide in `node_modules/next/dist/docs/` before adding streaming routes or new route segments — APIs may differ from training data.
- Keep the server-fetch-then-client-island split that Hold/Fold uses; don't make whole pages client components.
- Reuse existing CSS conventions (`hf-*`, `signals-*`, `nuai-*`) for new surfaces so the design language stays consistent.
- All AI prompts must stay **grounded in real fetched data** (the `=== REAL DATA ===` prompt pattern) to avoid hallucinated numbers.
