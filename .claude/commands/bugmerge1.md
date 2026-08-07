# /bugmerge1 — Scan PRs, Fix Comment Bugs, Merge Conflict-Free

Sweeps the **open PRs** for `adamaslan/nuwrrrld-portal`, reads their review
comments, fixes the bugs those comments call out, then merges each PR in an
order and manner that avoids merge conflicts. Use this before opening a *new*
PR whose changes might collide with work already in flight — clear the queue
first, then branch the next change off `origin/main` (not a checked-out local
`main` — see `~/.claude/rules/stay-on-branch-after-merge.md`).

Web portal only. For a change that also touches the mobile app, coordinate via
`/sync-pr` after the queue is clear.

## When to run

- There are open PRs with unresolved review comments.
- You are about to start a change that overlaps files already touched by an
  open PR (see the pre-PR guard in `/pr`).
- You want the merge queue drained cleanly with no conflict markers landing on
  `main`.

## Guardrails (do NOT skip)

- **Never** blind-merge. Every PR must build (`npm run build`) and pass its
  security scan (same checklist as `/pr`) after fixes.
- **Never** commit secrets — reuse the `/pr` Security Checklist verbatim on
  each fix commit.
- **Never** force-push over someone else's branch without confirming it's your
  own work in flight.
- If a conflict cannot be resolved mechanically (semantic conflict, or the fix
  needs a product decision), **stop and report** — do not guess.
- Merge one PR at a time and re-sync the rest; do not batch-merge.
- **Pre-flight backup (once, before step 1)**: copy this file out of the git
  tree entirely so no branch operation can touch it —
  ```bash
  BUGMERGE1_BAK=/tmp/bugmerge1.$(date +%s).bak
  cp .claude/commands/bugmerge1.md "$BUGMERGE1_BAK"
  ```
  Export `BUGMERGE1_BAK` so it is available throughout the session.
- **Self-integrity check (before step 1 and after every checkout/rebase in
  step 2)**: verify `.claude/commands/bugmerge1.md` still exists on disk. This
  file has been lost mid-run before (see
  `docs/wiki-portal/incident-2026-08-06-bugmerge1-command-file-loss.md`) —
  branch checkouts and `git stash -u` can drop it if it was untracked on the
  checked-out branch. If it is missing, attempt restore in order:
  ```bash
  if ! test -f .claude/commands/bugmerge1.md; then
    git show origin/main:.claude/commands/bugmerge1.md \
      > .claude/commands/bugmerge1.md 2>/dev/null \
    || git show main:.claude/commands/bugmerge1.md \
      > .claude/commands/bugmerge1.md 2>/dev/null \
    || cp "$BUGMERGE1_BAK" .claude/commands/bugmerge1.md 2>/dev/null \
    || { echo "❌ FATAL: bugmerge1.md unrecoverable — aborting"; exit 1; }
    echo "✅ bugmerge1.md restored"
  fi
  ```
  Do not proceed while the file is missing — there is no safe fallback.
- Prefer `git stash -u -- <specific paths>` (pathspec-scoped) over a bare
  `git stash -u` when you must stash untracked changes mid-workflow — a bare
  `-u` sweeps every untracked file in the tree, including unrelated command
  definitions.
- **Don't return to `main` after a merge.** After each `gh pr merge`, stay on
  the current branch or branch the next PR off `origin/main` — never
  `git checkout main` into a tree with newer work, which can clobber it with an
  older squash-merged version. To advance local `main`, fast-forward the ref
  only: `git fetch origin main:main`. (Global rule:
  `~/.claude/rules/stay-on-branch-after-merge.md`; a `checkout-guard` PreToolUse
  hook also warns + backs up if a risky checkout slips through.)

## Execute

### 1. Enumerate open PRs, oldest first (merge order = base-first)

```bash
gh pr list --repo adamaslan/nuwrrrld-portal --state open --limit 1000 \
  --json number,title,headRefName,baseRefName,mergeable,updatedAt \
  --jq 'sort_by(.updatedAt)'
```

Merge in the order that minimizes churn: PRs whose base is `main` and that
touch the fewest shared files go first. Identify overlap up front:

```bash
# Files each open PR changes — spot overlaps before touching anything
for pr in $(gh pr list --repo adamaslan/nuwrrrld-portal --state open --limit 1000 --json number --jq '.[].number'); do
  echo "=== PR #$pr ==="
  gh pr diff "$pr" --repo adamaslan/nuwrrrld-portal --name-only
done
```

### 2. For EACH PR, in the chosen order

```bash
PR=<number>

# 2a. Read review + inline comments (the bug reports)
gh pr view "$PR" --repo adamaslan/nuwrrrld-portal --comments
gh api --paginate "repos/adamaslan/nuwrrrld-portal/pulls/$PR/comments?per_page=100" \
  --jq '.[] | {path, line, body}'

# 2b. Check out the PR branch locally
gh pr checkout "$PR" --repo adamaslan/nuwrrrld-portal

# 2c. Rebase onto latest main FIRST so the branch is conflict-free before we edit
git fetch origin main
git rebase origin/main
#   ↳ if the rebase conflicts: resolve only mechanical conflicts, run the build,
#     and continue. If a conflict is semantic or ambiguous → STOP and report.
```

Now **fix the bugs** each review comment describes:
- Address each actionable comment (correctness, edge cases, security).
- Skip comments that are questions/nits with no code change — note them in the
  merge summary instead.
- Keep fixes minimal and match surrounding style.

```bash
# 2d. Security scan on the fix diff (identical to /pr)
git diff | grep -iE "(PRIVATE|SECRET|TOKEN|PASSWORD|API_KEY|CLERK_SECRET|sk_live)" && {
  echo "⚠️  SECRETS DETECTED - DO NOT COMMIT"; exit 1;
} || echo "✅ No obvious secrets"

# 2e. Verify the build (Next.js 16 — expect "ƒ Proxy (Middleware)")
npm run build

# 2f. Commit fixes (conventional), stage only specific files — never git add -A
git add <specific files>
git commit -m "fix(<scope>): address PR #$PR review comments

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

# 2g. Push. Because we rebased, this branch needs a lease-guarded force push.
git push --force-with-lease origin HEAD
```

### 3. Merge conflict-free

```bash
# 3a. Confirm GitHub now reports the PR as mergeable (no conflicts)
gh pr view "$PR" --repo adamaslan/nuwrrrld-portal --json mergeable,mergeStateStatus

# 3b. Merge. Squash keeps main linear and avoids re-introducing conflicts.
gh pr merge "$PR" --repo adamaslan/nuwrrrld-portal --squash --delete-branch
```

### 4. Re-sync the remaining queue

After each merge, `main` has moved. Before touching the next PR, go back to
step 2c and rebase it onto the new `main` — this is what keeps every
subsequent merge conflict-free. Re-check `mergeable` for the whole queue:

```bash
gh pr list --repo adamaslan/nuwrrrld-portal --state open \
  --json number,mergeable,mergeStateStatus
```

Repeat 2→4 until the queue is empty (or only PRs needing human decisions
remain).

### 5. Report

Summarize: PRs merged, comments fixed vs. deferred (with reasons), any conflict
that required a human decision, and the final clean `main`.

## Post-merge

If any merged PR changed behavior tracked by `docs/wiki-portal/`, run the wiki
ingest per that folder's `SCHEMA.md` (update affected pages, `index.md`, and
append one `log.md` line per PR) — same rule as `/pr`.

## Using smaller models (Haiku) for the git-mechanical steps

Most of this command is deterministic git/gh plumbing, not judgment calls —
that work is a good fit for a cheaper model like `claude-haiku-4-5-20251001`.
Reserve Opus/Sonnet for the steps that require reading and reasoning about
code. Concretely:

- **Delegate to Haiku** (via a subagent or `--model haiku` on a scoped
  sub-task): step 1 enumeration (`gh pr list`, `gh pr diff --name-only`),
  step 2b/2c mechanical checkout + rebase when no conflicts are reported,
  step 2d secret-grep, step 2e running `npm run build` and reporting
  pass/fail, step 3a/3b merge once `mergeable` is confirmed clean, and step 4
  re-sync polling. These are all "run this command, report the exit
  status/output" tasks with no code comprehension required.
- **Keep on the primary model**: reading and interpreting review comments
  (step 2a), writing the actual bug fixes, judging whether a rebase conflict
  is mechanical vs. semantic, and the final summary/report (step 5). These
  require understanding intent, not just executing commands.
- **Why this split matters here**: the file-loss incident happened during
  mechanical git plumbing (checkout/rebase/stash), not during code-fix
  reasoning — so routing exactly that plumbing through a cheaper, faster
  model doesn't trade away quality, and it shortens the window where a
  self-integrity check (above) needs to catch problems.
- If delegating, have the Haiku sub-task run the self-integrity check
  (`test -f .claude/commands/bugmerge1.md`) as its last action before
  returning control, so file loss is caught at the cheapest possible point
  rather than surfacing later on the primary model's turn.
