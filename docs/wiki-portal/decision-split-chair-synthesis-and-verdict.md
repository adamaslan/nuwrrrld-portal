---
date: 2026-07-20
type: decision
tags: [chair, verdict, synthesis, small-models, voting]
sources: [../../lib/openrouter.ts, ../../app/api/council/deliberate/route.ts, PR#37]
---

# Decision: Split CHAIR Synthesis and Verdict into Two Calls

## Decision

The CHAIR makes **two separate model calls**, not one:

1. **Synthesis** — prose only, ~180 words, best free model. No JSON, no verdict line.
2. **Verdict** — a single-line JSON object (`CHAIR_VERDICT_SYSTEM`), run **3×** on `SMALLEST_MODEL`, majority-voting `direction` and taking the **minimum** confidence.

## Date

2026-07-18 (PR #37).

## Context

Asking one call to both reason in prose *and* emit a clean machine-readable verdict is two jobs with opposite output shapes. A small model that does both tends to either bury the JSON in prose (forcing brittle regex extraction) or truncate the synthesis to fit the JSON. Separating them lets each call be tuned to exactly one shape ([[concept-small-model-prompting]] §6).

## Alternatives considered

- **One combined call, extract JSON from prose.** Rejected — regex-fishing prose for a stray `{...}` is fragile; a malformed line corrupts both outputs.
- **Single verdict call (run once).** Rejected — a lone small-model verdict is noisy. Running 3× and majority-voting direction is cheap (it's the smallest model, `max_tokens≈80`) and materially more stable.
- **Average the confidence across samples.** Rejected in favor of **minimum** — a deliberately conservative bias: if any of three samples is unsure, the reported confidence is the unsure one.

## Consequences

- The verdict call runs at `max_tokens≈80` and is `JSON.parse`'d directly — no prose to fish through.
- A malformed verdict JSON can never corrupt the synthesis, and vice versa.
- Cost: adds 3 tiny calls, but on `SMALLEST_MODEL` and free-tier, so still $0 ([[decision-free-tier-model-chain]]).
- The "min confidence" rule means a split council reads as low-confidence by construction — the system errs toward humility.

## Validated by

- The 3×-majority + min-confidence logic is deterministic and unit-tested over sampled inputs.
- Live behavior (does the smallest model actually return parseable single-line JSON reliably?) is **not** covered by a golden test — same CI gap as [[decision-four-field-verdict-scaffold]].

## See also

- [[entity-ai-council]] — stage 4 (synthesis) of the deliberate flow
- [[entity-openrouter-client]] — `CHAIR_VERDICT_SYSTEM`, `SMALLEST_MODEL`
- [[concept-small-model-prompting]] — §6, one output shape per call
- [[decision-four-field-verdict-scaffold]] — the sibling "structure over prose" decision
