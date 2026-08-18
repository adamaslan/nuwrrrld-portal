# Build Options: Mitigating API Failures (esp. Just-In-Time Ticker Calls)

Status doc, not a decided roadmap. Written 2026-08-18 after a session that
confirmed several live gcp3/OpenRouter failures via new liveness tests (see
`docs/known-bugs.md` and `docs/wiki-portal/concept-live-backend-liveness-tests.md`).
Lays out concrete build options — with tradeoffs, not a recommendation to
build all of them — for making the portal resilient to (a) gcp3 routes that
are down or unregistered, (b) OpenRouter's free-model chain being exhausted,
and (c) the specific pain of **just-in-time per-ticker calls** (a user clicks
something, the portal calls gcp3 *right now* for *that specific ticker*, and
has 5–8 seconds to get a usable answer or degrade honestly).

---

## The problem, precisely

Three live incidents confirmed this session, all upstream of this repo:

| Route | Called by | Confirmed status (2026-08-18) |
|---|---|---|
| `{gcp3}/api/portfolio/health` | `/api/portfolio/health`, `/api/portfolio/health-ai` | `404`/`502` |
| `{gcp3}/api/portfolio/suggestions` | `/api/portfolio/suggestions` | `404` |
| `{gcp3}/signals/{ticker}/chat` | `/api/signals/[ticker]/chat` | `404` for every ticker tried (tracked or not) |
| OpenRouter `FREE_MODEL_CHAIN` | `/api/portfolio/health-ai`, `/api/nuai` | `503` — whole chain exhausted at least once this session |

Two of these (`portfolio/health`, `portfolio/suggestions`) are **batch/session
calls** — one request per page load, moderate latency tolerance. The third
(`signals/{ticker}/chat`) and the existing per-ticker lookup
(`lib/shared/signal-lookup.ts`'s `fetchTickerEntry`, `{gcp3}/signals?symbol=X`)
are the **just-in-time** case this doc is mostly about: a user takes an action
naming one specific ticker, and the portal has a tight window to answer with
that ticker's real data or say so honestly.

The JIT case is harder than the batch case for three reasons:

1. **No pre-fetch is possible** — you don't know which ticker until the click.
2. **Latency budget is tight and user-visible** — `signal-lookup.ts` already
   uses an 8s timeout; a spinner past ~2-3s reads as broken even if it
   eventually resolves.
3. **A miss is maximally visible** — it's the one thing the user just asked
   about, not a background batch they won't notice failed.

### The JIT interactive surfaces, enumerated

Worth naming explicitly, because "the JIT case" is really four distinct
click-to-answer paths with different budgets and different fallbacks:

| Surface | Entry point | Backend hop | Budget | Fallback today |
|---|---|---|---|---|
| Nu AI chat about a ticker | `/api/nuai` (streaming) | `fetchTickerEntry` grounding + OpenRouter | first token < ~1.5s | ungrounded answer, or 503 if the model chain is out |
| Council deliberation | `/api/council/deliberate` | `fetchTickerEntry` grounding ×N + OpenRouter | ~10s+, user expects a wait | partial/ungrounded verdict |
| Watchlist add | `/api/portfolio/watchlist/[ticker]` | enqueue → `signal-queue` drain | should be instant (optimistic) | queued row, filled asynchronously |
| Per-ticker chat (dead) | `/api/signals/[ticker]/chat` | `{gcp3}/signals/{ticker}/chat` | ~5s | **none** — bare proxy, 503 straight through |

The watchlist row is the interesting one: it's the only path that has already
solved JIT properly by *refusing to be JIT*. It accepts the click, writes a
queue row, returns immediately, and lets `/api/signals/drain` fill it in with
`backoffSeconds()` retry. Every other surface blocks the user on a live hop.
That asymmetry is the seed of option 6 below.

---

## What already exists (don't rebuild this)

`lib/shared/signal-lookup.ts`'s `fetchTickerEntry` is **already a decent JIT
mitigation pattern** — worth using as the template for anything new, not
replacing:

```
fresh signal_cache row (Neon L2, volatility-aware TTL)
  → live gcp3 fetch (8s timeout)
      → warm the cache on success
      → serve STALE cache row on failure (old-but-real, not nothing)
          → null only if there's truly never been a cached value
```

This is read-through caching with **serve-stale-on-outage**, not just
cache-then-fail. `cacheTtlMinutes()` (`lib/shared/signal-policy.ts`) makes the
freshness window volatility-aware (hot/actionable signals expire in 5 min,
quiet ones in 30) so the cache doesn't uniformly go stale at the same rate
regardless of how much the underlying data actually moves.

Three more pieces of existing machinery are load-bearing for anything built
here, and are easy to miss:

- **`readCachedEntry`'s discriminated result** (`hit` / `miss` / `broken`) —
  a cold miss and an unreachable Neon are *different failures*, and the type
  already distinguishes them. Any new degradation path should read this rather
  than collapse both to `null`; "we've never seen this ticker" and "our cache
  is down" deserve different UI copy.
- **`backoffSeconds(attempts, base, max)`** — exponential, capped at 1h,
  already unit-tested. Any retry logic added anywhere should call this, not
  hand-roll a second backoff curve that drifts from it.
- **`consumeSSE`** (`lib/shared/sse.ts`) — the shared streaming parser used by
  both web and mobile. It's the reason streaming-first degradation (option 7)
  is cheap rather than a new transport.

The gap: **this pattern isn't applied everywhere it could be.** `/api/signals/[ticker]/chat`
has no cache at all — it's a bare proxy, so a gcp3 outage there means an
immediate, uncachable 503 with nothing to fall back to. `/api/portfolio/health`
and `/api/portfolio/suggestions` also have no stale-serve fallback — they're
either live-or-nothing (health, suggestions) or live-or-503 (the whole
`health-ai` chain).

---

## Build options

Ordered by effort, not necessarily by priority — pick based on which failure
mode is actually costing the most right now.

### 1. Extend the existing cache-then-degrade pattern to the uncovered routes

**What:** Give `/api/portfolio/health`, `/api/portfolio/suggestions`, and
`/api/signals/[ticker]/chat` the same `signal_cache`-style Neon L2 +
serve-stale-on-outage treatment `signal-lookup.ts` already has.

**Effort:** Low-medium. The pattern is proven and unit-tested
(`lib/shared/signal-policy.ts`); this is mostly wiring, not new design.
`portfolio/health` already caches (15-min flat TTL, in-memory `Map`, not
Neon) — the gap there is specifically **no serve-stale-on-outage fallback**,
just cache-hit-or-live-fetch-or-error.

A note on the in-memory `Map`: on Vercel it is per-instance and dies with the
container, so its real hit rate under bursty traffic is far below what a local
`next dev` session suggests. Moving `portfolio/health` to the Neon L2 isn't
only about stale-serve — it's the difference between a cache that survives a
cold start and one that doesn't.

**Tradeoff:** A stale portfolio health score or stale chat answer is
*plausible-looking* — the [[concept-graceful-degradation]] tension the wiki
already flags ("degrade to a lesser state, never to a plausible-looking
fabrication"). Staleness must be surfaced in the UI (a badge, a timestamp),
not silently served as current. The existing `isStale`/`dataQualityScore`
machinery on the signals side is the template for how to do this without
lying to the user.

**Best for:** `portfolio/health` and `portfolio/suggestions` — session-scoped,
moderate staleness tolerance, users already expect "your score" to update
periodically rather than instantaneously.

**Weakest for:** `signals/{ticker}/chat` — an ask-anything chat answer being
served stale is a worse UX than the other two (a stale *answer to a specific
question* reads as wrong in a way a stale *score* doesn't), and this route has
zero UI callers right now anyway (see option 5).

---

### 2. A scheduled liveness check (GitHub Actions cron) — status, not mitigation

**What:** A lightweight script (`scripts/check-backend-routes.mjs`, plain
Node ESM, no deps — same shape as `scripts/refresh-free-models.mjs`) that
directly probes the three broken gcp3 routes plus a couple of OpenRouter free
models, on a schedule (`.github/workflows/backend-liveness.yml`,
`workflow_dispatch` + `cron`). On failure, opens/updates a single tracking
GitHub issue rather than a PR — there's nothing to merge, just a signal.

**Effort:** Low. This is the `refresh-free-models.yml` pattern with the "open
a PR" step swapped for "open/update an issue." No Playwright, no browser, no
Clerk auth — these are unauthenticated-from-gcp3's-perspective calls, so a
bare `fetch` script suffices (this is *not* what
`e2e/frontend/portfolio-liveness.spec.ts` / `signals-liveness.spec.ts` are
for — those prove the *portal's own proxy layer* behaves correctly against
real backends, which needs the full authenticated app; this is a much
cheaper, narrower "is gcp3 even up" check that doesn't need the app at all).

**Extension worth the extra hour:** have the script write its result to a
small Neon table or a committed `public/backend-status.json`, and let the app
read it. That turns pure monitoring into a **circuit-breaker input** — if the
last three probes of `{gcp3}/api/portfolio/health` failed, the portal can skip
the doomed 8s live call entirely and go straight to stale-serve, converting a
guaranteed 8-second spinner into an instant labeled-stale render. This is the
single cheapest latency win available in this whole document, because it costs
one boolean read and removes a full timeout from the critical path.

**Tradeoff:** As pure monitoring, this *finds* outages faster (hourly vs.
"whenever someone happens to test manually") — it does not *fix* anything.
Pair it with option 1, or with the circuit-breaker extension above, or it's
just a faster way to learn about a problem you still can't route around.

**Best for:** Closing the detection gap identified in
`concept-live-backend-liveness-tests.md`'s open questions — "a gcp3 route
going 404 caught within an hour instead of only when a human happens to
test." Cheap, safe, no app-behavior risk.

---

### 3. Modal-based JIT proxy with its own short-lived cache

**What:** A Modal function (matching the `deploy/free-model-refresh/` and
`homebase/modal_finnhub_ws.py` precedents already in this codebase) sitting
in front of gcp3's per-ticker endpoints specifically, with its own fast
in-memory or Modal-dict cache and a tighter retry/backoff policy than a
single Vercel serverless function invocation can afford (Modal containers can
stay warm; a Vercel function cold-starts per request).

**Effort:** Medium-high. New infra, new deploy target, another moving piece
in an already multi-repo system (`homebase/` already hosts two Modal jobs for
this project).

**Tradeoff:** This is the heaviest option and mainly buys **latency** and
**warm-container retry budget** — not correctness. If gcp3's route is
genuinely 404 (unregistered, not just slow), no amount of Modal-side caching
or retrying fixes that; only extends how long a *previously successful* call
stays servable. Matches the existing Finnhub WS pattern's shape
(`min_containers=1`, persistent connection) far better than it matches a
per-ticker JIT chat call, which has no "keep a connection open" analog — each
chat question is a one-off POST, not a stream to debounce.

**Best for:** If gcp3 latency (not availability) turns out to be the real
complaint once the 404s are fixed — Modal's warm-container model genuinely
helps there in a way GHA cron and simple caching don't. **Not** a fix for the
current 404s, which are a gcp3-deployment problem no client-side infra
change can address.

---

### 4. Client-side: explicit stale/degraded affordances instead of spinners

**What:** For the JIT case specifically — when a per-ticker call is in
flight and could time out, show the UI's *current best guess* immediately
(last known signal_cache entry, explicitly labeled "as of {time}") rather
than a blank loading state, then replace it if the live call succeeds within
budget.

**Effort:** Low, mostly frontend. `SignalsClient.tsx` already has the
`isStale` badge machinery to reuse; this is extending "show stale data
labeled as stale" from the digest feed to the JIT single-ticker paths
(chat, backtest track-record) that currently just show a spinner-then-error.

**The state vocabulary matters more than the components.** Four states, not
two, and each needs distinct copy so the user can tell them apart:

| State | Source | Honest copy |
|---|---|---|
| `live` | fresh fetch succeeded | (no badge) |
| `stale` | cache hit, TTL expired, backend down | "as of {time}" |
| `cold` | `readCachedEntry` → `miss` | "no data yet for {ticker}" |
| `broken` | `readCachedEntry` → `broken`, or circuit open | "can't reach our data right now" |

Collapsing `cold` and `broken` into one "unavailable" state is the mistake to
avoid: the first is a normal state for a ticker nobody's looked at, the second
is an outage. Users retry the first and give up on the second, and they need
to know which they're facing. The type already carries this distinction
(`CacheReadResult`) — the UI just discards it today.

**Tradeoff:** Requires the cache to actually have *something* to show (so
this is complementary to option 1, not a substitute) — an uncached route
with no prior successful call has nothing to optimistically render.

**Best for:** Immediate UX improvement on routes that already have a cache
layer (`signal-lookup.ts`'s consumers) but currently only render on success.
Cheapest option here in terms of engineering effort relative to user-visible
improvement.

---

### 5. Decide the fate of the dead `signals/{ticker}/chat` route

**What:** Not a resilience build — a scope decision. This route has **zero UI
callers anywhere in this repo** (confirmed via grep) and its gcp3 backend
404s for every ticker tested. Two honest paths: (a) wire up the UI once gcp3
ships the route, treating today's work as "ready and waiting," or (b) remove
the dead proxy until there's a concrete plan to use it, since undead
infrastructure with a broken backend is pure liability — it can't be
monitored meaningfully (option 2 would just confirm "still dead" forever)
and it's one more place a future contributor might build against something
non-functional.

**Effort:** Trivial either way — this is a decision, not an implementation.

**Tradeoff:** None really; this just needs someone to decide rather than
leave it ambiguous. Currently tracked as an open item in
`docs/wiki-portal/entity-signal-data-plane.md` known-failure #4.

---

### 6. Accept-and-queue: make the JIT path optimistic, like watchlist already is

**What:** Generalize what `/api/portfolio/watchlist/[ticker]` already does.
For any per-ticker action where the user's *intent* can be recorded instantly
and the *answer* can arrive a beat later, return `202`-shaped immediately with
whatever the cache holds, enqueue the refresh into `signal-queue`, and let the
existing `/api/signals/drain` worker fill it in with `backoffSeconds()` retry.
The client either polls once or — better — subscribes (option 7).

**Effort:** Low-medium, and almost entirely reuse. The queue table, the drain
route, `normalizeTicker`, `shouldRetry`, and `backoffSeconds` all exist and
are tested. What's new is a small `enqueueAndServeBest(ticker)` helper in
`lib/shared/` that composes `readCachedEntry` + enqueue, plus the client-side
handling of a "we're working on it" state.

**Tradeoff:** Only works where the interaction tolerates an answer arriving
after the response. It fits ticker *data* refresh well; it fits a chat
*question* badly — nobody wants their question queued. It also moves load onto
the drain worker, which currently runs on a cadence tuned for background
watchlist fill, not for user-facing latency; a JIT enqueue that waits up to a
full drain interval is worse than an 8s timeout, so this option implies either
a faster drain cadence or a drain trigger on enqueue.

**Best for:** Ticker data the user asked to see but didn't ask a *question*
about — opening a signal card for an untracked symbol, adding to a portfolio,
expanding a row. Turns "8s spinner then maybe an error" into "instant render
of what we know, quietly upgraded."

---

### 7. Streaming-first degradation for the AI paths

**What:** The AI routes (`/api/nuai`, `/api/council/deliberate`,
`/api/portfolio/health-ai`) fail in an all-or-nothing way today: the whole
OpenRouter chain is attempted, and if it's exhausted the user gets a `503`
after having waited for every model in the chain to reject. Instead, open the
stream immediately, emit a grounding/context frame from cache first, then
attempt models — so the user sees *something real* within a few hundred
milliseconds regardless of whether the LLM ever answers, and a chain
exhaustion degrades to "here's the data, no commentary" rather than nothing.

**Effort:** Medium. `consumeSSE` already exists and is shared with mobile, so
the transport is free; the work is restructuring the route handlers to emit
before they resolve, and defining a small set of non-token frame types
(`grounding`, `degraded`, `error`) the client understands. That frame contract
has to land in `lib/shared/` so mobile and web don't diverge.

**Tradeoff:** Streaming changes the error surface. A failure after the first
byte can't be an HTTP status code anymore — it has to be an in-band frame the
client renders, and any client that ignores unknown frames will silently show
a truncated answer as if it were complete. That's precisely the
"plausible-looking fabrication" the graceful-degradation constraint prohibits,
so the client work is not optional garnish here; it's the safety mechanism.

**Best for:** `/api/nuai`, the single most-used interactive AI surface, where
time-to-first-token dominates perceived quality and where a grounded-but-
uncommented answer is genuinely useful on its own.

---

### 8. Per-surface latency budgets, enforced in code

**What:** Replace the single global `FETCH_TIMEOUT_MS = 8_000` in
`signal-lookup.ts` with a caller-supplied budget, because 8s is wrong for
almost every caller: it's far too long for a chat grounding hop (which should
give up at ~1.5s and answer ungrounded rather than make the user wait) and
arguably too short for a council deliberation (where the user has already
accepted a long wait and a grounded answer is worth 15s).

**Effort:** Low. Thread an optional `timeoutMs` through `fetchTickerEntry`,
default it to the current 8s so nothing changes unless opted in, and set
per-surface constants next to the callers. The pure-function home for the
defaults is `signal-policy.ts`, alongside `cacheTtlMinutes`.

**Tradeoff:** More knobs is more surface area for them to drift out of sync
with reality. Mitigate by keeping the budgets as named constants in one place
rather than inline magic numbers, and by asserting them in the E2E layer
(below) so a regression that doubles a budget fails a test rather than quietly
degrading the feel of the app.

**Best for:** Cheap, low-risk, and it compounds with everything else here —
options 1, 4, 6, and 7 all get better when the timeout matches the surface.

---

## Making the E2E layer actually cover this

Everything above is only as trustworthy as the tests that prove it. The
existing `e2e/frontend/portfolio-liveness.spec.ts` and `signals-liveness.spec.ts`
prove the proxy layer behaves against *real* backends, which is the right
thing for detecting upstream breakage but the wrong thing for proving
degradation, because a healthy backend never exercises the fallback path.

Two complementary suites are needed:

**Liveness (exists, keep as-is).** Real backends, credential-gated, allowed to
fail loudly when gcp3 is down — that failure *is* the signal. Do not add
fallbacks or retries here; a green liveness run must mean the backend is
genuinely up.

**Degradation (the gap).** Deterministic, no credentials, backend faults
injected via Playwright route interception. These should never be flaky
because they never touch the network. The matrix worth covering:

| Injected fault | Route | Assert |
|---|---|---|
| `404` from gcp3 | `portfolio/health` | stale badge with a timestamp renders; no fabricated score |
| `503`, cache cold | `signals?symbol=X` | `cold` copy, not `broken` copy |
| Neon read throws | any cached route | `broken` copy; no crash; no silent zero |
| whole OpenRouter chain `503` | `/api/nuai` | grounding frame still rendered; degraded notice shown |
| slow backend (delay > budget) | `signals?symbol=X` | budget honored, falls back before the wall-clock limit |
| circuit open (option 2) | `portfolio/health` | no live call issued at all |

The last two are the ones that catch regressions nothing else will: a timeout
that silently doubles, or a circuit breaker that stops opening, both look
completely fine in a healthy environment and only hurt during the outage the
work was built for.

**Also worth asserting:** that the four states of option 4 are visually
distinguishable. A snapshot per state is cheap and prevents the slow collapse
back toward one generic "something went wrong" box that every degradation
system drifts into.

---

## Recommended sequencing (if forced to rank)

1. **Option 2** (liveness cron) first — cheapest, zero risk, immediately
   closes the "how would we even know" gap, and its findings will tell you
   whether options 1/3 are worth building at all (if gcp3 stays down for
   days, no client-side mitigation matters until that's fixed upstream).
   Build the status-output extension at the same time; it's the input option
   8's circuit breaking needs.
2. **Option 8** (per-surface budgets) — an afternoon, no behavior change by
   default, and it makes every later option measurably better.
3. **Option 1** for `portfolio/health` and `portfolio/suggestions` — proven
   pattern, moderate effort, directly fixes the two most session-visible
   failures.
4. **Option 4** alongside option 1 — cheap UX win once there's a cache to
   optimistically render from. Land the four-state vocabulary here; retrofitting
   it later means touching every degraded surface twice.
5. **Degradation E2E suite** — immediately after options 1 and 4, while the
   fallback paths are fresh. Written later, it tends to encode whatever the
   code happens to do rather than what it should do.
6. **Option 6** (accept-and-queue) for the non-question ticker surfaces, once
   the drain cadence question is answered.
7. **Option 5** any time — pure cleanup, no dependency on the others.
8. **Option 7** (streaming-first degradation) once the cache layer beneath it
   is reliable — a grounding frame is only worth emitting if there's something
   trustworthy to put in it.
9. **Option 3** (Modal JIT proxy) only if, after gcp3's current outages are
   resolved upstream, *latency* (not availability) remains a measured
   problem. Building it now would be optimizing a symptom (slow/absent
   responses) whose actual cause (routes returning 404) it can't fix.

## See also

- `docs/wiki-portal/entity-portfolio-intelligence.md` — the three portfolio
  panel failures this doc is scoped around
- `docs/wiki-portal/entity-signal-data-plane.md` — the existing
  cache-then-degrade JIT pattern (`signal-lookup.ts`), the queue/drain
  machinery option 6 generalizes, and the dead chat route
- `docs/wiki-portal/entity-live-price-tier.md` — the existing Modal precedent
  (`modal_finnhub_ws.py`, `modal_drain.py`) referenced in option 3
- `docs/wiki-portal/concept-live-backend-liveness-tests.md` — how the three
  failures above were confirmed live, and the liveness-cron open question
  option 2 answers
- `docs/wiki-portal/entity-playwright-e2e.md` — the existing suite the
  degradation matrix above extends
- `docs/wiki-portal/concept-cache-then-degrade.md` — the general resilience
  pattern every option here either extends or deliberately doesn't
- `docs/wiki-portal/concept-graceful-degradation.md` — the "honest-lesser,
  never plausible-fabrication" constraint that shapes options 1, 4 and 7
- `deploy/free-model-refresh/` — the multi-platform (GHA/GCP/Modal/Zo)
  scheduled-probe precedent option 2's script structure is modeled on
