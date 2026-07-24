---
date: 2026-07-20
type: decision
tags: [verdict, prompting, small-models, format]
sources: [../../lib/council-verdict.ts, ../../lib/openrouter.ts, PR#37, PR#34]
---

# Decision: Four-Field Verdict Scaffold (not six)

## Decision

The structured verdict is **four** labeled fields — `OUTLOOK` / `BECAUSE` / `INVALIDATION` / `EXECUTION` — down from six. Each is a strict `LABEL: value` line; the model is instructed to emit nothing else.

## Date

2026-07-18 (PR #37), building on the 2026-07-15 chain-of-thought audit fix.

## Context

The 2026-07-15 audit found the T1 card rendering the model's raw chain-of-thought (*"The user wants a 1–5 day trade framing… I need to extract specific numbers…"*) and truncating mid-sentence. Root cause: the prompt asked for **prose**, so there was nothing to validate against and nothing to strip. The fix required a delimited format — but a six-field format exposed a second small-model failure: a 7B model reliably drops directives past the third or fourth field ([[concept-small-model-prompting]] §2–3).

## Alternatives considered

- **Keep six fields (key-driver, evidence-id, quote, entry, stop, target as separate slots).** Rejected — small models drop the later fields; the tail fields came back empty.
- **Free prose with post-hoc extraction.** Rejected — this was the original design that leaked chain-of-thought; regex-fishing prose for a verdict is exactly what caused the incident.
- **JSON output.** Rejected for the seat answers — a malformed JSON line corrupts the whole answer; the `LABEL: value` line format degrades more gracefully. (JSON *is* used, but only for the tiny isolated CHAIR verdict call — see [[decision-split-chair-synthesis-and-verdict]].)

## Consequences

- `BECAUSE` folds evidence-id + quote into one copyable slot; `EXECUTION` bundles entry/stop/target into one line — fewer fields, each doing more.
- `parseStructuredVerdict` requires all four fields and rejects any `OUTLOOK` outside the `bullish|bearish|neutral` enum. Previously an arbitrary outlook string passed through silently and defaulted to "neutral" (flagged in PR #34 review) — now that's a parse *failure*, not a silent guess.
- `stripReasoning` removes `<think>`/`[thinking]` blocks and any prose before the first `OUTLOOK:` — a defense-in-depth layer even with the strict format.
- Enables the whole [[concept-verdict-repair-loop]] — you can only validate and repair a structured object.

## Validated by

- The deterministic Vitest suite covers parsing, enum rejection, and reasoning-stripping.
- ❓ Not validated by any live-model golden test — whether a real 7B actually produces four parseable fields under the current prompt isn't checked in CI (deferred in PR #37).

## See also

- [[entity-ai-council]] — where the verdict format is consumed
- [[concept-small-model-prompting]] — §2–3, the directive-count constraint
- [[concept-verdict-repair-loop]] — what the structure enables
- [[decision-split-chair-synthesis-and-verdict]] — the sibling format decision
