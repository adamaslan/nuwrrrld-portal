---
date: 2026-08-06
type: incident
tags: [devops, cli-commands, file-management, workflow, recovery]
sources: [../../.claude/commands/bugmerge1.md, ../../docs/wiki-portal/entity-dev-command-suite.md]
---

# Incident: /bugmerge1 Command File Disappeared During Execution

## Date & severity

**2026-08-06** — Severity: **Moderate**. Workflow interrupted mid-task; no code or data lost, no secrets exposed. Recovered without rollback.

## What happened

During execution of `/bugmerge1` to merge PRs #46 and #47, the command definition file `.claude/commands/bugmerge1.md` was lost from the working directory mid-workflow. At approximately 13:05 UTC, after the first PR merged, the file was no longer present in `.claude/commands/`. The user noticed ("its not in the commands folder"), restored the file manually from git history at 13:07 UTC, and the workflow completed successfully.

## Root cause

The file existed as an **untracked file** in `main` but not in the branches being checked out (both PR branches predated its creation in commit `568f67d`, 2026-08-05). One of three mechanisms likely caused the loss:

1. `git checkout` onto a branch where the file never existed silently removed it from disk
2. An intermediate `git stash -u` swept up untracked files including the command definition
3. A combination of the above — stash put it aside, then a branch checkout without pop left it inaccessible

## Resolution

- File restored from git history by the user at 13:07 UTC
- Both PR merges completed; wiki sync finished successfully
- This PR ships the command files as tracked, committed files so they can never disappear from any branch going forward

## Impact on design

- Confirmed that `~/.claude/commands/` (project-level) files are **not branch-safe** if untracked — the automation layer must treat them as critical workflow infrastructure, not ephemeral scratch files
- `/bugmerge1` workflow revised to: (a) copy its own definition to `/tmp` before step 1, (b) verify file presence before and after each checkout/rebase, and (c) use pathspec-scoped `git stash -u -- <paths>` instead of a bare `-u` sweep
- All critical command files now committed to git so branch operations cannot clobber them; see [[entity-dev-command-suite]]

## Recurrence (2026-08-07) and systemic fix

The same failure class recurred: PR #48, built from a branch that **predated**
this session's edits, was squash-merged into `main`; a later return to `main`
then replaced on-disk files with `main`'s older versions — reverting the
`0. Orient` command edits and dropping newly-created files. Root cause
generalized: **`main` is not a safe place to stand while newer work is in
flight.** Two systemic guards were added:

1. **Global rule** `~/.claude/rules/stay-on-branch-after-merge.md` — never
   `git checkout main` after a merge; stay on the branch or branch the next
   change off `origin/main`; advance local `main` by ref only
   (`git fetch origin main:main`). The git commands (`/pr`, `/bugmerge1`,
   `/postbugmergerev`) were updated to follow it.
2. **`checkout-guard` PreToolUse hook** (`~/.claude/scripts/checkout-guard.mjs`,
   wired in `~/.claude/settings.json`) — on any `git checkout`/`switch` toward
   `main`, it detects files newer in the working tree, **backs them up to /tmp**,
   and warns, while allowing the checkout (warn-and-allow, never blocks a flow).

## Open items

- [ ] Document which command files are critical in `.claude/commands/README.md` or a `.critical-files` marker
- [ ] Audit other dev commands (bugz, geepr, etc.) for the same branch-safety vulnerability
- [ ] Verify `git stash -u` usage across all workflow skills and narrow blast radius where present

## See also

- [[entity-dev-command-suite]] — the command catalog this file belongs to
- [[concept-global-automation-layer]] — the ~/.claude/ layer where these files live
