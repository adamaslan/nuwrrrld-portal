---
ARCHIVED: 2026-08-16
REASON: Rebase conflict with a later, independently-written version of this
  page that landed on main (dated 2026-08-06) while this branch (squashed
  commit, originally authored 2026-08-05) sat unpushed. Both are genuine,
  differently-structured drafts of the same concept, not one superseding
  the other — archived rather than discarded per the project's
  archive-never-delete policy. The canonical page is
  docs/wiki-portal/entity-dev-command-suite.md.
---

---
date: 2026-08-05
type: entity
tags: [dev-tooling, commands, workflow, ci, pr]
sources: [.claude/commands/pr.md, .claude/commands/bugmerge1.md, .claude/commands/sync-pr.md, .claude/commands/local-check.md, .claude/commands/nulogdash.md]
---

# entity: Dev Command Suite (`.claude/commands/`)

## What it is

The repo's slash-command layer — the repeatable, guard-railed workflows a
developer (or Claude) runs instead of re-deriving the steps each time. Each is a
markdown playbook in [`.claude/commands/`](../../.claude/commands/); running
`/name` loads that playbook into the turn. They encode this repo's hard-won
conventions (Next.js 16 build check, secret scan, Clerk/Stripe parity, the
mobile↔web wiki-sync rule) so they don't get skipped.

The suite as of 2026-08-05:

| Command | Purpose | Key guardrails |
| --- | --- | --- |
| **`/pr`** | Branch, secret-scan, build, commit, open a PR against `main` for *this repo only*. | Rejects `.env`/key patterns in the diff; `npm run build` must show `ƒ Proxy (Middleware)`; never blind `git add -A`; **pre-PR conflict guard** (see below). |
| **`/bugmerge1`** | Drain the open-PR queue: read each PR's review comments, fix the bugs they describe, and merge conflict-free. | Rebase each branch onto latest `main` *before* editing; re-sync the queue after every merge; stop-and-report on semantic conflicts; same secret scan as `/pr`; squash-merge only when GitHub reports `mergeable`. |
| **`/sync-pr`** | Coordinated cross-surface PRs when a change touches both the portal and `gcp3-mobile`. | Keeps the two branches named alike; triggers the parity wiki-sync in both repos. |
| **`/local-check`** | Full-stack local environment sanity sweep before starting work. | Verifies the dev stack is actually up, not just installed. |
| **`/nulogdash`** | Feature-level end-to-end sweep across the log dashboard surface. | — |

Beyond these, the workflow references several **global** skills that live under
`~/.claude/skills/` rather than in-repo (`/reb` rebase-onto-main, `/maxtoke`
biweekly PR loop, `/rem1` fullstack fix-ship-summarize, `/bugz` PR bug fixer).
Those are cross-project and are intentionally *not* checked into this repo — see
[[concept-global-automation-layer]] for the full map, and note the lineage:
`/geepr` → `/pr`, `/bugz` → `/bugmerge1` (the local commands are hardened,
portal-scoped specializations of the global verbs).

## Where used

- **`/pr` → `/bugmerge1`**: `/pr` now opens with a **Pre-PR Conflict Guard**
  that diffs your pending files against the files every open PR touches
  (`gh pr diff <n> --name-only`). If the overlap is non-empty, it routes you to
  `/bugmerge1` to clear the queue *first*, then re-branch off fresh `main`. This
  is the mechanism that stops a new PR from landing conflict markers on `main`.
- **`/bugmerge1` → `gh` + rebase**: operates entirely through `gh pr` and
  `git rebase origin/main` + `git push --force-with-lease`. The
  "rebase-before-edit, re-sync-after-merge" loop is what keeps every subsequent
  merge conflict-free.
- **Any PR command → this wiki**: per `SCHEMA.md` "On PR Creation" and the
  global mobile↔web parity rule, opening a PR is itself an ingest event — the
  command playbooks assume the wiki gets updated in the same turn.

## Known failures

> ⚠️ Contradiction: the PR playbooks assume `npm run build` and the vitest
> suite gate quality, but per [[concept-test-strategy]] **nothing runs the unit
> suite in CI** and `npm run lint` crashes repo-wide. So `/pr`'s "build passes"
> attestation is real, but its implied test/lint coverage is not enforced by
> anything except the human running the command.

- `/bugmerge1` force-pushes with `--force-with-lease`; if two people are editing
  the same PR branch, the lease protects against clobbering but the command will
  stop rather than resolve — by design.

## Open questions

> ❓ Open question: should `/bugmerge1` invoke the global `/bugz` skill for the
> comment-fixing step instead of re-implementing it? Today it models the fix
> flow on `/pr` conventions because the `bugz` skill file isn't checked into
> this repo.

> ❓ Open question: none of these commands are self-generating. New commands are
> added by hand when a pain point recurs. See
> [[concept-bottleneck-command-suggestion]] for the proposed mechanism that
> mines `log.md` for repeated friction and *proposes* new commands.

## See also

- [[concept-bottleneck-command-suggestion]] — how new commands get proposed from
  observed process bottlenecks
- [[concept-global-automation-layer]] — the `~/.claude/` commands, rules, and
  hooks these repo-local commands generalize and depend on
- [[concept-mobile-web-parity]] / [[concept-sync-requirements]] — what `/sync-pr`
  and the parity wiki-sync keep in agreement
- [[concept-test-strategy]] — why the CI/test guardrails these commands assume
  aren't actually enforced
- [[SCHEMA]] — the "On PR Creation" ingest workflow every PR command triggers
