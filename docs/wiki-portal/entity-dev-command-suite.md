---
date: 2026-08-06
type: entity
tags: [devops, cli-commands, automation, workflow, wiki-led]
sources: [../../.claude/commands/pr.md, ../../.claude/commands/sync-pr.md, ../../.claude/commands/bugmerge1.md, ../../.claude/commands/postbugmergerev.md, ../../.claude/commands/friction.md, ../../.claude/commands/suggest-commands.md]
---

# Entity: Dev Command Suite

## What it is

The catalog of project-level slash commands in `.claude/commands/` that drive
NuWrrrld portal development. Each command is a repeatable, wiki-led workflow born
from repeated pain — the suite is the app's **automation layer for shipping**,
and the hub every command links back to.

| Command | Purpose | Loop role |
|---|---|---|
| `/pr` | Branch, secret-scan, build, commit, open a PR (portal only) | **Ship** |
| `/sync-pr` | Coordinated portal + mobile PRs for a cross-surface change | **Ship** (cross-repo) |
| `/bugmerge1` | Drain the open-PR queue: fix review-comment bugs, rebase each onto `main`, merge conflict-free | **Change** (cheap/Haiku plumbing) |
| `/postbugmergerev` | Opus/Sonnet second pass over what `/bugmerge1` merged; deepen shallow fixes, PR + ingest | **Change** (deepen) |
| `/friction` | Log one bottleneck line to `log.md` the moment you hit it | **Signal** |
| `/suggest-commands` | Mine `log.md` + incidents + PR comments; propose new automation over threshold | **Self-improve** |
| `/resume-safe` | Checkpoint to the wiki log near the token limit, resume after a wakeup, emit an HTML summary when done | **Survive limits** |

## Where used

- Invoked as `/name` in Claude Code sessions on `nuwrrrld-portal`.
- All six participate in [[concept-wiki-led-development]]: they **orient** from
  [[START-HERE]] before changing code and **ingest** into this wiki when they
  ship (enforced on `gh pr create` by the wiki-guard hook).
- `/friction` + `/suggest-commands` form the self-improving loop described in
  [[concept-bottleneck-command-suggestion]].
- The suite is the project-scoped half of the broader
  [[concept-global-automation-layer]] (`~/.claude/`).

## Known failures

- [[incident-2026-08-06-bugmerge1-command-file-loss]] — `/bugmerge1`'s own
  definition file was clobbered mid-run because command files were untracked and
  not branch-safe. Resolution: commit the command files to git, add a
  self-integrity check + out-of-tree backup, and pathspec-scope `git stash -u`.

## Open questions

> ❓ Open question: the incident's open items ask to audit `bugz`, `geepr`, and
> other commands for the same branch-safety vulnerability — not yet done.

> ❓ Open question: nothing yet enforces that a command *orients* (reads the wiki)
> before it changes code; orient-first is instructed in each command, not verified
> ([[concept-wiki-led-development]] open question).

## See also

- [[concept-wiki-led-development]] — the process these commands run
- [[concept-bottleneck-command-suggestion]] — the loop that grows the suite
- [[concept-global-automation-layer]] — the `~/.claude/` layer this is the project half of
- [[incident-2026-08-06-bugmerge1-command-file-loss]] — the branch-safety scar
- [[START-HERE]] — the orient step every command begins with
