---
date: 2026-07-20
type: concept
tags: [prompting, small-models, free-tier, verdict, critique]
sources: [../../lib/openrouter.ts, ../../lib/council-verdict.ts, ../../lib/council-critique.ts, ../../lib/council-validate.ts, PR#37]
---

# Concept: Small-Model Prompting

Every council prompt is written for the *worst* model in `FREE_MODEL_CHAIN` (a 7B–30B free-tier model), not the best. This is a cross-cutting design contract — referenced by section number throughout the code (`docs/council-prompting-small-models.md §N`) — that shapes prompts, output formats, and where work is moved out of the model entirely.

## The pattern

The governing rules (from `SEAT_SYSTEM`'s own comments and the referenced spec):

- **≤5 directives per call.** A 7B model drops directives past the third or fourth.
- **Checklist over prose.** Enumerated constraints beat paragraphs.
- **Positive constraints only.** Small models handle "do X" far better than "don't do Y."
- **Recency wins — repeat the critical constraint last.** The most important instruction goes at the end of the prompt.
- **Move work out of the model when it can be done in code.** Disagreement detection, numeric checking, and trade-logic ordering are all mechanical — they don't need a model at all.

## Where it appears

Each numbered section maps to a concrete mechanism in the codebase:

| § | Rule | Implementation |
|---|---|---|
| §2–3 | 4-field verdict, not 6 | [[decision-four-field-verdict-scaffold]] (`council-verdict.ts`) |
| §6 | synthesis and verdict are separate calls | [[decision-split-chair-synthesis-and-verdict]] |
| §7 | repair loop names the exact fix | [[concept-verdict-repair-loop]] (`council-validate.ts`) |
| §8 | diff-shaped critique computed in code | `computeDisagreements()` (`council-critique.ts`) |
| §10 | best model on the hard job, smallest on classification | `SEAT_MODELS` / `SMALLEST_MODEL` ([[entity-openrouter-client]]) |

The §8 critique is the clearest example: *"critique the other seats"* produces polite mush from small models, so `extractDirection` + `computeDisagreements` find who actually disagrees on direction **in code**, and only genuinely-disagreeing seats get a round-2 call. Agreeing seats, ties, and undetectable directions skip round 2 entirely.

## Contradictions / tensions

> ❓ Open question: the contract targets "the worst model in the chain," but `SEAT_MODELS` assigns *specific* primary models per seat (e.g. Cohere command-r7b for T1's structured output). If a seat falls through to a weaker chain model, is its prompt still reliably parseable? No live-model golden test verifies this in CI ([[entity-ai-council]] open question).

> The §10 model assignment predates the residual-difficulty analysis it cites — so the *mapping* exists but its empirical justification (Layer-B flag-rate telemetry) doesn't yet. The rule is applied on principle, not measurement.

## See also

- [[entity-ai-council]] — the system these techniques serve
- [[entity-openrouter-client]] — where `SEAT_SYSTEM` and the model map live
- [[concept-verdict-repair-loop]] — §7 made concrete
- [[decision-four-field-verdict-scaffold]] — §2–3 made concrete
- [[decision-split-chair-synthesis-and-verdict]] — §6 made concrete
- `gcp3-mobile/docs/wiki-mobile/entity-council-composer.md` — the mobile council's prompt builders this convention was ported alongside
