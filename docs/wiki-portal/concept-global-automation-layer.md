---
date: 2026-08-06
type: concept
tags: [automation, global, cli-commands, hooks, wiki-led]
sources: [../../.claude/commands/, ~/.claude/rules/, ~/.claude/scripts/wiki-guard.mjs, ./concept-wiki-led-development.md]
---

# Concept: Global Automation Layer

The `~/.claude/` layer — global rules, hooks, scripts, and skills that apply
across *every* project — sitting above the project-scoped
[[entity-dev-command-suite]] in `nuwrrrld-portal/.claude/`. Together they form the
machinery that makes development wiki-led and self-improving. Current focus:
**automation and removing bottlenecks across the whole app stack and the admin
local app.**

## The pattern

Two tiers, one discipline:

| Tier | Location | Examples | Scope |
|---|---|---|---|
| **Global** | `~/.claude/` | `rules/*.md` (mobile-web-wiki-sync, stay-on-branch-after-merge, artifact-and-local-html, context-bloat-warning, mamba), `scripts/wiki-guard.mjs` + `wiki-lint.mjs` + `checkout-guard.mjs`, `PreToolUse` + `PostToolUse` hooks, the `wiki` skill | every project |
| **Project** | `nuwrrrld-portal/.claude/` | the [[entity-dev-command-suite]] (`/pr`, `/bugmerge1`, `/friction`, `/suggest-commands`, …) | this repo |

The global tier **enforces**; the project tier **executes**:

- **Enforcement (ingest)** — a global `PostToolUse` hook on `gh pr create`/`gh pr
  merge` runs `wiki-guard.mjs`, which *verifies* (not reminds): uncommitted wiki
  files, unpushed wiki commits, `wiki-lint` schema/link/secret violations, and
  cross-repo parity-number disagreement. Always exits 0 — never breaks a PR flow.
- **Enforcement (branch safety)** — a global `PreToolUse` hook on `git
  checkout`/`switch` runs `checkout-guard.mjs`: when the switch targets `main`
  while newer work sits in the tree, it backs the at-risk files up to `/tmp` and
  warns, then allows the checkout. Pairs with the `stay-on-branch-after-merge`
  rule to prevent the recurring file-loss failure
  ([[incident-2026-08-06-bugmerge1-command-file-loss]]).
- **Cross-surface invariant** — `mobile-web-wiki-sync.md` keeps the portal and
  mobile wikis mirror-consistent on the parity headline + matrix.
- **Output conventions** — global rules like `artifact-and-local-html.md`
  standardize deliverables (any requested HTML page → both a local file *and* a
  published artifact).
- **Execution** — the project command suite runs the actual orient → change →
  ship → ingest loop of [[concept-wiki-led-development]].

## Where it appears

- Every command in [[entity-dev-command-suite]] runs inside this layer and is
  bound by its hooks and rules.
- The self-improving loop ([[concept-bottleneck-command-suggestion]]) proposes
  new automation that lands in the project tier and, when it changes the
  enforcement story, gets recorded here.
- The [[incident-2026-08-06-bugmerge1-command-file-loss]] hardening (commit
  command files, self-integrity check) is a change to how this layer protects its
  own critical files.

## Contradictions / tensions

> The global tier can only *enforce what it can check*. It verifies ingest (wiki
> committed on `gh pr create`) but cannot verify orientation, and it can't force a
> friction line to be logged — the two open assumptions in
> [[concept-wiki-led-development]] and [[concept-bottleneck-command-suggestion]]
> both live at this boundary.

> ❓ Open question: rules in `~/.claude/rules/` are loaded as global instructions
> but aren't individually referenced from `CLAUDE.md`; there's no manifest that
> lists which rules are active, so drift between "rules on disk" and "rules in
> effect" is possible and unaudited.

## See also

- [[concept-wiki-led-development]] — the loop this layer enforces
- [[entity-dev-command-suite]] — the project-scoped commands that execute inside it
- [[concept-bottleneck-command-suggestion]] — how the layer grows itself
- [[incident-2026-08-06-bugmerge1-command-file-loss]] — a scar in how the layer protects its own files
