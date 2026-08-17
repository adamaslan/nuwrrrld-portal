# Test Suite for AI in Production

How this repo tests a product whose core output comes from non-deterministic,
free-tier LLMs. Written against the code as of 2026-07-27.

Two suites, different jobs:

| Suite | Command | Network | Baseline |
|---|---|---|---|
| Fast (unit + components) | `npm test` | none | 132 passed, 4 skipped, **610 ms** |
| **Live AI** | `npm run test:live` | **real model calls** | 25 tests, ~100 s |

The fast suite proves our code is internally consistent. **The live suite is the
only thing that proves the product actually works.** On its first run it found
three production defects the stubbed suite could never surface (§11).

---

## 1. The governing idea

You cannot assert on model output. You *can* assert on everything around it —
and you can assert that a real model still satisfies the contracts your code
depends on.

| Layer | Deterministic? | Fast suite | Live suite |
|---|---|---|---|
| Prompt construction | yes | assert built string | — |
| Transport / model fallback | with a fake `fetch` | assert chain traversal | **models still exist & serve us** |
| Parse of model output | given a fixture | fixtures incl. real bad output | **today's model still honours the format** |
| Validation of parsed output | yes | property + boundary tests | **runs clean over live output** |
| Repair loop | yes | assert the re-prompt text | **flag count stays convergent** |
| Streaming | with a fake stream | frame-boundary cases | **real SSE actually carries tokens** |
| Persistence / quota | yes | real DB integration test | — |
| Completion *quality* | **no** | not asserted | not asserted — bounded, not graded |

**The live-test rule:** assert invariants that must hold for *any* competent
completion — it is non-empty, it parses, its numbers are grounded, it arrived
within budget. Never assert specific wording. If a test would fail because a
model phrased something differently, it is the wrong test.

Every regression test in this repo names its origin (an audit finding, a PR
review, an incident). Keep that convention.

---

## 2. Layout

```
__tests__/                      # project "unit" — node, no network, ~0.6 s
  council-verdict.test.ts       # parse the 4-field scaffold
  council-validate.test.ts      # numeric cross-check + trade-logic sanity
  council-critique.test.ts      # direction extraction, disagreement math
  grounding-taxonomy.test.ts    # state-key bucketing (RSI/ADX/vol)
  digest-adapt.test.ts          # untrusted upstream → typed DigestPayload
  signal-card.test.ts           # share/image URL construction
  live-price.test.ts            # price row parsing
  public-demo.test.ts           # IP hashing + abuse quota
  signal-queue.test.ts          # retry/backoff policy
  signal-queue.integration.test.ts   # real Neon (skips without DATABASE_URL)
  sse.test.ts                   # streaming frame handling

__tests__/live/                 # project "live" — REAL model calls
  _harness.ts                   # key gate, fixtures, SSE drain, model probe
  model-chain.live.test.ts      # chain reachability, per-seat resolution
  council-verdict.live.test.ts  # format contract, CHAIR JSON, prose classifiability
  streaming.live.test.ts        # brief / nuai / health-ai stream paths

components/**/*.test.tsx        # project "components" — jsdom
test/setup.ts                   # jsdom shims
test/live-setup.ts              # loads .env.local, warns loudly if no key
```

`vitest.config.ts` defines three projects. The `unit` project **excludes**
`__tests__/live/**`, and `npm test` names `unit` and `components` explicitly —
so no ordinary test run can ever spend model quota by accident.

---

## 3. Coverage: every AI feature, and how each is tested live

There are eight AI surfaces in the product. All eight are now exercised against
real models.

| # | Surface | Entry point | Model path | Live test |
|---|---|---|---|---|
| 1 | Hold/Fold quick-ask (T1/T2) | `/api/council` | `callCouncilSeat` | format contract, `directionFromOutlook` |
| 2 | 6-seat deliberation | `/api/council/deliberate` | `runSeat` ×11 | per-seat answer, prose classifiability |
| 3 | CHAIR verdict | `/api/council/deliberate` | `runSeat` + `CHAIR_VERDICT_SYSTEM` | raw `JSON.parse` of real output |
| 4 | Public demo council | `/api/council/public` | `callCouncilSeat` | seat reachability (shares T1 path) |
| 5 | Sample council | `/api/council/sample` | `callCouncilSeat` ×2 | seat reachability |
| 6 | Signal brief | `/api/brief` | `fetchWithModelFallback` (SSE) | non-empty stream, ticker grounding |
| 7 | Nu AI chat | `/api/nuai` | `fetchWithModelFallback` (SSE) | non-empty stream, portfolio grounding |
| 8 | Portfolio health AI | `/api/portfolio/health-ai` | `fetchWithModelFallbackChecked` (SSE) | non-empty guarantee, stream replay integrity |

Surface 9, `/api/signals/[ticker]/chat`, is a **proxy** to the gcp3 backend
agent — no model call originates here. It is covered by transport tests
(401/400/503/504 mapping), not by live model tests. Testing it live means
testing someone else's service; do that in gcp3's suite.

### What each live file asserts

**`model-chain.live.test.ts`** — the layer stubs cannot replace. A `fetch` stub
proves the fallback logic is self-consistent; only a real call proves the models
still exist, still serve this account, and still qualify as free tier. Those
facts rot on their own: a provider can retire a `:free` endpoint overnight with
no code change on our side.

- every `FREE_MODEL_CHAIN` entry probed; at least one must answer
- **more than one** must answer — a one-model chain is not a chain, and this is
  the early warning that the weekly refresh has fallen behind provider churn
- every chain id ends in `:free` (a paid id slipping in is a silent bill)
- **every seat** (`T1 T2 RISK MACRO QUANT CHAIR`) returns a non-empty answer
- an invalid key rejects fast instead of walking the chain — so a bad key in
  prod presents as an error, not as latency

**`council-verdict.live.test.ts`** — the prompt→completion→parse→validate
pipeline end to end. The stubbed parser tests feed it strings *we* wrote, which
proves it handles failures we already know about. It cannot prove today's models
still honour `STRUCTURED_VERDICT_INSTRUCTIONS` — the single assumption every
rendered verdict rests on, and one that has broken before (2026-07-15 audit).

- real T1/T2 output parses into all four fields
- no chain-of-thought leaks into rendered values (live risk, not historical: the
  nemotron models in the current chain emit "The user asks…" preamble by default)
- `validateStructuredVerdict` flag count over live output stays **< 5**, so the
  single repair retry can actually converge. Not asserted as zero — hallucinated
  numbers are what the repair loop exists to absorb, and a zero-assert would be
  flaky by design.
- CHAIR verdict is parseable by bare `JSON.parse` with the four promised keys
- RISK/MACRO/QUANT prose still yields a direction via `extractDirection`, so
  `computeDisagreements` doesn't silently degrade to "no majority"

**`streaming.live.test.ts`** — all three streaming surfaces share a failure mode
that is not "wrong answer" but "no answer": an HTTP 200 whose stream carries zero
content tokens, which the user experiences as a spinner that never resolves.
BUG-4 (tokens only in `delta.reasoning`) and BUG-5 (empty completions passing the
status check) were both this shape, and neither is observable without a real
stream.

- each path streams >40 chars of real content
- brief mentions the ticker it was handed; nuai mentions the holdings it was given
- `fetchWithModelFallbackChecked` honours its non-empty contract
- **stream replay integrity**: the Checked variant buffers bytes while probing
  for the first token, then replays them ahead of the untouched reader. An
  off-by-one shows as a truncated or doubled opening sentence. The test asks for
  `1..12` at `temperature: 0` and checks the sequence arrives once. It does —
  verified output `1 2 3 4 5 6 7 8 9 10 11 12`.

---

## 4. Running the live suite

```bash
npm run test:live      # real model calls, ~100 s
npm test               # fast suite only — never touches the network
npm run test:all       # everything including live
```

`test/live-setup.ts` loads `.env.local` into `process.env` (vitest, unlike
`node --env-file`, does not) and **never fabricates a key**. With no
`OPENROUTER_API_KEY` the whole live suite skips and prints:

```
[live] OPENROUTER_API_KEY not set — every live AI test will SKIP.
[live] A green run in this state proves nothing about the models.
```

That warning is deliberate. A silently-skipping live suite is worse than no live
suite, because it reports green.

Config choices that matter (`vitest.config.ts`, project `live`):

- `fileParallelism: false` — free-tier providers rate-limit on concurrency;
  serial execution keeps 429s down to the ones the fallback chain is *meant* to
  absorb rather than manufacturing our own
- `testTimeout: 120_000` — model latency is not test latency
- `retry: 1` — absorbs single transient 429s without hiding persistent failures

---

## 5. Living with flaky-by-nature tests

Live AI tests fail for two very different reasons, and **triage must separate
them before anyone touches code**:

| Class | Signature | Response |
|---|---|---|
| **Structural** | same status every time; reproducible from a bare `curl`/probe | real bug, fix it |
| **Quota** | passes cold, fails on a second run within minutes; 429s | not a bug; back off and re-run |

We hit both on the first run, and the difference was stark: a second full run
minutes later went from 12 failures to 19 purely from exhausted free-tier quota,
while the 404s stayed identical. **Always confirm a live failure with an
independent probe before filing it.** The `probeModel` helper in `_harness.ts`
exists for exactly this.

Practical rules:

- Never gate a deploy on the live suite alone — gate on the fast suite, run live
  on a schedule and on changes to `lib/openrouter.ts` or any prompt.
- Treat a live failure as a page only when it reproduces cold.
- Keep `max_tokens` small in live tests (16–400). The suite runs on the same
  free quota the product does; a wasteful test suite is a self-inflicted outage.

---

## 6. Prompt contract tests

**What breaks in production:** someone edits a seat prompt in `lib/openrouter.ts`,
the output format changes, the parser stops matching, every verdict renders as an
error.

`STRUCTURED_VERDICT_INSTRUCTIONS` (the prompt) and `parseStructuredVerdict` (the
parser) describe the same four fields — `OUTLOOK / BECAUSE / INVALIDATION /
EXECUTION` — and live in the same file for that reason. The live suite now checks
the *model* honours it; a fast-suite test should also check the *prompt still
asks* for it:

```ts
it("the prompt still names every field the parser requires", () => {
  for (const label of ["OUTLOOK", "BECAUSE", "INVALIDATION", "EXECUTION"]) {
    expect(STRUCTURED_VERDICT_INSTRUCTIONS).toContain(`${label}:`);
  }
});
```

Still untested in the fast suite: `lib/shared/prompts.ts` (`buildSignalPrompt`,
`buildCouncilPrompt`) — pure string builders over typed input, the cheapest
possible tests, and the ones that catch "we stopped putting the ticker in the
prompt." The live suite uses both, so a break shows up there first — but slowly
and expensively, which is the wrong place to catch it.

---

## 7. Transport tests in the fast suite

The live suite proves the chain works *today*. Stubbed tests prove the chain
*logic* is right regardless of provider state, and they run in milliseconds.
`lib/openrouter.ts` still has none. Stub `globalThis.fetch` and assert the
sequence of `model` fields:

| Case | Expected |
|---|---|
| first → 402, second → 200 | second returned, `model` = second |
| all → 429 | throws `OpenRouter 429: all models in chain failed` |
| first → 400 | throws immediately, chain not exhausted |
| **first → 404** | **see §11 — current behaviour is wrong** |
| caller aborts mid-chain | `AbortError` propagates, not swallowed |
| 200 but stream is only `[DONE]` | falls through; error says "empty completions" |
| 200 with tokens only in `delta.reasoning` | treated as content (BUG-4) |

`scanSSEChunk` is module-private but pure. Export it and drive table-driven tests
(split frames, malformed JSON lines, `[DONE]` mid-buffer) — the partial-line
`remaining` logic is where SSE bugs live.

---

## 8. Output parsing against real bad output

The rule: **every parser fixture should be something a model actually emitted.**
Invented "malformed" strings test your imagination; captured ones test production.

`council-verdict.test.ts` carries the 2026-07-15 audit finding verbatim — a model
emitting `"The user wants a 1-5 day trade framing... I need to extract specific
numbers..."` before the first label. That test exists because the T1 card shipped
chain-of-thought to users.

The live suite is now the **feeder** for these fixtures: when a live test fails on
malformed output, capture the raw string into the fast suite before fixing it.
That converts a slow, expensive, flaky test into a fast deterministic one, and is
the intended lifecycle.

`digest-adapt.test.ts` is the model for hostile-input parsing: 20 tests over
`adaptLiveSignals` treating upstream as entirely untrusted. Apply that standard to
anything crossing the model boundary.

---

## 9. Validation and the repair loop

`lib/council-validate.ts` catches a model inventing a price and turns it into a
mechanical re-prompt. `council-validate.test.ts` covers both validators well,
including two named regressions (`[C1]` ids not counted as data; comma
thousands-separators not split — PR #37).

- **Test the repair message, not the repair.** `buildRepairMessage` output is
  deterministic; whether the model then fixes it is not. Assert the message names
  the field and the correct value, and never contains evaluative language
  ("please improve") — the design premise is that a small model executes a named
  fix but cannot self-diagnose.
- **Boundaries are the tests.** `NUMERIC_TOLERANCE = 0.01` — test at exactly ±1 %,
  just inside, just outside. `grounding-taxonomy.test.ts` does this correctly for
  RSI 30/70, ADX 25, volatility 33/67, all inclusive.
- **Loop termination is untested and should not be.** Assert the caller retries at
  most once and renders a fallback state. An unbounded repair loop against a free
  tier is a cost incident.

---

## 10. Cost, quota, and abuse

Free-tier economics are a correctness property here, not an ops concern.

Covered: `public-demo.test.ts` (`hashIp` is keyed HMAC-SHA256, proven by asserting
different secrets yield different digests; `clientIpFromHeaders` trusts
`x-real-ip` and **ignores** client-supplied `x-forwarded-for`, which would let a
caller rotate IPs past the quota — a security test wearing a quota test's
clothes) and `signal-queue.test.ts` (`shouldRetry`, `backoffSeconds`,
`isCacheFresh`).

Untested constants that gate spend:

- `NU_AI_DAILY_TOKEN_BUDGET = 50_000` (`lib/nuai.ts`) — assert enforcement, and
  that `isRefusedQuery` blocks what it claims to
- `CACHE_TTL_MINUTES = 15`, `MAX_ATTEMPTS = 3` (`lib/shared/signal-policy.ts`) —
  the cache is the cost control; a cache-key regression is a bill
- Deliberation issues ~11 model calls. Count stubbed `fetch` invocations to pin
  that number, so a refactor that double-runs a seat fails CI instead of
  appearing on an invoice.

---

## 11. Findings from the first live run

All three reproduce from a bare probe, independent of the test suite.

### F1 — 5 of 6 council seats are dead in production *(critical)*

Four of six `SEAT_MODELS` primaries no longer serve this account:

```
404  qwen/qwen3-next-80b-a3b-instruct:free    "unavailable for free"   → T2, MACRO, CHAIR
404  meta-llama/llama-3.3-70b-instruct:free   "unavailable for free"   → RISK
404  mistralai/mistral-7b-instruct:free       "no endpoints found"     → QUANT
402  cohere/command-r7b-12-2024               "insufficient credits"   → T1
```

A 402 is survivable — `runSeat` retries on 402/429/5xx, so **T1 falls through to
the chain and works**. A 404 is not: it is a 4xx outside the retry set, so this
line breaks out of the loop before trying a single fallback model —

```ts
if (res.status !== 402 && res.status !== 429 && res.status < 500) break;
```

Result, confirmed by replaying `runSeat`'s exact logic against the live API:

```
✅ T1    served by nemotron-3-ultra (after cohere 402 → fell through)
❌ T2    FAILS 404 — chain never tried
❌ RISK  FAILS 404 — chain never tried
❌ MACRO FAILS 404 — chain never tried
❌ QUANT FAILS 404 — chain never tried
❌ CHAIR FAILS 404 — chain never tried
```

Deliberation needs all six seats plus CHAIR synthesis and verdict. **It cannot
currently complete.** Two independent defects:

1. `SEAT_MODELS` is stale — `scripts/refresh-free-models.mjs` refreshes
   `FREE_MODEL_CHAIN` but evidently not the seat primaries.
2. `runSeat` treats 404 as fatal. A 404 means *this model* is gone, which is
   precisely when falling back is correct. 404 belongs in the retry set;
   401/403 (auth) rightly do not.

### F2 — `FREE_MODEL_CHAIN` has thinner margin than it looks

Of four entries, three answer and `google/gemma-4-31b-it:free` returns 429
persistently. More importantly, `nvidia/nemotron-3-ultra-550b-a55b:free` returned
**HTTP 200 carrying `Upstream error from Nvidia: ResourceExhausted`** — a
successful status wrapping a failed generation, observed producing a **0-char
stream** on the `/api/brief` path.

`/api/brief` and `/api/nuai` use `fetchWithModelFallback`, which checks HTTP
status only. `fetchWithModelFallbackChecked` — which catches exactly this — is
wired to `/api/portfolio/health-ai` only. **BUG-5 is still live on two of the
three streaming surfaces.**

### F3 — reasoning models can exhaust `/api/brief`'s token budget

`/api/brief` caps `max_tokens: 350`. The nemotron models spend part of that
budget on reasoning tokens, and one live run produced a brief that never named
the ticker it was given — the visible answer was crowded out. The `health-ai`
route already carries a comment acknowledging this for its own 1024 budget; the
brief route does not. This is the one live failure that is arguably a tuning
question rather than a defect, and it is left failing on purpose so the tradeoff
stays visible.

---

## 12. What is deliberately not tested

- **Completion quality.** No test asserts a verdict is *good*. Quality is handled
  by the prompt contract, the validators, and production observability — `runSeat`
  records `model` and `latencyMs` per seat, and `fetchWithModelFallbackChecked`
  logs `sawContent / parsedLines / emptyLines / sawDone` per attempt. Those logs
  are the eval harness.
- **Which model serves a seat.** `SEAT_MODELS` and `FREE_MODEL_CHAIN` churn
  weekly. Live tests assert chain *behaviour* — "some model answers", "more than
  one answers", "every id is `:free`" — never chain *contents*. Pinning ids would
  make a routine refresh look like a regression. (F1 is not a counterexample: the
  test that caught it asserts *a seat can answer*, not *which model answered*.)
- **The gcp3 backend agent** behind `/api/signals/[ticker]/chat`. Test the proxy's
  status mapping here; test the agent in gcp3.

---

## 13. Priority gaps

1. **Fix F1** — 404 in the `runSeat` retry set, and refresh `SEAT_MODELS`.
   Deliberation is down until both land.
2. **Fix F2** — move `/api/brief` and `/api/nuai` onto
   `fetchWithModelFallbackChecked`, or fold the empty-completion check into the
   base function.
3. **Stubbed transport tests** for `lib/openrouter.ts` (§7) — including a 404 case
   that would have caught F1 in milliseconds instead of 100 seconds.
4. **`scanSSEChunk` frame-boundary tests** (§7) — pure, cheap, guards BUG-4/5.
5. **Prompt↔parser coupling assertion** (§6) — three lines.
6. **`lib/shared/prompts.ts`** (§6) — pure builders, no tests.
7. **Call-count / budget tests** (§10) — turns a cost regression into a CI failure.
8. **`lib/council-grounding.ts` / `lib/grounding/resolve.ts`** — 479 lines deciding
   what evidence reaches the model; only taxonomy bucketing is tested.
