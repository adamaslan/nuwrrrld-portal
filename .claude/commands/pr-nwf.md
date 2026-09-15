# /pr — Create Branch, Commit, and PR (web portal)

Branches the current changes, scans for secrets, commits, pushes, and opens a PR
against `main` for **this repo only** (`adamaslan/nuwrrrld-portal`). For a change
that also touches the mobile app, use `/sync-pr` instead.

## 0. Orient (wiki-led dev — before you change or commit)

Read `docs/wiki-portal/START-HERE.md` and let it route you to the entity/concept
pages for the files this change touches. Opening a PR here fires the wiki-guard
hook on `gh pr create`, which expects the wiki reconciled — so orient first, and
plan to **ingest** the change per `docs/wiki-portal/SCHEMA.md` "On PR Creation"
(update affected pages, `index.md`, append a `log.md` line) before finishing.
See [[concept-wiki-led-development]] for the full loop.

## 0.4 Ownership — decide what is YOURS before anything else

**A dirty working tree is not a changelist.** Another Claude session, or your
own earlier unit, may own files here. Establishing that boundary is the first
step, not an afterthought — getting it wrong is destructive, not merely untidy.

> This step exists because its absence cost real work. On 2026-09-14 a session
> read the whole dirty tree as "my change", hit a build error in files it had
> never written, and ran `git checkout -- <13 paths>` to make the build pass.
> Those paths were another session's in-flight work. See
> `docs/model-handoff-hygiene.md`.

```bash
# Everything dirty in this tree — NOT the same as "your change"
git status --porcelain

# What this session actually wrote (the guard records it per session)
node ~/.claude/scripts/worktree-guard.mjs --report
```

Write down an explicit **OWNED** list before staging. Then:

- **Stage only OWNED paths, by name.** Never `git add -A`, `git add .`, or
  `git commit -a`.
- **Never "clean up" a file you did not write** to make a build or test pass.
  If a foreign file breaks the build, **STOP and report it.** That is a signal
  another session is mid-edit — not a defect for you to resolve.
- If you cannot tell who owns a dirty file, treat it as foreign. The cost of
  leaving a stale file alone is a red build; the cost of discarding a live one
  is unrecoverable.
- If foreign work blocks you and must be moved, **preserve, never discard**:
  `git stash push -u -m "foreign-work-preserved-<date>" -- <paths>` or commit it
  to a `salvage/<what>-<date>` branch, and name every ref you created in your
  final report.

## Pre-PR Conflict Guard — clear the queue FIRST

Before branching, check whether open PRs already touch the files you're about
to change. If they do, opening a new PR now risks landing merge conflicts.

Don't hand-roll this — `no-conflicts1` already computes it, with a disk cache
so it stays cheap and a real `gh`-capability probe rather than `gh auth status`
(which false-negatives when *any* configured account has a stale token):

```bash
node ~/.claude/scripts/no-conflicts-guard.mjs --report   # behind-count, divergence,
                                                         # open PR for this branch,
                                                         # files overlapping other PRs
node ~/.claude/scripts/no-conflicts-guard.mjs --clear-cache   # if it looks stale
```

Two things that report tells you, both load-bearing:

1. **Does this branch already have an open PR?** If it does and this is new
   work, cut a fresh branch from `origin/main` (per `no-conflicts1`). If the
   PR is **merged**, the branch is stale — also cut a fresh one.
2. **Which files overlap another open PR?** That overlap doubles as an
   *ownership* signal: a dirty file that appears in someone else's open PR is
   almost certainly not yours to stage or revert.

**Silence is not proof of safety.** The guard caches PR state (~60s) and stays
quiet when `gh` is offline or rate-limited. When the answer actually matters,
verify directly with `gh pr view` / `gh pr list`.

**If the overlap is non-empty**, run **`/bugmerge1`** first: it scans the open
PRs, fixes the bugs their review comments describe, and merges them
conflict-free (rebasing each onto the latest `main`). Once the queue is drained,
`git fetch origin main && git rebase origin/main` (or re-branch off fresh
`main`), then continue below. This avoids opening a PR that would collide with
work already in flight.

## Security Checklist — scan BEFORE committing

Never commit:
- ❌ `.env`, `.env.local`, `.env.production`, `.env.*.local`
- ❌ `*.pem`, `*.key`, `*.p8`, `*.p12`, private keys, tokens
- ❌ `.claude/settings.local.json`, `node_modules/`, `.next/`, `.vercel/`
- ❌ `test-results/`, `playwright-report/`, `blob-report/`, `playwright/.auth/`,
  `.nulogdash/` — all git-ignored already, but a forced `git add -f` or a
  changed `.gitignore` can slip one in. Playwright traces embed request
  headers (`Authorization: Bearer <key>`) and `playwright/.auth/user.json` is
  a live Clerk session — either is a worse leak than a bare env var, because
  it's a *usable* credential, not just a name.

Reject these patterns in the diff:
- `PRIVATE_KEY`, `SECRET_KEY`, `API_KEY`, `TOKEN`, `PASSWORD`
- `sk_test_*`, `sk_live_*`, `sk-ant-*`, `sk-or-v1-*`, `CLERK_SECRET_KEY`
- Any secret value placed in a `NEXT_PUBLIC_*` var (public → leaks to the bundle)
- Backend URLs in `NEXT_PUBLIC_*` (must stay server-side; use non-public vars)
- `E2E_CLERK_TEST_EMAIL` / `E2E_CLERK_TEST_PASSWORD` values — these belong in
  `.env.local` and repo secrets only, never in a spec file, fixture, or commit
  message. Grepping for the *literal* var name in a diff is fine; a real
  email/password string next to it is not.

## Execute

```bash
# 1. Show current state
git status
git diff

# 2. CRITICAL: scan for secrets before staging
echo "🔍 Scanning for secrets..."
git diff | grep -iE "(PRIVATE|SECRET|TOKEN|PASSWORD|API_KEY|CLERK_SECRET|sk_live)" && {
  echo "⚠️  SECRETS DETECTED - DO NOT COMMIT"; exit 1;
} || echo "✅ No obvious secrets in diff"

# 3. Reject staged/added .env files
git status --porcelain | grep -E '\.env($|\.local|\.production)' && {
  echo "❌ .env files present - add to .gitignore"; exit 1;
} || true

# 3b. Reject staged Playwright/nulogdash artifacts even if .gitignore was
#     bypassed (git add -f, a rewritten .gitignore, etc.) — these can carry
#     live bearer tokens (traces), an active Clerk session
#     (playwright/.auth/), or an unredacted DB URL / test-user email
#     (.nulogdash/, see scripts/nulogdash-merge-e2e.mjs's redaction set).
git status --porcelain | grep -E '(^|/)(test-results|playwright-report|blob-report|\.nulogdash)/|playwright/\.auth/' && {
  echo "❌ Playwright/nulogdash artifacts staged - traces/sessions/reports must never be committed"; exit 1;
} || true

# 4. Verify the build (Next.js 16 — expect "ƒ Proxy (Middleware)")
npm run build

# 4b. If this change touches e2e/, playwright.config.ts, or a fault-injection
#     target's markup (class names / roles the specs assert on), run the
#     relevant tier before opening the PR. Don't run the full suite blind —
#     `frontend`/`auth-setup` need E2E_CLERK_TEST_EMAIL/PASSWORD configured
#     (see playwright-todo.md blocker #2); skip straight to `preflight`/`ci`
#     if those aren't set locally.
git diff --name-only origin/main... | grep -qE '^(e2e/|playwright\.config\.ts$)' && {
  echo "🎭 e2e/ changed — running the affected Playwright tier(s)"
  npx playwright test --list                      # confirms the suite still discovers cleanly
  npx playwright test --project=preflight --project=ci   # no Clerk session required
  # If E2E_CLERK_TEST_EMAIL/PASSWORD are set in .env.local, also run:
  #   npx playwright test --project=frontend
} || true

# 4c. Same reasoning as 4b, but for the case 4b's grep can't see: a component
#     a fault-injection spec targets changed, while e2e/ itself did not. Build
#     the route list from e2e/frontend/*.spec.ts's own page.goto() calls
#     (best-effort — catches the current three dashboard routes; a spec added
#     without a literal page.goto("/dashboard/...") string won't be caught)
#     and diff against each route's app/ directory.
grep -rhoE 'page\.goto\("(/dashboard/[a-z-]+)"' e2e/frontend/*.spec.ts 2>/dev/null \
  | grep -oE '/dashboard/[a-z-]+' | sort -u | while IFS= read -r route; do
  dir="app${route}"
  if git diff --name-only origin/main... | grep -q "^${dir}/"; then
    echo "🎭 ${dir} changed and is targeted by a fault-injection spec (goto(\"${route}\")) — selectors may be stale"
    npx playwright test --list | grep -F "${route#/dashboard/}" || true
  fi
done

# 5. Branch (descriptive; same name as the mobile branch if this is a pair).
#    Branch off origin/main — never off a checked-out local main, which can
#    clobber newer work (~/.claude/rules/stay-on-branch-after-merge.md).
#
#    The branch name lands in merge history permanently. Reject throwaway
#    names — temp*, tmp*, test*, wip*, fix1, my-branch. On 2026-09-14 a real
#    fix merged as `temp-entitlement-fix`. Name it for the surface it owns.
git fetch origin main
git checkout -b <feat/scope-description> origin/main

# 6. Stage ONLY the OWNED paths from step 0.4 (never blind `git add -A`)
git add <specific files>
git diff --cached --name-only        # review before commit — is every path yours?

# 7. Commit (conventional)
git commit -m "type(scope): description

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

# 8. Push
git push -u origin HEAD

# 8b. Record verification EVIDENCE — run this before writing the PR body.
#     Each line's [x] comes from a real exit code, not from intent. Anything
#     you did not run renders as NOT RUN and must stay that way.
#
#     Why: on 2026-09-14 a PR shipped with "build succeeds / 704 tests pass /
#     drift gate passes" all check-marked. The build had just FAILED, the tests
#     were never run on that branch, and the drift check was never invoked —
#     the numbers were carried over from a different branch. A box that cannot
#     be ticked without evidence cannot be fabricated.
# `git rev-parse --git-dir`, not a literal `.git/` — inside a worktree `.git`
# is a FILE, not a directory, and the literal path fails there. Worktrees are
# the recommended setup when another session is live, so this matters.
VERIFY_OUT="$(git rev-parse --git-dir)/claude-verify.md"
: > "$VERIFY_OUT"
record() {   # record "<label>" "<command>"
  local label="$1" cmd="$2" rc
  # Subshell + explicit capture: `$?` read inside an else-branch is unreliable,
  # and a bare `eval` of a command that exits would kill this shell.
  ( eval "$cmd" ) >/dev/null 2>&1; rc=$?
  if [ "$rc" -eq 0 ]; then
    printf -- '- [x] `%s` — %s (exit 0, %s)\n' "$cmd" "$label" "$(date -u +%Y-%m-%dT%H:%MZ)" >> "$VERIFY_OUT"
  else
    printf -- '- [ ] `%s` — %s (**FAILED**, exit %d)\n' "$cmd" "$label" "$rc" >> "$VERIFY_OUT"
  fi
}
record "production build"   "npm run build"
record "unit + components"  "npm test"
record "shared-drift gate"  "node scripts/check-shared-drift.mjs"
cat "$VERIFY_OUT"           # paste THIS into the PR body verbatim

# 9. Open PR — Test Plan is the recorded output above, not a fresh assertion.
gh pr create --base main --title "feat/fix: short description" --body "## Summary

Brief description of changes.

## Security Verification
- [ ] No .env files committed
- [ ] No keys / tokens / secrets in NEXT_PUBLIC_*
- [ ] Backend URLs resolved server-side (not NEXT_PUBLIC_)
- [ ] No Playwright/nulogdash artifacts staged (test-results/, playwright-report/, blob-report/, playwright/.auth/, .nulogdash/)

<!-- Tick each box above ONLY after running the step-2/3/3b scan that proves it.
     They ship unchecked on purpose: a pre-checked template is a fabricated
     claim waiting to be copied. -->

## Test Plan
<!-- Paste the recorder output from step 8b verbatim. Do not hand-write
     these lines, and do not tick a box the recorder left unticked. -->
- [ ] Auth gate works (/dashboard requires sign-in)
- [ ] No regressions in related routes

## Playwright (only if e2e/, playwright.config.ts, or a tested component's markup changed — delete this section otherwise)
- [ ] \`npx playwright test --list\` still discovers every spec (catches a broken project graph / dependency chain)
- [ ] \`preflight\` + \`ci\` tiers pass locally (no Clerk session needed)
- [ ] \`frontend\` tier run locally if E2E_CLERK_TEST_EMAIL/PASSWORD are configured; otherwise noted as untested here
- [ ] If a spec's target component/route changed, its selectors were re-verified against the new markup, not assumed still valid

🔒 Security verified before commit"
```

Analyze the actual changes: scan for secrets, build, generate a branch name (match
the mobile branch if part of a pair), stage only safe files, write a clear message,
attest security in the PR body.

## After the PR merges — stay on the branch

Do **not** `git checkout main` after merging. Staying on the current branch (or
branching the next change off `origin/main`) keeps the newest work on disk; a
checkout of local `main` can silently replace it with an older squash-merged
version — see `~/.claude/rules/stay-on-branch-after-merge.md`. To advance local
`main`, fast-forward the ref without checking it out: `git fetch origin main:main`.
