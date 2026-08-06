---
date: 2026-07-20
type: decision
tags: [cost, models, free-tier, fallback, openrouter]
sources: [../../lib/openrouter.ts, ../../scripts/refresh-free-models.mjs, PR#29, PR#30]
---

# Decision: Every Council Call Runs on a Free-Tier Model Chain

## Decision

All six seats — and the grounding compiler — use only OpenRouter `:free` models. Each seat has a primary model and falls through a shared `FREE_MODEL_CHAIN` on failure. A full ~11-call deliberation costs **$0** (the WS2.6 cost-control constraint).

## Date

Established with the council; chain-refresh infrastructure hardened in PR #29 / #30.

## Context

The council is a per-user feature gated behind the `nu_ai` entitlement and a daily quota. A six-seat, multi-round deliberation on paid frontier models would be expensive per invocation and scale linearly with usage. Free-tier models make the unit economics zero, at the cost of using weaker (7B–30B) models — which is precisely why [[concept-small-model-prompting]] exists.

## Alternatives considered

- **Paid frontier models (one strong model, all seats).** Rejected — per-deliberation cost and no free ceiling; the whole product framing assumes $0 marginal inference.
- **A single free model, no fallback chain.** Rejected — OpenRouter's free roster churns and rate-limits (402/429); a lone model means frequent hard failures. The chain + `runSeat`'s 402/429/5xx fallthrough absorbs this.
- **Self-hosted small models.** Rejected (implicitly) — adds infra the OpenRouter dependency avoids; the "plain fetch, zero extra deps" philosophy runs through the whole repo.

## Consequences

- Prompts must be written for the *worst* model in the chain, not the best → [[concept-small-model-prompting]].
- The free roster changes, so `scripts/refresh-free-models.mjs` refreshes `FREE_MODEL_CHAIN` on a cron (Mondays 06:17 UTC); the grounding compile runs after it (06:23) so it uses the freshest list.
- `runSeat` tries `[primary, ...FREE_MODEL_CHAIN]` with a 20 s per-model timeout — worst case ~80 s for one seat if the whole chain is failing.
- Model *quality* is the accepted risk: the entire verdict/critique/repair machinery ([[concept-verdict-repair-loop]], [[decision-four-field-verdict-scaffold]]) exists to make weak models produce reliable structured output.

## Validated by

- The chain-refresh infra shipped and passed code review (PR #30); PR #44 is that infra's first routine weekly refresh actually merging (`gemma-4-31b-it` → `nemotron-3-nano-omni-30b-a3b-reasoning`).
- ⚠️ **The $0 claim is not accurate:** T1 uses `cohere/command-r7b-12-2024`, a paid model (~$0.20–$0.50 per deliberation), chosen for structured output quality. The other five seats use `:free` models. See [[entity-openrouter-client]] "Model assignment" table.
- ❌ **Refuted, 2026-07-30:** the previously-unvalidated concurrency risk below is real. OpenRouter free tier caps the **key**, not per-model, at 50 req/day (1000/day at ≥10 credits). One key shared across the whole app means council calls, `/api/brief`, and the refresh script's own probes all draw from the same 50 — any combination can exhaust it, at which point every model 429s at once and looks identical to "the whole free roster is dead." See [[entity-openrouter-client]] "Known failures" #3.

## See also

- [[entity-openrouter-client]] — `SEAT_MODELS`, `FREE_MODEL_CHAIN`, `runSeat`
- [[concept-small-model-prompting]] — the prompting discipline this forces
- [[decision-compile-time-grounding]] — the sibling cost decision (no per-request embedding calls)
- [[entity-ai-council]] — the consumer
