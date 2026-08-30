---
date: 2026-08-30
type: concept
tags: [security, public-endpoints, auth, amplification, methodology]
sources: [../../app/api/signals/card/route.ts, ../../app/api/council/public/route.ts, ../../app/api/council/sample/route.ts, ../../app/api/health/route.ts, ../../lib/rate-limit.ts, ../../__tests__/signal-card-route.test.ts, PR#82]
---

# Concept: Auditing the Public Surface

The portal has 44 API routes. Four of them accept a request from anyone on the
internet with no credential of any kind. Knowing *which four* — and being able
to re-derive that list cheaply after any PR — is what makes the unauthenticated
surface auditable instead of assumed.

This page exists because a confident, plausible, and **wrong** claim about that
surface survived a full write-up before being checked (PR #82).

## The pattern

Every route is protected by exactly one of four mechanisms, and **the mechanism
is a property of who calls it, not of what it costs**:

1. **Clerk session** — anything a signed-in human reaches.
2. **Bearer secret** — machine callers (cron, the local signals pusher).
3. **Webhook signature** — callers that are third-party services (Stripe, Clerk).
4. **Nothing** — a deliberately public endpoint, which must then carry its own
   per-route defense sized to its cost-to-serve.

The audit discipline follows from that: for any route, name which of the four
applies, and if the answer is "none", name the defense that replaces it. A route
where neither question has an answer is the finding. Crucially, these four
mechanisms share **no common substring**, so no single text search can enumerate
them — which is the trap described under "The methodology lesson" below.

## The actual surface (2026-08-30, all 44 routes)

| Protection | Routes | Notes |
|---|---|---|
| Clerk session (`auth()` / `currentUser()`) | 29 | The default for anything user-facing |
| Bearer secret | 8 | `PORTAL_PUSH_SECRET`, `CRON_SECRET`, `LAUNCH_REMIND_SECRET` — machine callers |
| Webhook signature | 2 | Svix (Clerk) and Stripe `constructEvent` |
| **None** | **4** | `signals/card`, `council/public`, `council/sample`, `health` |

The four unauthenticated routes are each *deliberately* public, and each carries
its own defense sized to what it costs to serve:

- **`council/public`** — the landing-page demo. Defended by an IP-hashed daily
  quota (1/day), cache-first serving (a cache hit is free and consumes no
  quota), free-tier models only, and — most importantly — **ticker-only input**.
  No free-text prompt from an anonymous caller means the prompt template is
  built entirely server-side, which closes the prompt-injection door a public
  LLM endpoint would otherwise stand wide open. See [[concept-free-tier-resilience]].
- **`council/sample`** — a 6-hour in-process cache in front of a single upstream
  fetch. The expensive path runs at most 4×/day per instance.
- **`health`** — reports dependency status by name, never a secret value. Its
  whole purpose is to be reachable by an external monitor.
- **`signals/card`** — pure string templating into an SVG. No DB, no model call.
  This is the cheapest route in the app *and* the one that turned out to have
  the real bug.

## The bug the audit found

`GET /api/signals/card` builds a shareable SVG from four query params. Three are
enum-validated, so an oversized value is discarded. The fourth, `ticker`, was
free text, and was echoed into the response body through `escapeXml` — which
expands `&` into `&amp;`, five bytes out per byte in.

Unbounded, that is a response-amplification vector on an unauthenticated,
uncached endpoint. Measured, not theorized:

| Input | Response |
|---|---|
| 200 KB query string of `&` | **1,001,536 bytes** |
| Same input, bounded to 12 chars | **60 bytes** |

The fix is one `.slice(0, MAX_TICKER_LENGTH)`. The regression test in
`__tests__/signal-card-route.test.ts` was confirmed to fail with the bound
removed — a regression test that passes either way guards nothing.

Note the shape: the vulnerable route was the one with *no* database and *no*
model call. Cost-to-serve reasoning ("this route is cheap") predicts where the
money goes, not where the amplification is. Those are different questions.

## The methodology lesson

The claim that started this work was that 41 of 42 routes were unthrottled. It
came from grepping file contents for `rateLimit` and reading "no match" as "no
protection."

> **A grep proves a string is absent. It never proves a property is absent.**

Every route authenticating by bearer secret or webhook signature was invisible
to that search, because none of them contains the substring being searched for.
The real number was 4, not 41 — an order of magnitude, in the direction of
false alarm. Acting on it would have meant bolting rate limiters onto 40 routes
that did not need them, while the one genuine bug (unbounded input on a route
that *correctly* has no rate limiter) went unfixed, since it was invisible to
the same search.

The cheap correct method: **enumerate, then classify each item by its actual
mechanism.** One pass over all 44 `route.ts` files recording exported methods,
auth-call presence, and imports produced the table above. This is mechanical,
read-only, and delegable — see the 2026-08-30 entry in `~/code/homebase/fixy-log.md`,
where that enumeration was the single step that overturned the premise.

## Contradictions / tensions

> Two rate-limiter implementations coexist. `lib/rate-limit.ts` is a sliding
> window with bounded-memory sweeping (used by the privacy DSAR routes);
> `app/api/nuai/route.ts` carries its own fixed-window version inline. A fixed
> window permits a 2× burst across the window boundary that a sliding window
> does not, so two routes described as "rate limited" do not behave the same
> under load. Consolidating onto the shared module is open work.

> `/api/council/deliberate` has a daily quota (free 5 / pro 25) but no
> per-minute burst limit. Authenticated, so the blast radius is one account,
> but a quota is not a burst guard.

> ❓ Open question: the in-process limiter is explicitly per-instance and
> best-effort, since Vercel serverless instances are short-lived. On a route
> where the limit is a *cost* control rather than a spam control, is
> per-instance sufficient, or does it need a shared store to be meaningful?
> `lib/rate-limit.ts`'s own header flags this as out of scope until there is a
> reason to add Redis.

## Where it appears

- `app/api/signals/card/route.ts` — the bounded ticker and the `MAX_TICKER_LENGTH`
  constant, with the amplification reasoning recorded inline
- `app/api/council/public/route.ts` — IP-hashed quota + ticker-only input, the
  most-defended of the four public routes because it is the only one that spends
  money per call
- `lib/rate-limit.ts` — the shared sliding-window limiter, and its own header's
  note on why it is per-instance and best-effort
- `__tests__/signal-card-route.test.ts` — the route-level regression guard

## See also

- [[concept-graceful-degradation]] — the same "define the lesser state
  explicitly" stance, applied to failure rather than abuse
- [[concept-free-tier-resilience]] — why the public demo can afford to be public
- [[entity-signal-data-plane]] — what `signals/card` renders
- [[concept-test-strategy]] — where a route-level regression test belongs
  relative to the lib-level tests that already existed
