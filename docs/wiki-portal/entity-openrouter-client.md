---
date: 2026-07-20
type: entity
tags: [openrouter, llm, models, seats, fallback, free-tier]
sources: [../../lib/openrouter.ts, ../../scripts/refresh-free-models.mjs, PR#29, PR#30, PR#37]
---

# Entity: OpenRouter Client (`lib/openrouter.ts`)

The single module that talks to OpenRouter. Owns the seat definitions, the seat→model map, the free-tier fallback chain, and `runSeat()` — the primitive every council call goes through.

## What it is

- **`CouncilSeat`** — `'T1' | 'T2' | 'RISK' | 'MACRO' | 'QUANT' | 'CHAIR'`.
- **`DEBATE_SEATS`** — the five that answer in round 1 (`T1, T2, RISK, MACRO, QUANT`); CHAIR only synthesizes.
- **`SEAT_SYSTEM`** — one system prompt per seat, all written to the [[concept-small-model-prompting]] contract.
- **`SEAT_MODELS`** — each seat's primary model (all free-tier).
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

## Open questions

- ❓ `SEAT_MODELS` primary assignments predate the §10 residual-difficulty analysis. Should T1/T2/MACRO be re-tuned once Layer-B flag-rate telemetry exists? (mirrors an open question on [[entity-ai-council]])
- ❓ The 20 s per-model timeout × 4 models = up to 80 s worst-case per seat. Is that within the route's own timeout budget under a full chain-failure cascade?

## See also

- [[entity-ai-council]] — the primary consumer
- [[concept-small-model-prompting]] — the contract every `SEAT_SYSTEM` prompt follows
- [[decision-free-tier-model-chain]] — why everything is `:free`
- [[decision-split-chair-synthesis-and-verdict]] — why CHAIR calls twice with two different prompts
