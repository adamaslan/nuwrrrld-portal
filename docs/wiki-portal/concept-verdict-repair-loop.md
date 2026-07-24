---
date: 2026-07-20
type: concept
tags: [validation, repair, verdict, deterministic, small-models]
sources: [../../lib/council-validate.ts, ../../lib/council-verdict.ts, ../../app/api/council/route.ts, PR#37]
---

# Concept: Verdict Repair Loop

Deterministic, millisecond validators over a structured verdict, turned into a **mechanical re-prompt** rather than a bare reject. A small model can't find its own mistake from "please improve" — but it *can* execute a fix that names the exact field and the exact correct value ([[concept-small-model-prompting]] §7).

## The pattern

Two pure, no-network checks in `lib/council-validate.ts`:

1. **Numeric cross-check** — every number in `BECAUSE` / `INVALIDATION` / `EXECUTION` must appear (±1% tolerance) somewhere in the grounded brief it was built from. A number that doesn't is a hallucinated figure. Before matching, the check strips evidence ids (`[C1]` — the "1" is a reference, not data) and thousands-separator commas (so `18,500.00` isn't split into two numbers — a PR #37 review fix).
2. **Trade-logic sanity** — `EXECUTION`'s entry/stop/target must be ordered correctly for the call's direction: `stop < entry < target` for a long, reversed for a short.

When a check fails, `buildRepairMessage` produces a re-prompt that names the offending field and the constraint it violated, and the seat is asked once more. The loop is a *repair*, not a reject — the model gets a chance to fix a specific, located error before the caller falls back to an error state.

## Where it appears

- `app/api/council/route.ts` — the T1/T2 quick-ask runs `validateStructuredVerdict` → `buildRepairMessage`, retries once, then returns `council_response_invalid` (502) if still bad
- `app/api/council/deliberate/route.ts` — T1/T2 round-1 answers pass through the same loop before being accepted into the debate
- Depends on `parseStructuredVerdict` ([[decision-four-field-verdict-scaffold]]) to have a structured object to validate at all — free prose can't be repaired this way

## Contradictions / tensions

> The numeric cross-check assumes the brief contains every number a correct verdict would cite. If [[entity-grounding-tier-ladder]] returns a *miss* (ungrounded brief), there are no grounded numbers to check against — so the repair loop can't catch a hallucinated figure in the very case (no grounding) where hallucination is most likely.

> ❓ Open question: the ±1% tolerance is fixed. For a low-priced ticker a 1% band may be tighter than the model's rounding; for a high-priced one, looser than intended. Is a fixed percentage the right tolerance model?

## See also

- [[decision-four-field-verdict-scaffold]] — the structure this validates
- [[concept-small-model-prompting]] — §7, the "name the exact fix" principle
- [[entity-grounding-tier-ladder]] — supplies the brief numbers are checked against
- [[entity-ai-council]] — the flow the loop sits inside
