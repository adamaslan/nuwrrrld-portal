---
date: 2026-09-11
type: incident
tags: [nulogdash, clerk, auth, test-harness, silent-failure, classification, stripe, openrouter]
sources: [../../scripts/nulogdash.mjs, ../../scripts/lib/nulogdash-auth.mjs, ../../scripts/nulogdash-inventory.mjs, ../../scripts/nulogdash-fixture.mjs, ../../lib/openrouter.ts, ../../lib/signal-chat-local.ts]
---

# Incident — The Feature Sweep Had Never Authenticated, and Was Hiding Four Real Bugs

## Date & severity

2026-09-11 (resolved). Introduced with the sweep itself. **High as a
process failure, low as an outage** — nothing user-facing broke *because* of
this, but the one instrument built to tell us whether features work had been
reporting "unknown" for 38 of 59 features and was believed to be reporting
"blocked pending a config step."

## What happened

`/nulogdash` authenticated as a user by reading a Clerk `__session` cookie out of
`NULOGDASH_SESSION_COOKIE`, pasted by hand from browser devtools. The variable was
empty, so every auth-required feature reported `blocked`, and the standing
interpretation was "someone needs to paste a cookie."

**No cookie would have worked.** Two independent reasons, either sufficient:

1. A Clerk session cookie is a short-lived JWT that `clerk-js` silently refreshes
   in the browser. A hand-pasted value is stale within about a minute — so the
   var could never have held a working credential for the length of a sweep, let
   alone between sweeps.
2. On a **development** instance Clerk uses *suffixed* cookies
   (`__session_<suffix>`), so the bare `__session` name the runner sent was not
   the cookie Clerk reads. Verified directly: the cookie form returns `401`,
   the bearer form reaches the handler.

So the sweep's coverage number was not "38 features pending a manual step." It was
**38 features that this design could never exercise**, reported in a state that
looked like a chore rather than a defect.

Once the sweep could authenticate, it immediately found four real bugs it had been
covering for — all of them in code paths it had supposedly been watching.

## Root cause

One root cause, applied twice.

**The harness was trusted to be honest about itself, and it wasn't instrumented
to be.** `blocked` is the sweep's own most important idea — see
[[entity-nulogdash]] — and it was load-bearing for the harness's own credibility:
because `blocked` reads as "environmental, not our problem," a permanently
blocked row costs nobody anything to leave alone. Nothing distinguished
*blocked because a step is pending* from *blocked because this can never work*,
and the second masquerading as the first is stable indefinitely.

The secondary cause is that the sweep re-solved a problem the repo had already
solved properly. [[entity-playwright-e2e]] signs a dedicated Clerk test user in
via `@clerk/testing` and caches the session; the sweep hand-rolled a worse
mechanism next to it. That gap was already written down as an open question on
[[entity-nulogdash]] — recorded, and then not acted on, because nothing was
failing loudly.

## Resolution

**Auth, replaced rather than fixed.** `scripts/lib/nulogdash-auth.mjs` mints a
session token per run from `CLERK_SECRET_KEY` and the same test user the e2e
suite uses, and presents it as `Authorization: Bearer`. Nothing is pasted, the
token re-mints before expiry mid-sweep, and `NULOGDASH_SESSION_COOKIE` survives
only as an override nobody should need. Result: **0 features blocked on session.**

**Four real bugs, found immediately:**

1. **`POST /api/signals/{ticker}/chat` had never worked, for anyone.** It proxied
   to `{gcp3-backend-url}/signals/{ticker}/chat`, which is not registered on gcp3
   — confirmed against the backend's live OpenAPI, the same evidence method that
   settled [[incident-2026-07-26-portfolio-health-endpoint-missing]]. Every call
   404'd upstream and returned a flat `503`. Fixed by
   [[decision-local-signal-chat-over-missing-gcp3-agent]].
2. **The T1 council seat was pointed at a model that 403s for this account.**
   `thinkingmachines/inkling-small:free` is gated to "agentic harnesses", and 403
   was not a fall-through status, so the seat *threw* instead of degrading —
   taking `GET /api/council/sample` (T1 + T2) down as a hard 503. See
   [[entity-openrouter-client]].
3. **T2 and MACRO were answering entirely from the fallback chain.** Both sat on
   `google/gemma-4-*:free`, which return `429` on every probe including the
   retry. This is the *exact* invisible degradation
   [[decision-free-tier-model-chain]] was written to prevent, recurring because
   the weekly audit checked existence and price but never reachability.
4. **Two routes aborted their own model calls mid-fallback.**
   `portfolio/health-ai` and `brief` each wrapped the fallback walk in a literal
   `25_000` ms budget — shorter than one full walk of primary + chain. Whenever
   the primary didn't answer, the request was killed with healthy models still
   untried and returned `503 "AI unavailable"`. Now derived from chain length
   (`MODEL_CHAIN_WALK_BUDGET_MS`), so deepening the chain cannot silently
   invalidate every caller's timeout again.

**Three classification errors in the inventory** — the sweep reporting defects
that were really its own description being wrong: `/api/nuai` was sent
`{question}` when it reads `messages`; `POST /api/referral` was slugged
"referral-create" when it *redeems* a code; `retention/trial-nudge` was marked as
a user feature when it is a `CRON_SECRET` route that sends real email.

**Two safety guards added, both fail-closed:**

- **Stripe.** `STRIPE_SECRET_KEY` in `.env.local` is a `sk_live_` key, and the
  sweep `POST`s `/api/stripe/checkout` and `/api/stripe/portal` — which create a
  real Checkout Session and, via the portal's lazy provisioning, a real
  **Customer**, on the live account, every run. Billing features are now
  `blocked` unless the key is `sk_test_`. This is the one finding here that was
  actively harmful rather than merely blind.
- **HTTP 429 is `blocked`, not `fail`.** `GET /api/privacy/export` is limited to
  roughly one call per user per hour, so iterating the sweep exhausted it and a
  working feature reported red. A rate-limited call means the feature was not
  exercised, which is precisely what `blocked` is for.

**The sweep stopped sabotaging itself.** Route discovery walks the filesystem,
which ordered the watchlist steps `remove` → `list` → `add`. The synthetic ticker
was therefore added and never cleaned up, and since the watchlist *is* the
portfolio ([[decision-local-portfolio-scoring-over-upstream-wait]]), after one
sweep the test user's entire portfolio was one ticker with no computed card —
so `GET /api/portfolio/health` correctly answered `503 no signals computed` and
the sweep reported a failure it had caused. Fixed with an explicit run order
(add → list → remove) plus `scripts/nulogdash-fixture.mjs`, which seeds real
card-covered tickers and verifies coverage before inserting.

Final state: **39 pass, 0 fail, 4 blocked, 16 excluded by design**, and the sweep
is idempotent — the watchlist is byte-identical before and after a run.

## Impact on design

The `blocked` state was introduced to stop the sweep lying about coverage, and it
worked — while creating a quieter way to lie. A row that is permanently blocked
is indistinguishable from one that is temporarily blocked, and the sweep's own
framing ("a blocked feature is one whose dependency was unmet, not one that
failed") makes the permanent case *comfortable*. The honest classification was
correct and still hid the problem.

That generalises past this harness: **a state that correctly means "not our
fault" needs an expiry, or it becomes a place for work to go and not come back.**
Four of the six things fixed here were living inside a row nobody was obliged to
look at.

The second lesson is narrower and sharper: **existence is not reachability.** The
seat audit had already been tightened once, after a seat was found running a paid
model (PR #115). It was tightened in the wrong dimension — the check still only
consulted the catalog. Three further failures walked through it. A check on a
remote dependency that never calls the dependency is a check on our own
description of it.

## Open items

- ❓ Should a `blocked` row carry a first-seen date, so "blocked for 40 days" reads
  differently from "blocked today"? That is the mechanism this incident argues
  for and does not implement.
- ❓ The gold set behind the judge gate has **two** cases, so one disagreement is
  50% and fails the 0.8 threshold. Observed live this run (judge scored a
  deliberately mediocre fixture 10 against a gold 5). The gate worked, but n=2
  cannot separate a drifting judge from an unlucky one.
- ❓ `followed_ticker_picks` is empty — no cohort has ever been frozen, so the
  tracking pipeline has never had anything to track. It runs, logs, and correctly
  reports zero; that is untested-in-anger, not working.
- ❓ `expectStatus` now lets an inventory entry declare a non-2xx as passing. It
  is commented at every use, but it is the one field that can turn a real defect
  green. Worth a lint that requires a comment beside it.
- ❓ Who is meant to notice a `403` from a model vendor? The fall-through now
  handles it and warns, but the warning lands in a dev-server log nobody reads.

## See also

- [[entity-nulogdash]] — the harness; known failure 3 is closed by this incident
- [[decision-local-signal-chat-over-missing-gcp3-agent]] — the dead-endpoint fix
- [[entity-openrouter-client]] — seat repoint, 403 fall-through, derived walk budget
- [[decision-free-tier-model-chain]] — the reachability gap that let two seats rot
- [[entity-playwright-e2e]] — the auth mechanism the sweep should have adopted from the start
- [[decision-local-portfolio-scoring-over-upstream-wait]] — why a polluted watchlist broke a scorer
- [[incident-2026-08-31-signals-go-deeper-contract-drift]] — the same shape: a feature dead for weeks behind a plausible-looking error
- [[concept-graceful-degradation]] — the rule the 25s abort and the 403 throw both broke
