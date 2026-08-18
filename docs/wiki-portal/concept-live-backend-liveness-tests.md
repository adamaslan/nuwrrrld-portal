---
date: 2026-08-18
type: concept
tags: [testing, playwright, liveness, real-data, gcp3, openrouter, portfolio, signals]
sources: [../../e2e/frontend/portfolio-liveness.spec.ts, ../../e2e/frontend/signals-liveness.spec.ts, ../../e2e/preflight/credentials.spec.ts]
---

# Concept — Live Backend Liveness Tests (create a portfolio, then test against real data)

How to actually exercise the portal against real upstream data — a real
watchlist, a real gcp3 call, a real OpenRouter completion — rather than only
the mocked fault-injection suite. Written after a session that found three
live incidents ([[entity-portfolio-intelligence]] failures 3, 7;
[[entity-signal-data-plane]] failure 4) that the existing mocked suite could
not have caught, because mocking necessarily assumes the mock is a plausible
stand-in for reality — it can't tell you reality changed.

## The pattern

[[entity-playwright-e2e]]'s `frontend` project already had one non-mocking
precedent: `e2e/preflight/credentials.spec.ts`'s "core liveness" tests (cheap
authenticated calls confirming `OPENROUTER_API_KEY`/`MCP_BACKEND_URL` are
*reachable at all*, no app logic involved). This concept extends that same
instinct — real call, no mock — to the two data-bearing surfaces that most
need it: Portfolio and Signals.

**The workflow to reproduce it manually** (what these tests automate):

1. Sign in as the E2E test user (or your own dev session).
2. Go to `/dashboard/portfolio`. Add a real, liquid ticker to the watchlist
   (`AAPL` is what the automated tests use — anything gcp3 will actually have
   data for works). An empty watchlist collapses every portfolio panel to its
   "empty" state before any backend call happens, so this step is not
   optional.
3. Click "Run health score" — this hits `/api/portfolio/health` →
   `{gcp3-backend-url}/api/portfolio/health?tickers=...`, a real call.
4. Click "✦ Run AI health check" — hits `/api/portfolio/health-ai`, which
   calls gcp3 for grounding data *and* OpenRouter for the narrative. Two
   independent live dependencies in one click.
5. Optimizer Suggestions fetches on mount — no click needed, but same
   principle: `/api/portfolio/suggestions` → gcp3, live.
6. Go to `/dashboard/signals` — the digest (`/api/signals/digest`) is always
   live gcp3 data; there is no mock path in production. Expand a card and
   check its `generatedAt`/stale badge against the raw API response for the
   same ticker.

**What the automated tests do differently from `portfolio-health.spec.ts` /
`signal-timing.spec.ts`'s DOM assertions:** those specs use
`page.route(...).fulfill(...)` to fabricate a response and assert the portal
handles a *given* shape correctly — deterministic, fast, and correct for
testing the portal's own logic. `portfolio-liveness.spec.ts` and
`signals-liveness.spec.ts` issue the real request and assert on whatever comes
back — non-deterministic, slower, and the only way to know whether gcp3's
`/api/portfolio/health` route currently exists at all (it didn't, confirmed
2026-08-18, independently of anything this repo controls).

## Where it appears

- `e2e/frontend/portfolio-liveness.spec.ts` — Portfolio Health Score, Portfolio
  Health Check · AI, Optimizer Suggestions. `test.skip` when
  `MCP_BACKEND_URL`/`OPENROUTER_API_KEY` are unset (never fails on missing
  config, same as `preflight`'s liveness tests). Adds a real ticker
  (`AAPL`) via the watchlist API in `beforeEach`, cleans it up in `afterEach`
  — a **real Neon write**, not a mock, so it's scoped tightly to avoid
  polluting the E2E test user's actual watchlist state across runs.
- `e2e/frontend/signals-liveness.spec.ts` — the digest feed's per-signal
  `generatedAt` validity, and `POST /api/signals/{ticker}/chat` tested against
  both a real tracked symbol (`SOXX`) and untracked individual stocks (`MU`,
  `GOOG`) specifically to distinguish "route is down for everyone" from
  "ticker isn't in gcp3's universe" — confirmed 2026-08-18 that it's the
  former (all three 404 identically against gcp3).
- `e2e/preflight/credentials.spec.ts`'s "core liveness" describe block — the
  original, narrower precedent (key validity only, no app-level assertions).

## What real-ticker testing found (2026-08-18 session)

Concrete findings this pattern surfaced that mocked tests structurally cannot:

1. `{gcp3-backend-url}/api/portfolio/health` — live `404`/`502`, not a
   hypothetical from [[incident-2026-07-26-portfolio-health-endpoint-missing]]
   but an active recurrence, re-confirmed twice in the same session.
2. `{gcp3-backend-url}/api/portfolio/suggestions` — also live `404`,
   previously undocumented as still-broken.
3. `POST /api/portfolio/health-ai` — `503 "AI unavailable"` twice
   consecutively; `FREE_MODEL_CHAIN` fully exhausted at the time of testing,
   independent of the gcp3 outage above.
4. `{gcp3-backend-url}/signals/{ticker}/chat` — live `404` for every ticker
   tried, tracked (`SOXX`) or not (`MU`, `GOOG`) — the route itself isn't
   deployed on gcp3, and (separately) has zero UI callers in this repo, so
   it's currently dead on both ends.
5. Each symbol entry in `{gcp3-backend-url}/signals` **does** carry its own
   `updated` timestamp — this repo's adapter was silently discarding it in
   favor of one batch-wide value (fixed, see
   [[entity-signal-data-plane]]).

None of these were visible from the mocked suite, because a mock only proves
"the portal handles *this* shape correctly" — it can't prove the real backend
still emits any particular shape, or is reachable at all.

## Contradictions / tensions

> ⚠️ Contradiction: these tests are non-deterministic by design (they depend
> on gcp3/OpenRouter's live state), which is exactly what makes them valuable
> and exactly what makes them unsuitable as a default CI gate the way
> `portfolio-health.spec.ts`'s mocked tests are. They currently run only via
> explicit `-g` filter or full local `frontend` runs, not wired into
> `.github/workflows/e2e-resiliency.yml`'s default job. Whether they belong in
> CI at all (as a non-blocking, informational job) is undecided — see open
> questions.

> ⚠️ Contradiction: `portfolio-liveness.spec.ts` writes a real row to the E2E
> test user's Neon-backed watchlist (`AAPL`), then deletes it in `afterEach`.
> If a run crashes between the two, the ticker leaks into the test user's
> real watchlist. No cleanup-on-crash guard exists yet (would need a
> `beforeAll`/`afterAll` reconciliation step, not per-test `afterEach`).

## Open questions

- ❓ Should a non-blocking, informational CI job run these liveness specs on
  a schedule (e.g. hourly) so a gcp3 route going 404 is caught within an hour
  instead of only when a human happens to click "Run health score" or a
  session happens to add real-ticker tests? Would need its own workflow,
  separate from `e2e-resiliency.yml`'s PR-gating job, and a place to post the
  result (Slack? a wiki `log.md` entry? — undecided).
- ❓ `signals-liveness.spec.ts` tests `MU`/`GOOG` specifically because they're
  real, liquid, individual-stock tickers outside gcp3's 54-symbol
  sector/thematic-ETF universe. If gcp3 ever adds individual-equity coverage,
  this test's premise ("MU/GOOG are untracked") needs re-verifying, not
  assumed permanent.

## See also

- [[entity-playwright-e2e]] — the fifth pattern within this suite; see its
  "Where used" and "Known failures" for the full liveness-test list
- [[entity-portfolio-intelligence]] — the three Portfolio-panel failures this
  pattern confirmed live (3, 4, 7)
- [[entity-signal-data-plane]] — the per-ticker timestamp fix and the dead
  chat-route finding
- [[concept-test-strategy]] — `live` vitest project is the same instinct
  (real model calls, skip loudly on missing config) at the unit-test layer
- [[incident-2026-07-26-portfolio-health-endpoint-missing]] — the incident
  this pattern re-confirmed is still open, not resolved
