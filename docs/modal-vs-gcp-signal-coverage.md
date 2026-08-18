# Modal vs. GCP: Where the Signal Engine Should Actually Live

Written 2026-08-18, in response to: *"GCP keeps breaking — I added a potential
Modal pipeline to `docs/max-coverage-simplest-path.md`; how does that look, and
what maximizes signal + AI coverage?"*

**Short answer, and it is not the one the question expects:** the Modal pipeline
sketched in `max-coverage-simplest-path.md` is well-shaped and I'd keep almost
all of it — but **it is not a fix for "GCP keeps breaking," because GCP is not
breaking.** I probed it live while writing this. It is up, fast, and correct.
What it is, is *scoped to 54 ETFs*, and the portal calls it as though it covered
every ticker. That produces a failure that is indistinguishable from an outage
at every call site, which is almost certainly what "GCP keeps breaking" is.

Choosing Modal to escape an unreliable GCP would be solving the wrong problem at
the cost of a second RSI implementation. Choosing Modal to **add the per-stock
lane GCP has never had** is correct. Same tool, opposite reasoning, and only one
of them survives contact with the evidence.

---

## Part 1 — The measurement that reframes everything

Run against `https://gcp3-backend-cif7ppahzq-uc.a.run.app` on 2026-08-18. Not
from a doc, not from memory — these are live responses.

| Probe | HTTP | Latency | Body |
|---|---:|---:|---|
| `/health` | 200 | **0.24 s** | `{"status":"ok","version":"2.1.0","tools":12}` |
| `/signals?symbol=XLK` | 200 | 0.37 s | Full payload — `ai_action: BUY`, confluence, outlook prose |
| `/signals?symbol=AAPL` | 200 | 0.65 s | **`{"error":"not found"}`** |
| `/signals?symbol=AAPL,MSFT` | 200 | — | **`{"error":"not found"}`** (no batch syntax) |
| `/signals` (all) | 200 | 1.54 s | **54 symbols**, 344 KB, `updated: 2026-08-18T00:30:53Z` |

Read the table again, because four separate conclusions fall out of it and they
point in different directions:

1. **GCP is healthy.** Sub-second, no cold start, 12 tools registered, cache
   refreshed at 00:30 UTC today. There is no availability problem to escape.
2. **The universe is 54 ETFs — all of them.** `ITA, PFM, CLOU, HACK, ESGU, XLK,
   KIE, FDN, FTXR, XPH, XRT, BOAT…` Not one individual stock. This confirms the
   `universe-scale-hydration.md` finding *from the outside*, without reading
   gcp3's source.
3. **Failure arrives as HTTP 200.** `AAPL` returns `{"error":"not found"}` with
   a **200 status code**. This is the whole bug, and §2 is about why.
4. **There is no batch parameter.** `?symbol=AAPL,MSFT` isn't parsed as a list —
   it's treated as one literal symbol named `"AAPL,MSFT"` and misses. Any
   fan-out design that assumed a comma-list has no server to talk to.

### The one-line diagnosis

> **GCP isn't down. It is answering a question nobody is asking it.**
> The portal asks "what is AAPL's signal?"; gcp3 only knows "what are these 54
> ETFs doing?" It answers `200 {"error":"not found"}`, the portal's
> `if (!res.ok) return null` never fires, and the null is attributed to an
> outage.

---

## Part 2 — Why a healthy backend reads as a broken one

This is the actual defect, and it is in **this** repo, not gcp3.

From [lib/shared/signal-lookup.ts:57-72](lib/shared/signal-lookup.ts#L57-L72):

```ts
/** Live gcp3 fetch, no cache. Returns null on any failure. */
async function fetchTickerEntryLive(ticker: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${MCP_URL}/signals?symbol=${encodeURIComponent(ticker)}`, { … });
  if (!res.ok) return null;                       // ← never fires: it's a 200
  const data = (await res.json()) as { symbols?: … };
  return data.symbols?.[ticker] ?? Object.values(data.symbols ?? {})[0] ?? null;
  //     ^ undefined            ^ Object.values(undefined ?? {}) = []  → null
}                                                  // ← the null comes from HERE
```

Three distinct real-world conditions collapse into the identical `null`:

| Actual condition | What the code returns | What an operator concludes |
|---|---|---|
| Cloud Run is genuinely down | `null` (catch) | "GCP is broken" ✅ correct |
| Request timed out at 8 s | `null` (abort) | "GCP is broken" ✅ correct |
| **Ticker is out of scope (200 + `error`)** | `null` (the `??` chain) | **"GCP is broken"** ❌ **wrong** |

The third row is the common one — every non-ETF ticker, i.e. essentially every
ticker a user actually types. So the perceived reliability of gcp3 is roughly
`54 / (54 + every stock anyone looks up)`, which rounds to "it keeps breaking."

**The health check reinforces the illusion in the other direction.**
[app/api/health/route.ts:25-32](app/api/health/route.ts#L25-L32) probes
`/health` — which returns 200 in 0.24 s — so the dashboard says GCP is `ok`
while every user-facing lookup returns nothing. The monitoring and the symptom
disagree, and *both are accurate about different things*. That gap is why this
has stayed un-diagnosed.

### The second-order damage: 13 hardcoded copies of one hostname

```
grep -rn 'gcp3-backend-cif7ppahzq-uc.a.run.app' lib app → 13 files
```

`lib/digest-cache.ts`, `lib/shared/signal-lookup.ts`, `app/api/health/route.ts`,
`app/api/holdfold/route.ts`, `app/api/brief/route.ts`, `app/api/council/sample/route.ts`,
`app/api/signals/[ticker]/chat/route.ts`, and six page components each carry
their own `process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-…"`.

Meanwhile **six other call sites deliberately have no fallback** —
`app/api/portfolio/health/route.ts`, `health-ai/route.ts`, `suggestions/route.ts`,
`app/api/pipeline/precompute-ai/route.ts`, `app/api/retention/digest-email/route.ts`,
`app/dashboard/portfolio/page.tsx` — and return `MCP_BACKEND_URL not configured`
instead.

So the codebase holds **two contradictory policies** for one dependency: half
silently pin a literal production hostname (which will keep hitting the old
service after any migration, ignoring the env var entirely), and half hard-fail
without it. That inconsistency is itself a source of "it broke again," because
changing `MCP_BACKEND_URL` fixes six call sites and does nothing for thirteen.

---

## Part 3 — Reviewing the Modal pipeline as written

Now to the actual question: how does the pipeline in
`max-coverage-simplest-path.md` look? **Structurally: very good.** Four things
in it are right and should survive any revision:

| Design choice in the doc | Verdict | Why |
|---|---|---|
| Modal posts to portal endpoints, never writes Neon directly | ✅ **Keep, non-negotiable** | Keeps validation, idempotency, and the auth boundary in one place. This is the single best call in the doc. |
| `OPENROUTER_API_KEY` stays in the portal; Modal triggers only | ✅ **Keep** | Avoids a second long-lived copy of the key. `deploy/precompute-ai/modal_app.py` already proves the httpx-only pattern. |
| Per-symbol `status: ok/error` rows, not all-or-nothing batches | ✅ **Keep** | One delisted ticker degrades to a data row, not a failed run. Directly correct given probe #3. |
| Explicit failure policy (hard-fail on secrets, per-row on symbols) | ✅ **Keep** | This is the Zo lesson from `zo-free-tier-pipeline-synthesis.md` applied properly. |

And the doc already flags the real risk itself, correctly:

> *"The biggest risk is that Modal creates a second RSI/MACD implementation
> while gcp3 already has feature modules nearby."*

That is exactly right. What the probes add is **the reason that risk is now
acceptable** — which the doc could not know without measuring.

### Four corrections the measurements force

**1. The stated motivation is wrong, and it matters.**
The doc's decision rule is *"option 3 if gcp3 can be repaired cleanly, otherwise
option 2 Modal."* That framing treats Modal as the consolation prize for a
broken GCP. GCP is not broken, so on that rule you'd pick GCP — and then
discover the work is "build a per-stock engine from scratch in a second repo,"
which was never the cheap option. **Rewrite the rule as: pick the host by
workload shape, not by perceived reliability.**

**2. Remove the batch-endpoint assumption.** Probe #4 shows `?symbol=A,B` is not
supported. Any Modal function that walks the universe *through gcp3* has no
endpoint to walk through. This isn't hypothetical cross-repo work — it's a
missing server feature confirmed from outside.

**3. Fix the quota number.** Both `deploy/precompute-ai/modal_app.py` and
`.github/workflows/precompute-ai.yml` assert in their header comments that
OpenRouter "caps the whole API key at 50 requests/day." `max-coverage-simplest-path.md`
already retracted that number as unverified — but the retraction never reached
the two files that state it as fact. Same correction, two files, still wrong.

**4. Pick one scheduler.** `precompute-ai.yml` and `modal_app.py` both fire
`10 0 * * *` at the same `/api/pipeline/precompute-ai`. The workflow comment says
"Run ONE of them, not both." Nothing enforces it. If both are live, the nightly
job double-spends quota on identical output — which is precisely the
`quotaExhausted` warning both files are written to detect. **The doc should say
which one is live.**

---

## Part 4 — The dynamic, stated plainly

The two hosts are not competing for the same job. They have never been
substitutes, and the whole confusion comes from treating them as such.

| | **GCP (gcp3 / Cloud Run)** | **Modal** |
|---|---|---|
| What it is today | A **daily-refreshed 54-ETF cache**, served from Firestore | A **credentialed clock with burst compute**, httpx-only so far |
| Real strength | Owns the vendor fallback chain (Finnhub → Alpha Vantage → yfinance), the feature modules, Firestore caching | Fan-out `.map()`, pandas images, long timeouts, scale-to-zero |
| Measured latency | 0.24–1.54 s, no cold start | Cold start ~30 s (per `universe-scale-hydration.md`) |
| Coverage | 54 symbols, `00:30 UTC` refresh | 0 — it computes nothing today |
| Fails as | **HTTP 200 + `{"error":…}`** ← the trap | Modal exception (loud, correct) |
| Right role | **Serving layer** for what it already computes well | **Compute lane** for what nobody computes at all |

**GCP's failure mode is quiet; Modal's is loud.** That is the most important row
in the table and the strongest argument for the split. A silent 200-with-error
has cost this project weeks of misattribution. A Modal function that throws
turns the same class of problem into a red run with a stack trace.

### The workload boundary

- **54 ETFs, once a day, already computed** → GCP. It does this well. Do not
  move it, do not duplicate it, do not "fix" it.
- **~4,300 stocks, per-stock indicators, nightly fan-out** → **does not exist
  anywhere.** This is new construction regardless of host.
- **Quota-timed AI batches** → either scheduler; pick one and delete the other.

The duplicate-RSI objection — genuinely serious, and the reason `universe-scale-hydration.md`
recommended building in gcp3 — **weakens once you separate the two universes.**
Two RSI implementations are dangerous when both compute AAPL and the portal
serves whichever wrote last ("the numbers flicker"). But gcp3 computes AAPL
*never*. There is no overlap to flicker. gcp3 owns ETF rows; Modal owns stock
rows; the taxonomy buckets are the shared contract. Enforce it with golden
fixtures, as the doc already proposes.

**So: Modal is the right choice — for the reason the doc didn't give.** Not
because GCP is unreliable, but because the stock lane is new work, it is
Python/pandas-shaped, it needs fan-out, and it must fail loudly.

---

## Part 5 — The solution: maximize signal and AI coverage

Coverage is currently capped at 54 symbols because **the unit of coverage is an
upstream AI narrative**. Change the unit and the cap disappears. That insight is
already in `max-coverage-simplest-path.md` and it is the right one — this
section keeps it and re-sequences the work around what the probes proved.

Three lanes, each with its own ceiling and its own cost:

| Lane | Unit | Cost/ticker | Ceiling | Host |
|---|---|---|---|---|
| **A. Truthful degradation** | one error taxonomy | $0 | all | Portal |
| **B. Token cards** | `toStateKey()` tuple | $0, no quota | ~4,300 | Modal → Portal |
| **C. Explained top-N** | 1 batched call / ~10 tickers | quota | tens | Portal, scheduler-triggered |

Lane A is new to this document and comes first, because **it is the only lane
that pays off even if B and C are never built** — and because building B on top
of a client that can't distinguish "out of scope" from "down" means the new
pipeline inherits the same blindness.

### Lane A — Make the 200-with-error visible (small, do first)

Change `fetchTickerEntryLive` to return a discriminated result rather than
`null`. The file already uses exactly this pattern one function above it —
`CacheReadResult` is `hit | miss | broken`, added precisely so a cold miss and a
broken cache stop looking alike:

```ts
type LiveFetchResult =
  | { outcome: "hit"; entry: Record<string, unknown> }
  | { outcome: "out_of_scope" }   // 200 + {"error":"not found"} — gcp3 works, ticker isn't ETF
  | { outcome: "unreachable" }    // network/timeout/5xx — gcp3 is actually down
  | { outcome: "malformed" };     // 200, unparseable shape
```

Apply the identical distinction one level up:

- `/api/health` should report **`scope: 54 ETFs`** alongside `status: ok`, so a
  green health check stops implying full-universe coverage.
- The UI should say *"AAPL isn't covered by the ETF signal engine"*, not
  *"signals unavailable."* Those are different sentences and only one is true.
- Collapse the 13 hardcoded hostnames into one exported constant, and settle the
  fallback-vs-hard-fail split deliberately. A literal production hostname
  compiled into 13 files defeats `MCP_BACKEND_URL` on any migration.

**This is the highest ratio of clarity to effort in the entire document.** It
does not add one ticker of coverage. It ends the misdiagnosis that has been
driving architecture decisions — including this one.

### Lane B — Token cards for the full universe (the coverage win)

Unchanged from `max-coverage-simplest-path.md`, and still correct:
`lib/grounding/taxonomy.ts` already discretizes floats into a fixed token
vocabulary, versioned by `TAXONOMY_VERSION`. It was built for grounding-pack
retrieval; it is *also*, with no new code, the signal-card discretizer. One
`ticker_cards` table, deterministic scoring in code, ranking as a SQL
`ORDER BY`, and the `state_key` → `grounding_pack` join gives **cited, corpus-
grounded rules for every ticker at zero model cost**.

Two additions the probes force:

- **Modal computes indicators itself** — pandas over vendor OHLCV. Not by
  walking gcp3, which has no per-stock path and no batch parameter.
- **Cards carry `universe: 'etf' | 'stock'` and `source`.** ETF rows come from
  gcp3's existing daily payload; stock rows from Modal. Same table, same
  taxonomy, provenance never ambiguous — this is what keeps two RSI
  implementations from ever contending for one row.

### Lane C — Batched AI on the top of the ranking

Also unchanged: ~10 token cards per prompt, schema-locked output, into the
existing `precomputed_ai` table under the existing `quotaExhausted` guard. Token
cards are tiny, so batching is cheap. Top 100 tickers ≈ 10 calls.

Two prerequisites, both cheap, both currently unmet:

1. **Settle the real quota** — one curl, then fix the "50/day" claim in
   `modal_app.py` and `precompute-ai.yml`:
   ```bash
   curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/auth/key
   ```
2. **Deduplicate the scheduler.** Two jobs, one endpoint, same cron. Disable one.

Worth noting the quota exposure compounds with a separate confirmed defect:
`FREE_MODEL_CHAIN` is four `nvidia/*:free` entries — a four-deep chain that is
one-deep against any vendor- or account-level failure
(`gha-modal-core-feature-coverage.md`, Finding 1). Lane C's ceiling is only as
real as that chain's diversity.

---

## Build order

Reordered from `max-coverage-simplest-path.md` — Lane A is new and moves to the
front, because everything downstream inherits its blindness otherwise.

**Status 2026-08-18:** steps 6–9 are implemented (schema, scorer, ETF seed,
Modal lane) and verified — 29 unit tests including an exhaustive 972-state
sweep, plus the upsert guard and ranking query exercised against a live Neon
branch. Steps 1–5 and 10–11 remain open.

| # | Step | Effort | Why here |
|---|---|---|---|
| 1 | `LiveFetchResult` discriminated union in `signal-lookup.ts` | **S** | Ends the misdiagnosis. Mirrors the `CacheReadResult` pattern already in the file. |
| 2 | Single `MCP_BACKEND_URL` constant; resolve fallback-vs-hard-fail | **S** | 13 hardcoded hostnames make any migration a partial one. |
| 3 | `/api/health` reports coverage scope, not just liveness | **S** | Stops a green check implying full-universe coverage. |
| 4 | `curl …/auth/key`; correct "50/day" in both precompute files | **XS** | Five seconds; sizes lane C. |
| 5 | Disable one of the two 00:10 UTC precompute jobs | **XS** | Stops double-spending quota. |
| 6 | ~~`ticker_cards` table, `universe` + `source` columns~~ | **S** | **Done** — `lib/db/schema.sql`, plus `ticker_universe`. |
| 7 | ~~Pure scorer in `lib/shared/card-policy.ts` + tests~~ | **S** | **Done** — 29 tests, no `DATABASE_URL`, same split as `signal-policy.ts`. |
| 8 | ~~ETF cards from gcp3's existing `/signals` payload~~ | **S** | **Done** — `scripts/seed-etf-cards.mjs`, dry-run verified against all 54 live rows. |
| 9 | ~~Modal `hydrate_universe_eod()` + `/api/pipeline/hydrate-universe`~~ | **L** | **Done** — `deploy/universe-hydration/modal_app.py` + route. Needs Alpaca creds + `modal deploy` to go live. |
| 10 | `state_key` → `grounding_pack` Tier-0 join | **S** | Cited rules, every ticker, zero model calls. |
| 11 | Batched top-N explain into `precomputed_ai` | **M** | Last, because it's the least of it. |

Steps 1–8 are all small, and **step 8 is the one worth calling out**: it lands
54 real ticker cards through the entire card → score → rank → ground path using
data gcp3 already serves, before a single line of Modal exists. If the card
model is wrong, that's where you find out — cheaply, against live data, with no
new infrastructure to unwind.

### Done means

- A non-ETF lookup reports *out of scope*, never *unavailable* — distinguishable
  in logs, in `/api/health`, and in the UI.
- `/api/health` states both liveness **and** covered universe.
- Exactly one scheduler owns the nightly precompute; the quota figure in both
  files matches `auth/key`.
- ETF and stock cards coexist in `ticker_cards` with unambiguous `source`, and
  no ticker is ever written by both lanes.
- A nightly run upserts cards for ≥95% of active symbols spending **zero** model
  quota; a failed symbol never downgrades a previous good card.
- The model-call ceiling stays deterministic: `ceil(N / batch_size)` + bounded
  retries, `quotaExhausted` stopping the job rather than spilling into
  interactive quota.

---

## The through-line

Every failure in this document is the same failure: **a system reporting success
while delivering nothing.**

- gcp3 returns `200` with an error body → the portal reads it as an outage.
- `/health` returns `ok` for a backend covering 1% of the tickers asked of it.
- Two schedulers "succeed" nightly while double-spending one quota.
- A four-model chain reports four-deep redundancy while being one vendor deep.
- Zo shipped green briefings built from fallback HOLDs
  (`zo-free-tier-pipeline-synthesis.md`).

Modal helps here, but not for the reason it was proposed. Its value isn't more
uptime than GCP — GCP's uptime measured fine. **Its value is that it fails
loudly**, and every problem above survived because something failed quietly.
Choose it for the stock lane, keep GCP for the ETF lane it already serves well,
and fix the client that cannot tell "not covered" from "not working."

That last one costs an afternoon and is worth more than the pipeline.

---

## See also

- `docs/max-coverage-simplest-path.md` — the token-card design this keeps; §"If option 2 wins" is the pipeline reviewed in Part 3
- `docs/universe-scale-hydration.md` — the gcp3 ETF-only finding, confirmed here from outside; vendor budgets
- `docs/gha-modal-core-feature-coverage.md` — Option D (quota-reset relocation); Findings 1–2 on chain monoculture and `SEAT_MODELS` rot
- `docs/zo-free-tier-pipeline-synthesis.md` — host-role split; the silent-degradation failure class
- [lib/shared/signal-lookup.ts:57](lib/shared/signal-lookup.ts#L57) — `fetchTickerEntryLive`, the null-collapse in Part 2
- [app/api/health/route.ts:25](app/api/health/route.ts#L25) — the liveness probe that can't see scope
- [lib/grounding/taxonomy.ts](lib/grounding/taxonomy.ts) — the discretizer lane B reuses unchanged
- `deploy/precompute-ai/modal_app.py` + `.github/workflows/precompute-ai.yml` — the duplicated 00:10 UTC job
