---
date: 2026-10-09
type: entity
tags: [review, free-tier, small-models, openrouter, tooling]
sources: [../../scripts/free-pr-review.mjs, ../../scripts/review/core.mjs, ../../scripts/review/eval.mjs, ../../scripts/review/lenses.json, ../../docs/free-model-pr-review.md, PR#free-pr-review]
---

# Entity: Free-Model PR Reviewer (`scripts/free-pr-review.mjs`)

A local, opt-in triage reviewer that runs a PR's diff through the models in `FREE_MODEL_CHAIN` and reports quote-anchored findings. It is developer tooling, not a product feature: nothing here ships to users, and it has no mobile counterpart.

## What it is

- **Orchestrator** — `scripts/free-pr-review.mjs` reads a diff on stdin, verifies the chain is free, runs the review, prints JSON. Exit `1` missing key, `2` free-ness unverified, `3` a call was billed.
- **Lenses** — `scripts/review/lenses.json`: nine closed yes/no questions (null-guard, error-path, auth, secret, webhook-sig, shared-drift, timeout, test-asserts, fallthrough), each scoped by path glob. Several mirror the invariants in `.coderabbit.yaml` `path_instructions`, so the two reviewers check the same rules.
- **Core** — `scripts/review/core.mjs`: diff splitting, lens routing, quote anchoring, the model call with a billed-cost check, and the free-chain verification.
- **Context pack / verifier** — a second pass hands each anchored finding plus the definitions it depends on to the largest chain model, and drops anything the verifier calls false.
- **Golden eval** — `scripts/review/eval.mjs` runs planted-bug and known-clean diffs through one chain model at a time and reports recall and precision per model.
- **Slash command** — `.claude/commands/freereview.md` wraps preflight, tools, golden check, review, and an ask-before-posting step.

## How it stays free

Three layers, fail closed ([[decision-free-pr-review-lenses-and-verifier]] has the reasoning): the weekly refresh admits only `:free` ids priced at zero; the reviewer re-checks the live catalog at startup and drops any id that fails; and every call asks OpenRouter for the billed cost and stops the run if it is not exactly zero. See [[entity-openrouter-client]] for the chain itself.

## Where used

Run by hand or through `/freereview` against a PR before or alongside CodeRabbit. It never edits code, never merges, and posts a comment only after an explicit yes.

## Known failures

- **Low precision.** On the 2026-10-09 golden set every chain model had recall 0.80 and precision 0.44–0.57, so about half of raw findings are noise. Quote anchoring and the verifier pass exist because of this.
- **Partial runs.** The 2.6B model left calls unanswered; a run with unanswered calls is partial and must say so, since silence otherwise reads as "clean".
- **Non-determinism.** Free providers differ run to run even at temperature 0, and a reasoning model with a small token budget spends it thinking and never emits JSON (hence `MAX_TOKENS` 2000).
- **Blind spots.** Cross-file logic, concurrency and design questions are out of reach for small models; use CodeRabbit or a strong-model pass.

## Open questions

> ❓ Open question: should the weekly model-refresh job run the golden eval and put per-model recall in its PR body, so a model that is reachable but incompetent at review is not kept in routing? Proposed in the guide, not wired.

> ❓ Open question: the reviewer reads the chain from `lib/openrouter.ts`, which is tuned for council chat. Review may want a different model order than chat does.

## See also

- [[entity-openrouter-client]] — owns `FREE_MODEL_CHAIN` and the fallback walk
- [[concept-small-model-prompting]] — the prompt contract the lenses follow
- [[decision-free-tier-model-chain]] — why the chain is free-only
- [[decision-free-pr-review-lenses-and-verifier]] — why the review is built this way
