# /sync-pr — Update both NuWrrrld apps and open coordinated PRs

Drives a **cross-surface** change across both repos: same branch name in each,
security-scanned commits, a PR per repo against `main`, cross-linked via
`Pairs with:`. For single-surface changes use each repo's `/pr` instead.

**Usage:** `/sync-pr <branch-name> "<short description>"`
e.g. `/sync-pr feat/holdfold-on-web "expose holdfold analysis on web"`

## Repos

| Surface | Path | Repo (gh `--repo`) | Base |
|---|---|---|---|
| Web | `/Users/adamaslan/code/nuwrrrld-portal` | `adamaslan/nuwrrrld-portal` | `main` |
| Mobile | `/Users/adamaslan/code/gcp3-mobile` | `adamaslan/gcp-expo1` | `main` |

Canonical sync rules: `nuwrrrld-portal/docs/sync-howto.md` + `nuwrrrld-fullstack` skill.
Coordination reference: `homebase/dual-pr-howto.md`.

## Rules (must hold)

- **Shared core is canonical in `gcp3-mobile/lib/`** and lands in the **mobile** PR;
  the **mirror** (`nuwrrrld-portal/lib/shared/...`) lands in the **web** PR. They must
  be byte-identical except the base-URL seam — confirm the `diff` guard passed.
- **Never** stage `.env*`, keys, tokens, `sk_live`/`CLERK_SECRET_KEY`, or secrets in
  `EXPO_PUBLIC_*` / `NEXT_PUBLIC_*`. Scan before every commit; abort on a hit.
- **Both PRs or neither.** Don't merge one half — it drifts the mirror.

## Steps

1. **Pre-flight build both** (don't open PRs against a broken build):
   ```bash
   cd /Users/adamaslan/code/nuwrrrld-portal && npm run build      # expect "ƒ Proxy (Middleware)"
   cd /Users/adamaslan/code/gcp3-mobile     && npx tsc --noEmit
   ```
   Run the `diff` drift guard on each shared file; only the base-URL seam may differ.

2. **For each repo** (mobile first — it carries the canonical shared core):
   ```bash
   git -C <repo> status
   git -C <repo> diff | grep -iE "(PRIVATE|SECRET|TOKEN|PASSWORD|API_KEY|CLERK_SECRET|AWS_SECRET|SUPABASE_KEY|sk_live)" \
     && { echo "⚠️  SECRETS DETECTED — abort"; exit 1; } || echo "✅ no obvious secrets"
   git -C <repo> status --porcelain | grep -E '\.env($|\.local)' \
     && { echo "❌ .env present — abort"; exit 1; } || true
   git -C <repo> checkout -b <branch-name>
   git -C <repo> add <specific safe files>      # explicit; never `git add -A` blindly
   git -C <repo> diff --cached --name-only       # review before commit
   git -C <repo> commit -m "<type>(<scope>): <description>

   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
   git -C <repo> push -u origin HEAD
   ```

3. **Open a PR per repo** against `main`:
   ```bash
   gh pr create --repo <repo> --base main --title "<title>" --body "## Summary
   <what changed on this surface>

   Pairs with: <sibling PR url — fill in step 4>

   ## Security
   - [x] No .env / keys / tokens committed
   - [x] (web) backend URL server-side: HOLDFOLD_BACKEND_URL, not NEXT_PUBLIC_
   - [x] shared core ↔ mirror diff guard passed (seam only)"
   ```

4. **Cross-link** once both URLs exist: `gh pr edit <n> --repo <repo> --body ...`
   filling each `Pairs with:` with the sibling URL.

5. **Report both PR URLs** to the user. Do not merge.
