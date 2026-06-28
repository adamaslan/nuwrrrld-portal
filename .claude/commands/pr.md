# /pr — Create Branch, Commit, and PR (web portal)

Branches the current changes, scans for secrets, commits, pushes, and opens a PR
against `main` for **this repo only** (`adamaslan/nuwrrrld-portal`). For a change
that also touches the mobile app, use `/sync-pr` instead.

## Security Checklist — scan BEFORE committing

Never commit:
- ❌ `.env`, `.env.local`, `.env.production`, `.env.*.local`
- ❌ `*.pem`, `*.key`, `*.p8`, `*.p12`, private keys, tokens
- ❌ `.claude/settings.local.json`, `node_modules/`, `.next/`, `.vercel/`

Reject these patterns in the diff:
- `PRIVATE_KEY`, `SECRET_KEY`, `API_KEY`, `TOKEN`, `PASSWORD`
- `sk_test_*`, `sk_live_*`, `CLERK_SECRET_KEY`
- Any secret value placed in a `NEXT_PUBLIC_*` var (public → leaks to the bundle)
- Backend URLs in `NEXT_PUBLIC_*` (must stay server-side; use non-public vars)

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

# 4. Verify the build (Next.js 16 — expect "ƒ Proxy (Middleware)")
npm run build

# 5. Branch (descriptive; same name as the mobile branch if this is a pair)
git checkout -b <feat/scope-description>

# 6. Stage ONLY specific safe files (never blind `git add -A`)
git add <specific files>
git diff --cached --name-only        # review before commit

# 7. Commit (conventional)
git commit -m "type(scope): description

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"

# 8. Push
git push -u origin HEAD

# 9. Open PR
gh pr create --base main --title "feat/fix: short description" --body "## Summary

Brief description of changes.

## Security Verification
- [x] No .env files committed
- [x] No keys / tokens / secrets in NEXT_PUBLIC_*
- [x] Backend URLs resolved server-side (not NEXT_PUBLIC_)

## Test Plan
- [ ] \`npm run build\` passes (\"ƒ Proxy (Middleware)\" present)
- [ ] Auth gate works (/dashboard requires sign-in)
- [ ] No regressions in related routes

🔒 Security verified before commit"
```

Analyze the actual changes: scan for secrets, build, generate a branch name (match
the mobile branch if part of a pair), stage only safe files, write a clear message,
attest security in the PR body.
