---
date: 2026-07-20
type: decision
tags: [grounding, compiler, deterministic, cost, rag]
sources: [../../lib/grounding/resolve.ts, ../../scripts/compile_grounding_pack.mjs, ../../lib/grounding/taxonomy.ts, PR#35, PR#36, PR#37]
---

# Decision: Compile-Time Grounding (not request-time RAG)

## Decision

Grounding is a **build step**, not a request step. A model reads the corpus exactly once — weekly, in CI ([[entity-grounding-compiler]]) — and extracts rule tuples into a `grounding_pack` keyed on a finite taxonomy. At request time, [[entity-grounding-tier-ladder]] resolves a seat's brief with a **SQL lookup and zero model or embedding calls**.

## Date

Landed across PR #35 (taxonomy + Neon contract), #36 (corpus + chunker + weekly job), #37 (resolver + per-seat slicing).

## Context

The council runs ~11 model calls per deliberation, all on free-tier models under strict latency budgets. A conventional request-time RAG pass (embed the query, vector-search a store, maybe re-rank with a model) would add embedding round-trips and possibly extra model calls to *every* seat, on *every* request — directly fighting the $0 cost constraint ([[decision-free-tier-model-chain]]) and the latency budget.

## Alternatives considered

- **Request-time vector RAG** (embed query → similarity search → optional rerank). Rejected — per-request embedding + search cost and latency; non-deterministic retrieval makes the [[concept-verdict-repair-loop]] numeric check harder to reason about.
- **Stuff the whole corpus into the prompt.** Rejected — blows the context window of 7B–30B models and buries the relevant rule.
- **No grounding, prompt-only.** Rejected — that's the ungrounded fallback state, not the design goal; it's what the tier ladder degrades *to*, not what it aims for.

## Consequences

- Tier 0 is a ~5 ms indexed join; the whole ladder tops out around 15 ms and shares the Neon connection already open for hit-rates and prior verdicts.
- Retrieval is **deterministic**: `toStateKey()` is pure, so the same signal always fetches the same evidence — which makes the numeric cross-check ([[concept-verdict-repair-loop]]) tractable.
- A hard invariant becomes enforceable: a pack rule's `quote` must be a verbatim substring of a real chunk, so the pack **cannot** contain text the corpus doesn't.
- Cost of the tradeoff: grounding is only as fresh as the last weekly compile, and only as complete as the migrated corpus (today: sample-only). Staleness is surfaced via the `degraded` flag rather than hidden.

## Validated by

- `__tests__/grounding-taxonomy.test.ts` covers the state-key space.
- The tier-latency figures are the design targets stated in `resolve.ts`; ❓ not independently benchmarked in this repo.
- End-to-end coverage is currently against **sample** corpus only — the pipeline is proven, the production corpus is not yet migrated ([[entity-grounding-compiler]] known failure #1).

## See also

- [[entity-grounding-tier-ladder]] — the request-time resolver this decision produces
- [[entity-grounding-compiler]] — the build step
- [[concept-graceful-degradation]] — how a miss/stale pack behaves
- [[decision-free-tier-model-chain]] — the cost constraint that motivated this
- `gcp3/docs/wiki-gcp3/entity-bake-pipeline.md` — the backend's analogous bake-ahead pattern
