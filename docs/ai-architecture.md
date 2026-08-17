# The AI in NuWrrrld Portal

How the app actually uses LLMs: what calls a model, what doesn't, what grounds
the model in real data, and what happens when a model misbehaves.

The short version: **every model in the app is a free-tier 7B–120B model on
OpenRouter, and almost all of the engineering is spent compensating for that.**
Grounding, validation, disagreement detection, and verdict voting are done in
plain TypeScript and SQL — the model is used only for the parts that genuinely
need language.

---

## 1. The model layer

Single provider: **OpenRouter** (`lib/openrouter.ts`). No Anthropic/OpenAI SDK,
no embeddings service, no vector DB.

### Free-tier fallback chain

```
FREE_MODEL_CHAIN = [
  nvidia/nemotron-3-ultra-550b-a55b:free
  nvidia/nemotron-3-super-120b-a12b:free
  google/gemma-4-31b-it:free
  nvidia/nemotron-3-nano-30b-a3b:free
]
```

Refreshed weekly by `scripts/refresh-free-models.mjs` (GitHub Action), because
free model IDs on OpenRouter churn. Every call tries its primary model, then
walks the chain on **402** (free quota exhausted), **429** (rate limit), or
**5xx**. Other 4xx are fatal and propagate — retrying a 400 four times is just
four bad requests.

Three entry points, deliberately separate:

| Function | Used by | Behavior |
| --- | --- | --- |
| `runSeat()` | council routes | Non-streaming, 20s per-model timeout, returns model + latency |
| `fetchWithModelFallback()` | `/api/nuai`, `/api/brief` | Streaming, falls back on **HTTP status only** |
| `fetchWithModelFallbackChecked()` | `/api/portfolio/health-ai` | Streaming, also falls back on a **200 that streams zero tokens** |

The `Checked` variant exists because free models sometimes return HTTP 200 and
then emit an empty SSE stream, or stream only into `delta.reasoning` and never
`delta.content`. It "primes" each candidate — buffers raw bytes until the first
token or stream end — and if nothing usable arrives, cancels and moves to the
next model. A healthy model pays effectively no latency penalty, because the
buffered bytes are replayed into a reconstructed stream and the same reader
keeps pumping. It's opt-in per caller rather than a flag, since `/api/nuai` and
`/api/brief` have different latency tolerances.

---

## 2. The AI Council — the centerpiece

`POST /api/council/deliberate`. Six seats, each a separate model call with its
own system prompt (`SEAT_SYSTEM` in `lib/openrouter.ts`):

| Seat | Role | Model |
| --- | --- | --- |
| **T1** | Short-term trader, 1–60 days | `cohere/command-r7b` |
| **T2** | Long-term investor, 2mo–5yr | `qwen3-next-80b:free` |
| **RISK** | Devil's advocate — argues *against* the trade, sizes the downside | `llama-3.3-70b:free` |
| **MACRO** | Rates, dollar, liquidity, sector rotation | `qwen3-next-80b:free` |
| **QUANT** | Numbers only — score, hit-rates. No narrative, no outside knowledge | `mistral-7b:free` (smallest) |
| **CHAIR** | Reads everything, synthesizes, then issues the verdict | `qwen3-next-80b:free` |

Model assignment is intentional: the best free model goes to the one
irreducibly hard job (CHAIR synthesis), the smallest goes to jobs reduced to
pure classification (CHAIR verdict, QUANT).

### The five stages

```
1. GROUND     per-seat brief assembled from real data (no model call)
2. ROUND 1    5 debate seats answer in parallel, each on its own brief
3. ROUND 2    code computes who disagrees; only those seats get a 2nd call
4. SYNTHESIS  CHAIR prose call, then a separate verdict call run 3x
5. PERSIST    session + messages + verdict → Neon (non-fatal if down)
```

Round 1 uses `Promise.allSettled` — one seat failing never kills the
deliberation. Quota: 5 deliberations/day free, 25/day pro.

---

## 3. Grounding: how the model gets real numbers

Two layers, both zero-model-cost.

### 3a. The data brief (`lib/council-grounding.ts`)

Each seat's prompt is assembled from four independent sources, each of which
degrades to "omitted" on its own:

- **gcp3 `/signals?symbol=X`** — confluence score, per-indicator reasons, action
- **`backtest_hit_rates`** — measured historical hit-rates by category/strength
- **`council_verdicts`** — the council's own prior calls on this ticker
- **`grounding_pack`** — the compiled corpus (below)

If all four are unavailable, the brief is just the user's question and the
council runs ungrounded rather than failing.

Critically, **seats get different slices of the same pack**. RISK is fed rules
that oppose the prevailing direction; T1 and T2 are filtered by horizon. The
horizon wall and RISK's contrarian mandate are enforced at the data layer, not
left to the model to remember.

### 3b. The tier ladder (`lib/grounding/resolve.ts`)

Retrieval without embeddings. Four tiers, first hit wins:

| Tier | Method | Cost |
| --- | --- | --- |
| **0** | SQL join on `state_key` (compiled pack lookup) | ~5 ms |
| **1** | Postgres FTS over `corpus_chunks.body` | ~15 ms |
| **2** | Postgres FTS over doc2query-expanded `search_terms` | ~15 ms |
| **miss** | Honest "ungrounded" status, logged to `grounding_misses` | — |

Tier 0 works because signal state is **finite and enumerable**
(`lib/grounding/taxonomy.ts`). RSI, MACD cross, ADX, volatility, confluence,
direction, and horizon each bucket into a small enum, producing a canonical key:

```
rsi:oversold|macd:bullish_cross|adx:trending|vol:normal|confluence:strong|dir:bullish|h:t1
```

`toStateKey()` is pure — same input always yields the same key — so retrieval is
an indexed join, not a search. `TAXONOMY_VERSION` invalidates every compiled row
when bucket boundaries change.

Misses are logged rather than swallowed: the miss log *is* the backlog of what
the corpus should contain next.

Every prompt builder (`lib/shared/prompts.ts`) uses the same `=== REAL DATA ===`
framing so the model is answering *over* fetched numbers rather than improvising
from memory.

---

## 4. Small-model prompting (the prompt contract)

All prompts are written for the **worst** model in the chain, not the best —
every fallback is 7B–30B class. The contract:

- ≤5 directives per call
- Checklist, not prose
- Positive constraints only ("do X" lands; "don't do Y" doesn't)
- The critical constraint repeated **last** — recency wins in small models

### The four-field verdict scaffold

T1/T2 must emit exactly this and nothing else:

```
OUTLOOK: bullish | bearish | neutral
BECAUSE: [id] says "quote" — an evidence id from RULES and its exact quote, copied not composed
INVALIDATION: the exact price/level or condition that voids this call
EXECUTION: entry X / stop Y / target Z
```

Four fields, not six — a 7B model drops directives past the third or fourth.
`BECAUSE` folds evidence-id and quote into one **copyable** slot rather than
asking the model to compose a sentence. `EXECUTION` bundles entry/stop/target
into one line for the same reason.

This scaffold came out of a real audit (2026-07-15): the T1 card was rendering
the model's raw chain-of-thought ("The user wants a 1-5 day trade framing... I
need to extract specific numbers...") and truncating mid-sentence. Root cause
was asking for prose — there was nothing to validate against and nothing to
strip. `lib/council-verdict.ts` now strips stray `<think>` blocks and any
preamble before the first `OUTLOOK:`, then parses and validates the enum. A bad
`OUTLOOK` is a **parse failure**, not a silent fallback to "neutral".

---

## 5. Validation and the repair loop

`lib/council-validate.ts` — deterministic, pure, millisecond checks. No network,
no model.

**Numeric cross-check.** Every number in BECAUSE / INVALIDATION / EXECUTION must
appear (±1%) somewhere in the brief the seat was grounded on. Evidence ids
(`[C1]`) are stripped first so the "1" isn't read as data; thousands separators
are normalized so `18,500.00` isn't split into two numbers.

**Trade-logic sanity.** For a bullish call, `stop < entry < target`; for a
bearish call, the reverse. Unparseable or "n/a" executions are skipped, not
failed.

When a check fires, the model does **not** get "please improve" — a small model
can't locate its own mistake from that. It gets a mechanical, non-evaluative
message naming the exact line and the exact correction:

> Your previous response had specific errors. Resend all four fields, fixing only these lines:
> - EXECUTION has entry 412 / stop 430 / target 400, which isn't ordered correctly for a bullish call. Fix the order: stop < entry < target.

Applied to T1/T2 only — they're the seats with numeric fields. If the repair
still fails, the original answer is used with an `[UNVERIFIED]` marker: a flagged
answer beats no answer for that seat.

---

## 6. Round 2 — disagreement computed in code, not asked for

Asking small models to "critique the other seats" produces polite mush. So
`lib/council-critique.ts` computes disagreement mechanically **before** spending
any round-2 call:

- T1/T2 direction comes from parsing their structured `OUTLOOK`
- RISK/MACRO/QUANT get a keyword count (bullish/bearish/neutral regex hits)
- Ambiguous or tied text returns `null` and is **excluded** from the vote rather
  than guessed at

Seats matching the majority skip round 2 entirely. Only genuine, detectable
conflict gets a second model call — and that seat gets a targeted arbitration
prompt with its own prior answer replayed as the assistant turn.

---

## 7. Split synthesis and verdict

CHAIR runs **two separate calls**, never one:

1. **Synthesis** — prose only, ~180 words, explicitly "no JSON, no verdict line"
2. **Verdict** — JSON only, `max_tokens≈80`, on the smallest model in the chain

```json
{"direction":"bullish|bearish|neutral","confidence":"low|medium|high","horizon":"1-5d","invalidation":"..."}
```

Separating them means a malformed JSON line can't corrupt the synthesis, and
prose can't corrupt the verdict — no regex fishing through paragraphs for a
stray `{...}`.

The verdict call runs **3×** and is reconciled by majority-vote direction and
**minimum** confidence across samples. Any sample with an invalid or missing
field is dropped entirely rather than allowed to vote or supply metadata.

---

## 8. The other AI surfaces

| Endpoint | What it does |
| --- | --- |
| `POST /api/council` | Single-seat quick-ask (T1 or T2) for the Hold/Fold ticker panel. Same parse → validate → repair → persist path, one seat. |
| `POST /api/nuai` | Nu AI chat. Streaming. Extracts ticker tokens from the message and grounds on the user's watchlist + cached digest + live signal brief. |
| `POST /api/brief` | Daily market brief. Grounds on gcp3 `/market-overview` + top 5 Hold/Fold verdicts. |
| `POST /api/portfolio/health-ai` | Streaming narrative over the real portfolio health score and factor breakdown. Uses the `Checked` fallback. |
| `POST /api/signals/[ticker]/chat` | **Thin proxy** — no model call here. Forwards to gcp3's agent, which must call `explain_signal` before answering. |

---

## 9. Guardrails and cost control

**Nu AI refusals** (`lib/nuai.ts`) — regex-blocked before any model call:
tax evasion, insider trading, market manipulation, pump-and-dump, and requests
for exact buy/sell price targets.

**Disclaimer** — every seat prompt ends with an informational-analysis-only
disclaimer, and Nu AI appends `NU_AI_DISCLAIMER` to responses.

**Budgets:**
- Nu AI: 50,000 tokens/user/day, durable in Neon, with a 60s in-process L1 cache
  in front so a burst doesn't hammer the DB
- Nu AI: 12 requests/minute/user (in-memory fixed window — deliberately simple,
  the daily budget is the durable backstop)
- Council: 5/day free, 25/day pro
- `max_tokens` capped per seat (~130–500; verdict ~80)

**Total model spend for a full 6-seat deliberation (~11 calls): $0.** Every
model in the chain is free-tier.

---

## 10. Design principles, extracted

1. **Do it in code if code can do it.** Disagreement detection, numeric
   verification, trade-logic ordering, retrieval — none of these need a model,
   and all of them are faster and more reliable without one.
2. **Ground at the data layer, not the prompt.** Per-seat brief slicing enforces
   horizon and contrarian mandates structurally.
3. **Structure over prose.** Delimited fields can be parsed, validated, and
   repaired. Prose can only be hoped at.
4. **Repair, don't reject.** Name the line and the correct value.
5. **Degrade honestly.** Every data source falls back independently; a grounding
   miss is reported as ungrounded and logged, never faked.
6. **Fall back on emptiness, not just status.** HTTP 200 is not evidence a free
   model produced anything.

---

## Where to look

| Concern | File |
| --- | --- |
| Models, fallback chain, seat prompts | `lib/openrouter.ts` |
| Verdict format, parsing, reasoning-strip | `lib/council-verdict.ts` |
| Numeric + trade-logic validation, repair | `lib/council-validate.ts` |
| Disagreement computation | `lib/council-critique.ts` |
| Data brief assembly, per-seat slicing | `lib/council-grounding.ts` |
| Tier ladder retrieval | `lib/grounding/resolve.ts` |
| State-key taxonomy | `lib/grounding/taxonomy.ts` |
| Shared prompt builders | `lib/shared/prompts.ts` |
| Nu AI guardrails, budget | `lib/nuai.ts` |
| Orchestration | `app/api/council/deliberate/route.ts` |

Deeper background lives in `docs/wiki-portal/`: `entity-ai-council.md`,
`entity-openrouter-client.md`, `entity-grounding-tier-ladder.md`,
`concept-small-model-prompting.md`, `concept-verdict-repair-loop.md`,
`decision-split-chair-synthesis-and-verdict.md`,
`decision-four-field-verdict-scaffold.md`, `decision-free-tier-model-chain.md`.
