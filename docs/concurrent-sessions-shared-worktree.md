# Concurrent Claude Sessions in One Working Tree

**Date:** 2026-08-31
**Status:** diagnosed; no fix applied yet
**Severity:** high — silently reassigns branch names and can delete uncommitted files

## Correction to an earlier claim

During the session that found this, I told the user *"something in your setup is
moving branches under you"* and pointed at hooks. **That was wrong, and it sent
the diagnosis in the wrong direction.** No hook moves branches:

- The `PreToolUse` hook matching `git checkout|switch` runs
  `~/.claude/scripts/checkout-guard.mjs`, which **copies at-risk files to a
  temp dir and warns**. It never stashes, never switches, never writes to the
  repo. It also explicitly returns `{risk:false}` for any target that isn't
  `main`/`master`/`origin/main`/`origin/master`.
- Every other hook (`no-conflicts-guard`, `wiki-guard`, `fixy-guard`) is
  read-only and exits 0 by design.

The real cause is below. Documenting the wrong guess too, because "blame the
hooks" is the intuitive answer and the next person will reach for it as well.

## What is actually happening

**Multiple Claude Code sessions are running against the same checkout of
`~/code/nuwrrrld-portal` at the same time.** They share one `.git` directory
and one set of working-tree files, so each one's `git checkout` yanks the
filesystem out from under the others.

Four session transcripts were active in this repo within the same minutes:

```
~/.claude/projects/-Users-adamaslan-code-nuwrrrld-portal/
  86df101d-…  ← the signals "Go Deeper" fix (PR #91)
  5ac17b6b-…  ← followed-tickers dashboard (PR #92) — ran `git checkout main`
  6fbdba31-…  ← also on followed-tickers-dashboard
  2034d1ae-…  ← also on followed-tickers-dashboard
```

`git reflog` shows the two workstreams interleaving in one tree:

```
03:25:52  checkout: fix/signals-go-deeper-verdict → feat/followed-tickers-dashboard   ← not me
03:30:18  commit: test(e2e): add auth-boundary, track-record, watchlist specs         ← not me
03:31:49  commit: feat(followed-tickers): dashboard surface                            ← not me
03:38:21  rebase (start/pick/finish) on feat/followed-tickers-dashboard                ← not me
03:42:37  checkout: feat/followed-tickers-dashboard → docs/clerk-dev-handshake-incident ← me
03:43:39  commit: docs(wiki): ingest PR #92                                            ← not me (on MY branch)
03:47:41  commit: docs(wiki): record the Clerk dev-instance handshake redirect loop    ← me
03:49:03  checkout: feat/followed-tickers-dashboard → main                             ← not me
03:49:05  pull --ff-only origin main: Fast-forward                                     ← not me
03:49:49  checkout: main → followup/ft-dashboard-done                                  ← not me
```

## The three concrete failures this caused

### 1. A branch name was reassigned to another session's commit

I created `docs/clerk-dev-handshake-incident` and committed `05496f8` to it. The
other session, working in the same tree, committed `a68b4d0` ("ingest PR #92")
onto that same branch name and pushed it. The remote now holds:

```
$ git log --oneline -1 origin/docs/clerk-dev-handshake-incident
a68b4d0 docs(wiki): ingest PR #92 — followed-tickers scoreboard now user-facing
```

My commit was still reachable as a loose object, so it was recovered onto a
differently-named branch (`docs/clerk-handshake-incident-page` → PR #93). Had I
trusted `git push` reporting *"Everything up-to-date"* — which it did, because
the *name* was up to date — the work would have looked pushed and been absent.

### 2. `git push` and `git branch --show-current` returned stale answers

Standard verification lies here. After a push I ran:

```
$ git push -u origin docs/clerk-dev-handshake-incident
Everything up-to-date                       # true of the name, false of my commit
$ git branch --show-current
feat/followed-tickers-dashboard             # ← another session had moved the tree
```

Reading `git status` / `git branch` and acting on it is only valid if no other
session touches the tree between the read and the act. That guarantee does not
exist here.

### 3. An untracked file was deleted

Running `git restore` with an under-scoped pathspec removed the untracked
`incident-2026-08-31-clerk-dev-handshake-redirect-loop.md`. That was my error,
not a concurrency bug — but concurrency is what put an unexpected mix of dirty
files in the tree that the command was written against. It was recovered from
`stash@{0}`, where a hook's auto-stash had captured it.

## Why the existing guardrails did not catch it

The whole `no-conflicts1` / `multi-branch-optimization` / `stay-on-branch-after-merge`
rule set assumes **one agent, one tree, many branches.** Its model of a conflict
is *"the same file edited on two branches."* Every check it runs — open-PR
lookup, behind-count, overlapping-files-with-other-PRs — reads repo state at a
point in time and assumes that state holds until the next check.

Concurrent sessions break that assumption at a lower level than any of those
rules operate. Two sessions on the *same* branch in the *same* tree never
produce a merge conflict; they produce interleaved commits and a working tree
that changes without either one acting.

`no-conflicts-guard.mjs` additionally caches PR state on disk (~60s TTL), and
its own docs note that **a cached negative is silent** — indistinguishable from
"no conflicts." Under concurrency that window is long enough for another
session to create, move, or push a branch.

## What to do

### The real fix: one tree per session

`git worktree` gives each session its own checkout against the shared object
store. This is exactly the case `multi-branch-optimization` §1 already
recommends worktrees for; it just hadn't been applied to *concurrent agents*,
only to one agent juggling branches.

```bash
git -C ~/code/nuwrrrld-portal worktree add ../portal-signals-fix -b fix/… origin/main
git -C ~/code/nuwrrrld-portal worktree list
git -C ~/code/nuwrrrld-portal worktree remove ../portal-signals-fix   # after merge
```

Branch checkouts then cannot collide: git refuses to check out one branch in two
worktrees, which converts today's silent clobber into a loud error.

### Until then, working defensively in a shared tree

- **Re-read `git branch --show-current` after every git command**, not once at
  the start. Treat it as volatile.
- **Verify a push landed by commit, never by the push's own output:**
  `git log --oneline -1 origin/<branch>` and check the SHA is yours.
- **Use a distinctive branch name** (include the feature, not just the topic) so
  two sessions are less likely to pick the same one.
- **Never use a bare `git restore` / `git checkout --` without explicit paths.**
  Scope every destructive command to the exact files you intend.
- **Prefer `git -C <abs-path>`** over `cd` — `cd` does not persist between tool
  calls anyway, and an absolute path is unambiguous about which tree is meant.

### Open question

Is running several sessions on one repo intentional? If so, worktrees should be
the default setup rather than a remedy. If it was accidental — three sessions
all landed on `feat/followed-tickers-dashboard` — the more useful fix may be
noticing and warning about it at session start, which no current hook does.

## See also

- `~/.claude/rules/multi-branch-optimization.md` — §1 already argues for
  worktrees; this is the concurrent-agent case it does not yet cover
- `~/.claude/rules/no-conflicts1.md` — its cached-negative caveat is worse under
  concurrency
- `~/.claude/rules/stay-on-branch-after-merge.md` — the `git checkout main`
  hazard, here triggered by *another* session
- `docs/wiki-portal/incident-2026-08-06-bugmerge1-command-file-loss.md` — same
  failure class (work lost to a branch switch), single-session variant
- `docs/session-handoff.md` — the session where this surfaced
