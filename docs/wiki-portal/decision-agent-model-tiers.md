---
date: 2026-10-11
type: decision
tags: [agents, cost, delegation, codex, claude-code, workflow]
sources: [../../AGENTS.md, ../../TODO.md, ../../.claude/agents/explorer.md, ../../.claude/agents/implementer.md, ../../.claude/agents/reviewer.md]
---

# Decision: Coding Agents Work in Vendor-Neutral Tiers, One Unit per Session

## Decision

Every coding agent in this repo — Claude Code, Codex, Cursor — follows one set of rules
in `AGENTS.md`, written per **tier** (Judgment / Workhorse / Cheap / Free) rather than per
vendor. The main session keeps judgment and the sensitive surfaces; bulk reading and
mechanical edits go to cheaper tiers that return short summaries. Each session works one
`TODO.md` item on one branch, and restarts from a handoff once its added context reaches
about 1.5× the starting load.

## Date

2026-10-11

## Context

Each session starts with a fixed instruction load of tens of thousands of tokens, and every
turn re-sends the whole accumulated context. Running everything in the most expensive model
wastes it on file reads, while very long sessions pay for a growing context on every turn.
With prompt caching, the cost per turn is lowest at a session length of roughly
`5·√(fixed load ÷ growth per turn)`. Keeping tool output out of the main context lowers the
growth term, so delegation, not just a cheaper model, is what moves the cost.

Two tools now share the checkout: Claude Code (reads `CLAUDE.md` → `AGENTS.md`) and Codex
(reads `AGENTS.md`). Vendor-specific rules would drift between them.

## What changed

- `AGENTS.md`: tier table mapping each tier to Claude Code and Codex models; delegation
  rules with a never-delegated list (auth, session, CSRF, rate-limit, crypto, Clerk/Stripe
  webhooks, DB migrations, `lib/pipeline-db-guard.ts`); session budget; one agent per
  worktree across tools.
- `.claude/agents/`: `explorer` (cheap, read-only), `implementer` (workhorse, no git, no
  sensitive surfaces), `reviewer` (cheap, read-only diff review). All return ≤~300 words.
- `TODO.md`: an agent-workflow section plus a lead-tier tag (`J`, `W`, `C`, `H`, `X→Y`)
  on each active item, a claim convention so parallel agents don't collide, and a
  range-read command so sessions skip the inventory tables.

## Consequences

- The free OpenRouter tier is allowed only for non-sensitive second-opinion review; the
  app's runtime chain in `lib/openrouter.ts` stays product code (see
  [[decision-free-tier-model-chain]]).
- Model names in the tier table will age; update the table, not the rules.
- Same two-tier split as `/fixy`; see [[concept-small-model-prompting]] for why lower tiers
  get narrow, closed briefs.

## Alternatives considered

- **Opus does everything.** Simplest, but file reads and log dumps land in the most
  expensive context and are re-sent on every later turn.
- **"The orchestrator never writes code."** Too rigid: forces a delegation round-trip even
  for a one-line edit in a file already open, and would push sensitive surfaces down to
  cheaper tiers. Replaced by "delegate by default, keep inline with a named reason".
- **Separate rule files per tool** (`CLAUDE.md` rules vs Codex rules). Rejected because they
  drift; `AGENTS.md` is read by both.
- **A new `TASKS.md` queue.** Rejected; `TODO.md` is already the canonical queue, so it got
  tier tags and a claim convention instead.

## Validated by

Not yet measured. The cost model is arithmetic from cache pricing, not a recorded run. The
first validation is a per-session token comparison before and after delegation on two or
three `W`/`C` items from `TODO.md`.

## See also

- [[decision-free-tier-model-chain]]
- [[concept-small-model-prompting]]
- [[decision-free-pr-review-lenses-and-verifier]]
