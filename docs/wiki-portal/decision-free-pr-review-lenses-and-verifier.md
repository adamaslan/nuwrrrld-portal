---
date: 2026-10-09
type: decision
tags: [review, small-models, free-tier, verification]
sources: [../../docs/free-model-pr-review.md, ../../scripts/review/core.mjs, PR#free-pr-review]
---

# Decision: Review With Lenses, Quote Anchoring and a Verifier, Not One Big Prompt

## Decision

The free-model PR reviewer asks one closed yes/no question about one file per call, requires the model to quote the exact added line, checks that quote in code, runs a second-model verifier on survivors, and refuses to run unless every model is proven free.

## Date

2026-10-09

## Context

The models in `FREE_MODEL_CHAIN` are small and rotate weekly. A single "review this PR" prompt gives them too much to hold, and they answer with confident, unlocated prose. An early run with a 300-token budget found none of three planted bugs because reasoning models spent the whole budget thinking; with a 2000-token budget and low reasoning effort the same models found all three. A real PR then produced one false positive, because the function the model worried about was defined in a file it never saw.

## Alternatives considered

- **One prompt per PR.** Cheapest in calls, but small models drop directives and cannot localize findings.
- **Trust the model's severity and confidence.** Small models grade these poorly, so severity is assigned per lens in code.
- **Trust the catalog or the `:free` suffix for free-ness.** The suffix is a naming convention and the catalog describes the listing, not the call. A paid id once passed an existence audit and sat in a council seat, so free-ness is checked at three layers.
- **Pay for a stronger reviewer.** Defeats the point; kept as the separate CodeRabbit / strong-model pass.

## Consequences

- Call count scales with files × lenses, so lenses are routed by path to stay inside the free daily request cap.
- A run reports yes / no / unanswered per call so a partial review cannot pass for a clean one.
- A golden set measures each model, because a model answering is not the same as a model reviewing well.
- The reviewer is triage only and never gates a merge.

## Validated by

Live golden-set eval on 2026-10-09: all three chain models recall 0.80, precision 0.44–0.57. The seeded-bug runs found the planted defects, the startup check dropped an injected paid id before any call, and it also caught a retired `:free` id still sitting in the chain.

## See also

- [[entity-free-pr-reviewer]]
- [[concept-small-model-prompting]]
- [[decision-free-tier-model-chain]]
