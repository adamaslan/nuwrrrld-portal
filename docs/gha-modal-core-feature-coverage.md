# Running Core Features on GitHub Actions and Modal

Companion to `docs/api-failure-mitigation-build-options.md`. That doc asks how
the app degrades when a backend fails; this one asks a different question:
**which core features can run somewhere other than a user's request, and what
does that buy?**

Written 2026-08-18, immediately after the new OpenRouter resilience suite
(`__tests__/live/openrouter-resilience.live.test.ts`) surfaced two live defects
that motivate most of what follows — see "What the new tests found" below.

The framing here is deliberately unconventional. The obvious use of CI is
"run the tests"; the obvious use of Modal is "run the cron". Both are already
done in this repo (`ci.yml`, `e2e-resiliency.yml`, `modal_drain.py`,
`modal_finnhub_ws.py`). The interesting question is what *else* these two
schedulers can carry — because both are, in effect, **free compute with
credentials, a clock, and write access to the repo**, which is a more general
primitive than "CI" or "cron" suggests.

---

## What the new tests found (the motivating evidence)

Two defects, both confirmed live against the real OpenRouter API on
2026-08-18. Both were invisible to every pre-existing test.

### Finding 1 — `FREE_MODEL_CHAIN` is single-vendor: a chain of one

All four entries are `nvidia/*:free`:

```
nvidia/nemotron-3-ultra-550b-a55b:free
nvidia/nemotron-3-super-120b-a12b:free
nvidia/nemotron-3-nano-30b-a3b:free
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
```

The chain *looks* four-deep. It is one-deep against any failure that lands at
the vendor or account-tier level, which is the failure that actually happens.
Confirmed: when the account's daily free quota was hit, all four returned `429`
within ~100ms of each other. The fallback loop dutifully walked all four and
absorbed nothing.

`scripts/refresh-free-models.mjs` ranks candidates by "is it $0 and does it
probe healthy" with **no vendor-diversity constraint**, so this is not bad luck
— it is the script's ranking faithfully producing a monoculture whenever one
vendor happens to dominate the free tier. At the time of writing the live
catalog holds 18 $0-priced models: `nvidia:8, google:4, poolside:2,
dots-studio:1, cohere:1, openrouter:1, openai:1`. There is enough diversity
available; the script simply doesn't ask for it.

**Fix:** add a per-vendor cap (max 2 of N) to the refresh ranking. Cheap, and
it converts the chain from nominal to real redundancy.

### Finding 2 — three of six `SEAT_MODELS` no longer exist

Checked against the live catalog (412 models):

| Seat | Model | Catalog |
|---|---|---|
| T1 | `cohere/command-r7b-12-2024` | present |
| T2 | `qwen/qwen3-next-80b-a3b-instruct:free` | **MISSING** |
| RISK | `meta-llama/llama-3.3-70b-instruct:free` | **MISSING** |
| MACRO | `qwen/qwen3-next-80b-a3b-instruct:free` | **MISSING** |
| QUANT | `mistralai/mistral-7b-instruct:free` | **MISSING** |
| CHAIR | `qwen/qwen3-next-80b-a3b-instruct:free` | **MISSING** |

This is why the burst test logged `404` for four of five seats while the
chain-head logged `429` — two different root causes that had been reading as
one undifferentiated "AI is down."

The `404` case is worse than it looks. In `runSeat`, a `404` is **not** in the
retry set (`402 / 429 / 5xx`), so it `break`s the loop immediately — a dead
primary model means the seat **never reaches its fallback chain at all**. Five
of six seats are currently one dead id away from being unable to answer even
when the free chain is perfectly healthy.

**Two fixes, both worth doing:**
1. Treat `404`/`400` on a *primary* model as retryable-into-the-chain, since a
   retired id is exactly the case fallback exists for. (Keep it fatal for the
   chain itself, where it signals a malformed request.)
2. Extend `refresh-free-models.mjs` to validate and refresh `SEAT_MODELS`, not
   just `FREE_MODEL_CHAIN`. The weekly job has been faithfully maintaining one
   of the two model lists in the file while the other rotted.

This is the strongest possible argument for the rest of this document: **a
weekly scheduled job that only checks half the surface leaves the other half
to rot silently.**

---

## The core idea: three things schedulers are, beyond "CI" and "cron"

1. **A clock the app doesn't have.** Vercel functions exist only inside a
   request. Anything that must happen *without* a user — probing, warming,
   reconciling, expiring — has no home in the app and a natural one here.
2. **A credentialed environment the browser can't be.** GHA and Modal both
   hold secrets the client must never see. That makes them the correct place
   for work that needs a privileged key but produces a *public* artifact.
3. **A writer to the repo itself.** GHA can open PRs. That turns a scheduled
   job into a mechanism for **moving runtime uncertainty to build time** — the
   pattern `refresh-free-models.mjs` already embodies and that most of the
   ideas below generalize.

That third point is the unconventional one and worth stating plainly: *if a
fact can be discovered on a schedule and committed, the app should read it
from the repo rather than discover it per-request.*

---

## Option A — Extend the weekly refresh to everything that rots

**Status: strongly recommended. This is Finding 2's fix.**

`refresh-free-models.mjs` maintains `FREE_MODEL_CHAIN`. It should maintain
every id in `lib/openrouter.ts`, `SEAT_MODELS` included, and fail loudly rather
than quietly when a seat's primary is gone.

**Unconventional extension:** have the job commit a
`lib/generated/model-health.json` alongside the chain rewrite — per-model
latency percentiles, observed success rate, vendor, context window. Then
`runSeat` can pick a seat's model from measured evidence at build time instead
of a hand-written constant. Model selection becomes data the weekly job owns,
not a literal a human edits and forgets.

**Effort:** Low. The script already probes; it just discards the timings.

---

## Option B — GHA as the liveness/circuit-breaker producer

**Status: recommended — this is option 2 of the mitigation doc, extended.**

The scheduled probe writes `public/backend-status.json` and commits it. The
app reads it to skip calls that are known-dead, converting a guaranteed 8s
timeout into an instant labeled-stale render.

**Unconventional bit:** commit it to the repo rather than to a database. A
committed status file gets Vercel's CDN, atomic rollback, a full git history of
every outage, and zero runtime dependency — a status file in Neon needs Neon to
be up, which is one more thing that can be the outage. The tradeoff is
staleness bounded by the cron interval plus deploy time, which is fine for a
circuit breaker and wrong for anything finer-grained.

---

## Option C — Modal as the warm-path prewarmer

**Status: worth it once the gcp3 404s are fixed upstream.**

`modal_drain.py` already proves the pattern: a tiny `httpx`-only image on a
market-hours cron. The natural extension is **cache prewarming** — walk the
distinct tickers across all users' watchlists before the open and populate
`signal_cache`, so the first JIT click of the day is a cache hit rather than a
cold 8s fetch.

This is the one thing that genuinely fixes the JIT latency problem rather than
hiding it, because it converts an unpredictable per-click fetch into a
predictable batch the schedule absorbs. The mitigation doc's option 6
(accept-and-queue) and this are complements: prewarm covers the tickers you can
predict, the queue covers the ones you can't.

**Constraint worth respecting:** prewarming everything is how a free tier dies.
Scope it to tickers with at least one watchlist reference, and let
`cacheTtlMinutes()` decide what actually needs refreshing.

---

## Option D — Modal as the AI-work relocator (the biggest unconventional win)

**Status: the highest-leverage idea here, and the one most specific to this app's constraints.**

The council's cost model is "~11 calls at $0 because everything is free-tier."
Finding 1 shows what that really means: the app is one daily quota away from
having no AI at all, and that quota is consumed by *user traffic at
unpredictable times*.

Modal changes the shape of the problem. Move the expensive, non-interactive AI
work — nightly digests, portfolio health scores, backtest commentary,
grounding-pack compilation — onto a scheduled Modal job that runs **when the
free quota is fresh** (just after the UTC-midnight reset), writes results to
Neon, and lets the app serve them as ordinary cached reads.

The insight: **free-tier quota is a renewable resource with a schedule, and a
scheduler is the right tool for spending a scheduled resource.** Serving
precomputed AI from cache costs zero quota at request time, which leaves the
entire daily allowance for genuinely interactive work (Nu AI chat) that cannot
be precomputed. Today those two compete for the same bucket, and the batch work
usually wins simply by running first.

This also fixes an ordering problem nobody would otherwise notice: the observed
`429` reset is `2026-08-19T00:00:00Z`, i.e. UTC midnight — which is 8pm ET, in
the middle of the US evening. A job pinned to just after the reset gets the
freshest possible quota; user traffic during US market hours gets whatever
survives.

---

## Option E — GHA as a scheduled *auditor* that opens PRs

**Status: cheap, and it composes with everything above.**

Generalize the refresh pattern to any invariant that can be checked without a
browser, on a schedule, with the fix expressible as a diff:

- **Cross-repo drift** — the portal/mobile `lib/subscription.ts` divergence is
  already a known open item (`known-bugs.md` #12) and is exactly this shape.
- **Wiki parity** — `wiki-lint.mjs` already exists locally; running it on a
  schedule catches drift the PR-time hook misses when no PR is opened.
- **Dead-route detection** — grep for proxy routes with zero UI callers and
  file an issue. This is how `signals/{ticker}/chat` would have surfaced on its
  own rather than during a manual audit.
- **Doc/code disagreement** — assert that ids and route paths named in
  `docs/` still exist in the code.

**The unconventional framing:** treat scheduled jobs as a *second reviewer*
that reviews the repo against the world, rather than a human reviewing a diff
against the repo. PR review catches "this change is wrong." Only a scheduled
audit catches "this code was right when written and the world moved."

---

## Option F — Modal for the things Vercel structurally cannot do

Three shapes Vercel's per-request model can't host, where Modal is the natural
fit rather than a workaround:

1. **Long-lived connections.** `modal_finnhub_ws.py` already does this
   (`min_containers=1`, persistent WS).
2. **Work exceeding the function timeout** — a full backtest sweep across every
   tracked ticker.
3. **Fan-out that would trip per-invocation concurrency** — Modal's `.map()`
   over hundreds of tickers, with its own rate limiting, is a much better fit
   than N parallel serverless invocations sharing one upstream quota.

The general rule: if the work is *bounded by a resource other than the user's
patience*, it does not belong in a request.

---

## What NOT to move

Worth stating, because "run everything on a scheduler" is the failure mode this
document could cause:

- **Anything in the interactive path.** A scheduler cannot answer a question
  the user just asked. Options C and D make JIT calls *cheaper and warmer*;
  they never replace them.
- **Anything needing per-user auth at execution time.** A scheduled job has no
  user session. Precompute the shared substrate, personalize in the request.
- **Anything where staleness is a correctness bug.** Live prices are the clear
  case — a scheduled price is a wrong price.
- **Secrets into the client.** Everything here keeps privileged keys server- or
  scheduler-side and ships only derived, public-safe artifacts.

---

## Suggested order

1. **Option A** — fix `SEAT_MODELS` rot and add the vendor cap. This is
   repairing a live, confirmed break, and it is a few hours.
2. **Fix the `404`-on-primary retry gap** in `runSeat` (Finding 2). Smaller
   than option A and arguably more urgent: it's the difference between one
   dead id degrading a seat and disabling it.
3. **Option B** — the status file, since the mitigation doc's circuit breaker
   depends on it.
4. **Option E** — audits, added one at a time as drift is discovered.
5. **Option D** — the quota-scheduling relocation, once options A and B make
   the AI layer trustworthy enough to precompute from.
6. **Option C** — prewarming, after gcp3's 404s are resolved upstream; there is
   nothing to warm from a route that doesn't exist.
7. **Option F** — only when a specific piece of work actually outgrows a
   request.

## See also

- `docs/api-failure-mitigation-build-options.md` — the degradation side of the
  same problem; options B and C here are the scheduled half of its options 2/3
- `__tests__/live/openrouter-resilience.live.test.ts` — the suite that found
  both defects above
- `__tests__/openrouter-fallback.test.ts` — the deterministic twin, covering
  the failure shapes a live test can't produce on demand
- `docs/wiki-portal/entity-openrouter-client.md` — the client these findings
  concern
- `docs/wiki-portal/decision-free-tier-model-chain.md` — why the chain is
  free-tier, and the constraint Finding 1 shows it under-delivers on
- `docs/wiki-portal/concept-free-tier-resilience.md` — the broader pattern
- `deploy/free-model-refresh/` — the multi-platform precedent options A/B extend
