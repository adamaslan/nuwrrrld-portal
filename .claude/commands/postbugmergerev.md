# /postbugmergerev — Post-/bugmerge1 Review, Improve, PR & Wiki Sync

After `/bugmerge1` has run (with the git-mechanical steps delegated to Haiku),
this command uses a **stronger model (Opus or Sonnet)** to review what Haiku
actually merged into `main`, improve any fixes that were mechanical-but-shallow,
and ship the improvements as a **new PR** — then merge it and sync the wiki the
usual way.

Web portal only (`adamaslan/nuwrrrld-portal`). For a change that also touches the
mobile app, hand off to `/sync-pr` instead of merging here.

## Why this exists

`/bugmerge1` routes deterministic plumbing (checkout, rebase, build, merge)
through a cheap fast model. That's safe for plumbing but means the *fixes*
Haiku committed to satisfy review comments were written without deep code
reasoning. This command is the second pass: a high-capability model re-reads
those merged fixes and upgrades them where a shallow patch slipped through —
so cost savings from Haiku don't quietly become quality debt on `main`.

## Preconditions

- Run this **only after** `/bugmerge1` has merged at least one PR this session.
- You know which PRs were merged (from the `/bugmerge1` step 5 report) — you'll
  scope the review to exactly those commits, not all of `main`'s history.
- Start from a clean, up-to-date `main`.

## Guardrails (do NOT skip)

- **Review model must be Opus or Sonnet**, never Haiku — the whole point is a
  higher-capability second opinion. If the current model is Haiku, stop and
  tell the user to switch (`/model opus`) before continuing.
- **Never** blind-commit. Every improvement must build (`npm run build`) and
  pass the `/pr` Security Checklist before it goes into a PR.
- **Scope tightly**: only touch code that a merged `/bugmerge1` PR changed, plus
  the minimal blast radius of improving it. This is not a license to refactor
  unrelated files — if you find an unrelated problem, note it in the report,
  don't fix it here.
- If an improvement needs a product decision or changes behavior in a way a
  reviewer should weigh in on, **stop and report** — don't merge it yourself.
- Never force-push over unrelated work; this command creates its own fresh
  branch off `main`.

## Execute

### 1. Identify what /bugmerge1 merged

```bash
git fetch origin main
git checkout main
git pull --ff-only origin main

# The PRs /bugmerge1 just squash-merged (adjust the count/window to match the
# step-5 report — here, the last N merges to main):
git log origin/main --merges --oneline -n 20
# …or, more precisely, list the squash commits by the PR numbers you merged:
for PR in <merged PR numbers>; do
  echo "=== PR #$PR ==="
  gh pr view "$PR" --repo adamaslan/nuwrrrld-portal \
    --json mergeCommit,title,files --jq '{title, sha: .mergeCommit.oid, files: [.files[].path]}'
done
```

### 2. Review each merged fix with the strong model

For each squash commit produced by `/bugmerge1`:

```bash
SHA=<merge/squash sha>
git show "$SHA"                       # the exact diff Haiku committed
```

Read the diff **and the original review comment it was answering** (pull it back
up from the merged PR if needed). For each fix, judge:

- **Correctness** — does the patch actually resolve the reviewer's concern, or
  just silence the symptom (e.g. swallowing an error instead of handling it)?
- **Edge cases** — null/empty/error paths the mechanical fix skipped.
- **Security** — did a quick patch introduce a leak (secret in a
  `NEXT_PUBLIC_*`, backend URL client-side, unvalidated input)?
- **Style/altitude** — does it match surrounding conventions, or is it a
  drive-by that reads as bolted-on?

Keep a running list: `{file, what Haiku did, why it's shallow, the improvement}`.
Fixes that are already correct need **no change** — say so in the report and move
on. Do not churn code just to leave a fingerprint.

### 3. Apply improvements on a fresh branch

```bash
git checkout -b fix/postbugmerge-review-<short-desc>

# Make the improvements (minimal, scoped to the merged fixes).

# Security scan (identical to /pr)
git diff | grep -iE "(PRIVATE|SECRET|TOKEN|PASSWORD|API_KEY|CLERK_SECRET|sk_live)" && {
  echo "⚠️  SECRETS DETECTED - DO NOT COMMIT"; exit 1;
} || echo "✅ No obvious secrets"

# Reject .env files
git status --porcelain | grep -E '\.env($|\.local|\.production)' && {
  echo "❌ .env files present"; exit 1;
} || true

# Build (Next.js 16 — expect "ƒ Proxy (Middleware)")
npm run build

# Stage ONLY specific files — never git add -A
git add <specific files>
git diff --cached --name-only
git commit -m "fix(<scope>): deepen /bugmerge1 review fixes for PR #<n> (<n>…)

Second-pass review (Opus/Sonnet) of fixes merged by /bugmerge1's Haiku
plumbing pass. <one line on what got deepened and why>

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

git push -u origin HEAD
```

### 4. Open the PR

```bash
gh pr create --base main \
  --title "fix: post-/bugmerge1 review improvements (PR #<n>…)" \
  --body "## Summary

Second-pass review of the fixes /bugmerge1 merged via its Haiku plumbing pass.
Reviewed with <Opus|Sonnet>; deepened the fixes below where the mechanical
patch was shallow.

## Improvements
- <file>: <what Haiku did> → <what this PR does instead, and why>
- …

## Fixes reviewed and left as-is (already correct)
- <file / PR #>: <one line>

## Security Verification
- [x] No .env files committed
- [x] No keys / tokens / secrets in NEXT_PUBLIC_*
- [x] Backend URLs resolved server-side (not NEXT_PUBLIC_)

## Test Plan
- [ ] \`npm run build\` passes (\"ƒ Proxy (Middleware)\" present)
- [ ] The original review comments that /bugmerge1 answered are still satisfied
- [ ] No regressions in the touched routes

🔒 Security verified before commit"
```

> ⚠️ Opening a PR here fires the global wiki-guard hook on `gh pr create`.
> Make sure any wiki edits from step 6 are committed **on this branch before**
> you run `gh pr create`, so they land in the same PR — the recurring failure
> the guard exists to catch is wiki content left uncommitted and never shipped
> with the PR it documents.

### 5. Merge conflict-free

```bash
gh pr view <this PR> --repo adamaslan/nuwrrrld-portal --json mergeable,mergeStateStatus
gh pr merge <this PR> --repo adamaslan/nuwrrrld-portal --squash --delete-branch
```

If `mergeable` is not clean, rebase onto the current `main`
(`git fetch origin main && git rebase origin/main`), rebuild, and re-check —
same conflict discipline as `/bugmerge1` (mechanical only; semantic → stop).

### 6. Update the wiki (before step 4's `gh pr create`, committed on this branch)

If any improvement changed behavior tracked by `docs/wiki-portal/`, run the wiki
ingest per that folder's `SCHEMA.md`:
- Update the affected `entity-*` / `concept-*` / `decision-*` pages.
- Update `index.md` if pages were added.
- Append one line to `log.md`:
  `## [{date}] ingest | PR #{number} post-/bugmerge1 review | pages touched: N`
- If this session changed anything in the mobile↔web parity surface, recompute
  the parity pages in **both** wikis per `~/.claude/rules/mobile-web-wiki-sync.md`.

Never write real keys/tokens/URLs into wiki pages — use the SCHEMA placeholders.

### 7. Report

Summarize: which merged fixes were deepened (and why they were shallow), which
were confirmed correct and left alone, the new PR number, its merge status, and
the wiki pages touched.

## See also

- `/bugmerge1` — the first pass this reviews; its Haiku delegation section
  explains which steps run cheap and why the fixes need a second look.
- `docs/wiki-portal/incident-2026-08-06-bugmerge1-command-file-loss.md` — why
  `/bugmerge1` protects its own definition file during git plumbing.
