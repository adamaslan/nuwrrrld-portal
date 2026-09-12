---
date: 2026-09-11
type: decision
tags: [cost, models, free-tier, fallback, openrouter]
sources: [../../lib/openrouter.ts, ../../scripts/refresh-free-models.mjs, PR#29, PR#30, PR#115]
---

# Decision: Every Council Call Runs on a Free-Tier Model Chain

## Decision

All six seats — and the grounding compiler — use only OpenRouter `:free` models, each with a primary model falling through a shared `FREE_MODEL_CHAIN` on failure, for a full ~11-call deliberation costing **$0** (the WS2.6 cost-control constraint). This held, then drifted (T1 ran a paid model from ~PR #75 to PR #115), and is **true again as of PR #115 (2026-09-07)** — see "Validated by" below.

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
- `runSeat` tries `[primary, ...FREE_MODEL_CHAIN]` with a 20 s per-model timeout.
  The chain is **5 deep as of 2026-09-11** (was 4), so the worst case for one
  failing seat is ~120 s — and that number is now *exported* as
  `MODEL_CHAIN_WALK_BUDGET_MS` rather than left for each caller to guess. Two
  callers had guessed `25_000`, below one full walk, and returned
  `503 "AI unavailable"` whenever the primary fell through
  ([[incident-2026-09-11-nulogdash-blind-sweep]]). **Deepening the chain is not
  free: it lengthens the worst case, so anything wrapping the walk must derive its
  budget, never hardcode one.**
- **Chain depth is only real if every rung can do the job (2026-09-11).** The
  refresh selected a *code* model into the chain because it was `$0` and answered a
  one-token ping. `runSeat` checks that an answer is non-empty, not that it is
  on-topic, so a seat falling through would have returned a code completion as a
  trader's outlook. `SPECIALIST_MODEL_PATTERNS` now excludes code models, safety
  classifiers (one replies "User Safety: safe" to anything) and media ids from
  candidacy — a nominal depth of 5 with a code model at rung 5 is a real depth of 4.
- **`$0` and `listed` are not `callable` (2026-09-11).** Three separate seat
  failures passed an audit that checked existence and price: a paid id, a `$0` id
  gated to "agentic harnesses" (403 for this account), and two `$0` Google ids that
  429 on every call including the retry. The audit now sends a real one-token
  request per seat and counts an unreachable seat as degraded. A check on a remote
  dependency that never calls the dependency is a check on our own description of it.
- Model *quality* is the accepted risk: the entire verdict/critique/repair machinery ([[concept-verdict-repair-loop]], [[decision-four-field-verdict-scaffold]]) exists to make weak models produce reliable structured output.

## Validated by

- The chain-refresh infra shipped and passed code review (PR #30); PR #44 is that infra's first routine weekly refresh actually merging (`gemma-4-31b-it` → `nemotron-3-nano-omni-30b-a3b-reasoning`).
- ✅ **The $0 claim is accurate again (PR #115, 2026-09-07).** T1 ran a paid model (`cohere/command-r7b-12-2024`, ~$0.20–$0.50 per deliberation) from ~PR #75 until PR #115 repointed it at `thinkingmachines/inkling-small:free`. All six seat primaries are now `:free`. `refresh-free-models.mjs`'s seat audit now prints `ok` / **`PAID`** / `DEAD` per seat, and [[entity-model-usage-log]] flags any `⚠ paid` model that served a real call — so the next drift is visible, not silent. See [[entity-openrouter-client]] "Model assignment".
- ❌ **Refuted, 2026-07-30:** the previously-unvalidated concurrency risk below is real. OpenRouter free tier caps the **key**, not per-model, at 50 req/day (1000/day at ≥10 credits). One key shared across the whole app means council calls, `/api/brief`, and the refresh script's own probes all draw from the same 50 — any combination can exhaust it, at which point every model 429s at once and looks identical to "the whole free roster is dead." See [[entity-openrouter-client]] "Known failures" #3.

## See also

- [[incident-2026-09-11-nulogdash-blind-sweep]] — where the reachability gap and the hardcoded walk budgets were found

- [[entity-openrouter-client]] — `SEAT_MODELS`, `FREE_MODEL_CHAIN`, `runSeat`
- [[entity-model-usage-log]] — makes the `$0` invariant checkable after the fact (PR #115)
- [[concept-small-model-prompting]] — the prompting discipline this forces
- [[decision-compile-time-grounding]] — the sibling cost decision (no per-request embedding calls)
- [[entity-ai-council]] — the consumer
