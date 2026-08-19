---
date: 2026-07-20
type: entity
tags: [openrouter, llm, models, seats, fallback, free-tier]
sources: [../../lib/openrouter.ts, ../../scripts/refresh-free-models.mjs, ../../__tests__/openrouter-fallback.test.ts, ../../__tests__/live/openrouter-resilience.live.test.ts, PR#29, PR#30, PR#37]
---

# Entity: OpenRouter Client (`lib/openrouter.ts`)

The single module that talks to OpenRouter. Owns the seat definitions, the seat→model map, the free-tier fallback chain, and `runSeat()` — the primitive every council call goes through.

## What it is

- **`CouncilSeat`** — `'T1' | 'T2' | 'RISK' | 'MACRO' | 'QUANT' | 'CHAIR'`.
- **`DEBATE_SEATS`** — the five that answer in round 1 (`T1, T2, RISK, MACRO, QUANT`); CHAIR only synthesizes.
- **`SEAT_SYSTEM`** — one system prompt per seat, all written to the [[concept-small-model-prompting]] contract.
- **`SEAT_MODELS`** — each seat's primary model (free-tier except T1 — see "Model assignment" below).
- **`FREE_MODEL_CHAIN`** — the ordered fallback list every seat drops through on failure.
- **`SMALLEST_MODEL`** — `= SEAT_MODELS.QUANT`, reused for the 3× CHAIR verdict vote.
- **`CHAIR_VERDICT_SYSTEM`** — the tiny JSON-only prompt for the separate verdict call ([[decision-split-chair-synthesis-and-verdict]]).

## Model assignment

`SEAT_MODELS` spends the best free model on the one irreducibly hard job and the smallest on tasks reduced to pure classification ([[concept-small-model-prompting]] §10):

| Seat | Primary model | Rationale |
|---|---|---|
| T1 | `cohere/command-r7b-12-2024` | structured 4-field output |
| T2 | `qwen/qwen3-next-80b…:free` | secular thesis reasoning |
| RISK | `meta-llama/llama-3.3-70b…:free` | adversarial framing |
| MACRO | `qwen/qwen3-next-80b…:free` | rotation/rates narrative |
| QUANT | `mistralai/mistral-7b…:free` | numbers-only → smallest model |
| CHAIR | `qwen/qwen3-next-80b…:free` | synthesis (hardest job) |

The CHAIR *verdict* call (not synthesis) uses `SMALLEST_MODEL`, because a verdict reduced to a single JSON line is classification, not reasoning.

## `runSeat` — the fallback primitive

`runSeat(seat, messages, apiKey, maxTokens, temperature, modelOverride?)` builds `[primaryModel, ...FREE_MODEL_CHAIN]` (deduped) and tries each in order, falling through on **402 / 429 / 5xx** with a **20 s per-model timeout**. Five of six seats use `:free` models; T1 (`cohere/command-r7b-12-2024`) is a paid model chosen for structured output quality. A full ~11-call deliberation costs **~$0.20–$0.50** (primarily from T1), not quite meeting the WS2.6 $0 intent but balancing output reliability. See [[decision-free-tier-model-chain]] "Consequences" for cost implications.

## Where used

- [[entity-ai-council]] — both `/api/council` and `/api/council/deliberate` route every model call through `callCouncilSeat` / `runSeat`
- [[entity-grounding-compiler]] — the compile script uses the same free-tier philosophy (`COMPILE_MODEL` defaults to a `:free` model) but its own fetch, not this client

## Known failures

1. **Whole chain exhausted.** If every model in `[primary, ...FREE_MODEL_CHAIN]` fails, `runSeat` throws. `deliberate` isolates this per-seat via `Promise.allSettled`; a failed CHAIR synthesis, however, returns a route-level 503.
2. **Free models rotate / disappear.** OpenRouter's free roster churns. `scripts/refresh-free-models.mjs` (cron, Mondays 06:17 UTC) refreshes `FREE_MODEL_CHAIN`; the grounding compile runs at 06:23, after it, deliberately. PR #44 (2026-07-27) swapped `google/gemma-4-31b-it:free` for `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — routine churn, not an incident.
3. **Account-wide daily quota, not per-model.** OpenRouter's free tier caps the whole API key at **50 requests/day** (not per-model) unless ≥10 credits are added, which raises it to 1000/day. When exhausted, *every* model in `[primary, ...FREE_MODEL_CHAIN]` 429s simultaneously — `refresh-free-models.mjs`'s live probe (and any caller) sees "0 working models" and can't tell that apart from an actual dead roster. Observed 2026-07-30: the refresh script's own probe run burned into this ceiling. `X-RateLimit-Reset` on the 429 response headers gives the exact reset timestamp (UTC midnight, key-specific). See [[decision-free-tier-model-chain]] "Validated by" — this is the concurrency risk that section flagged as unvalidated.
4. **Chain-of-thought leak.** Reasoning-style free models emit `<think>` blocks. This client doesn't strip them — [[entity-ai-council]]'s `stripReasoning` does, downstream.
5. **`SEAT_MODELS` has rotted — 5 of 6 primaries no longer exist (confirmed 2026-08-18; fallback FIXED, ids still stale).** Checked against the live 412-model catalog: only T1's `cohere/command-r7b-12-2024` is still present. T2/MACRO/CHAIR's `qwen/qwen3-next-80b-a3b-instruct:free`, RISK's `meta-llama/llama-3.3-70b-instruct:free`, and QUANT's `mistralai/mistral-7b-instruct:free` are all gone. The consequence is worse than a slow seat: a retired id returns **404**, which is *not* in `runSeat`'s retry set (`402/429/5xx`), so it `break`s the loop — **a dead primary means the seat never reaches its fallback chain at all**. `refresh-free-models.mjs` has been faithfully maintaining `FREE_MODEL_CHAIN` while the other model list in the same file rotted untouched, because the script only knows about the chain. Two fixes were identified; **the first is now done** (2026-08-18): `runSeat` gained `isRetryableStatus(status, isPrimary)`, which makes 404/400 retryable *only in the primary position* — a retired seat model now falls through to the chain (with a loud `console.warn` naming `SEAT_MODELS`, since the seat still answers and the rot is otherwise invisible), while the same status inside the chain stays fatal, because those ids are refreshed weekly against the live catalog so a 404 there means a malformed request that will fail identically on every remaining model. Live-verified: QUANT's retired `mistralai/mistral-7b-instruct:free` now warns and advances instead of disabling the seat. **Still outstanding:** the stale ids themselves, and extending `refresh-free-models.mjs` to validate `SEAT_MODELS` rather than only `FREE_MODEL_CHAIN`.
6. **`FREE_MODEL_CHAIN` is single-vendor — nominal depth 4, real depth 1 (confirmed 2026-08-18).** All four entries are `nvidia/*:free`, so the chain has no independence against any failure landing at the vendor or account-tier level — which is the failure that actually happens (failure #3). Observed: on daily-quota exhaustion all four returned 429 within ~100 ms of each other and the fallback loop absorbed nothing. This is not bad luck: `refresh-free-models.mjs` ranks purely on "$0 and probes healthy" with **no vendor-diversity constraint**, so it reproduces whatever monoculture dominates the free tier that week. The catalog held 18 $0 models at the time (`nvidia:8, google:4, poolside:2, cohere:1, openai:1, …`) — diversity was available and simply not requested. Fix: a per-vendor cap (max 2 of N) in the refresh ranking.

7. **A non-ASCII `X-Title` silently disabled the whole fallback chain (found and fixed 2026-08-19, PR #72).** One caller passed `"NuWrrrld Precompute — Portfolio Health"`. HTTP header values are ByteStrings, so the em-dash (U+2014) made `fetch()` throw a **TypeError before the request was ever sent** — not a network error, a construction error. Inside `fetchWithModelFallbackChecked`'s loop that lands in the `catch` that treats a throw as an unreachable model and `continue`s, so *every* model in the chain "failed" without ever recording a status, and the chain ended by reporting its **initial** `lastStatus = 503`.

   Two consequences, both worse than the missing request: the real upstream state (OpenRouter was answering **429** — daily quota exhausted, failure #3) was completely invisible, and `precompute-ai`'s `isQuotaExhausted()` matches on `/OpenRouter 429/`, so the early-stop never fired and the run kept spending subjects against an allowance that was already gone. A quota guard defeated by a typographic character in a log label.

   Fixed at both levels: the offending title is ASCII, and `toHeaderSafe()` now sanitizes every `X-Title` (em/en dashes → `-`, other non-Latin-1 → `?`) so no future caller can reintroduce it. Only this one caller was affected — `/api/brief`, `/api/portfolio/health-ai` and `/api/nuai` all pass ASCII titles. Verified end-to-end: the same request now reports `OpenRouter 429`, `quotaExhausted: true`, and stops after 1 subject instead of attempting 3.

   Worth generalizing: this is the third failure on this page whose *symptom* pointed at the wrong layer (cf. #5's 404-vs-fallback and #3's "0 working models"). The chain's habit of collapsing distinct causes into one terminal status is the recurring hazard, not any single bug.

## Open questions

- ❓ `SEAT_MODELS` primary assignments predate the §10 residual-difficulty analysis. Should T1/T2/MACRO be re-tuned once Layer-B flag-rate telemetry exists? (mirrors an open question on [[entity-ai-council]])
- ❓ The 20 s per-model timeout × 4 models = up to 80 s worst-case per seat. Is that within the route's own timeout budget under a full chain-failure cascade?
- ✅ Resolved 2026-08-18: a 404 on a *primary* seat model now falls through to the chain; within the chain it stays fatal. The status alone cannot distinguish "retired id" from "malformed request" — position can, and that is what `isRetryableStatus(status, isPrimary)` encodes.
- ❓ Should `SEAT_MODELS` be a hand-written constant at all, or generated data the weekly job owns (measured latency/success per model)? Failure #5 is what happens when a human-edited literal has no scheduled maintainer.

## See also

- [[entity-ai-council]] — the primary consumer
- [[concept-small-model-prompting]] — the contract every `SEAT_SYSTEM` prompt follows
- [[decision-free-tier-model-chain]] — why everything is `:free`
- [[decision-split-chair-synthesis-and-verdict]] — why CHAIR calls twice with two different prompts
- [[concept-free-tier-resilience]] — the pattern failures #3, #5 and #6 all stress
- `../gha-modal-core-feature-coverage.md` — the scheduled-maintenance argument failures #5 and #6 motivate
- `../../__tests__/live/openrouter-resilience.live.test.ts` — the suite that found #5 and #6
