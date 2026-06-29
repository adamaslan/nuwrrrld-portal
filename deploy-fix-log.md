# Deploy Fix Log — financial.nuwrrrld.com

_Last updated: 2026-06-28 · Repo: `adamaslan/nuwrrrld-portal` · Cloudflare account `8d9169bfecfc72d7e3b664406d006540`_

## Symptom
`www.financial.nuwrrrld.com` DNS address could not be found. (Note the `www.` — the configured custom domain is the apex `financial.nuwrrrld.com`; `www.financial...` was never a configured hostname, which is a secondary red herring on top of the real failure below.)

---

## Diagnostic Commands Used
Reproducible steps to confirm the same diagnosis in future:
```bash
dig financial.nuwrrrld.com            # → CNAME to 6970d8bc.nuwrrrld-portal.pages.dev (DNS OK)
dig nuwrrrld.com NS                   # → dion/emerie.ns.cloudflare.com (Cloudflare-managed)
curl -sI https://financial.nuwrrrld.com   # → HTTP/2 404, server: cloudflare (Pages serving nothing)
npx wrangler pages project list                              # confirm project + custom domain binding
npx wrangler pages deployment list --project-name nuwrrrld-portal   # → all recent = Failure
gh run list --repo adamaslan/nuwrrrld-portal --limit 5      # → GHA runs failing
gh run view <run-id> --repo adamaslan/nuwrrrld-portal --log-failed   # exact error
```

---

## Root Cause Diagnosis

**DNS was fine.** `financial.nuwrrrld.com` resolves correctly via Cloudflare to `6970d8bc.nuwrrrld-portal.pages.dev`. The real problem was a **404 from Cloudflare Pages** because every recent deployment to `main` had failed, leaving the custom domain pointed at a stale successful build.

**Why deployments were failing:**

1. **`CLOUDFLARE_API_TOKEN` secret not set** in the GitHub repo. The workflow referenced `secrets.CLOUDFLARE_API_TOKEN` but it was never added → wrangler exited with "In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN."

2. **Wrong deploy directory.** The workflow ran `wrangler pages deploy .next/static` — that's only the CSS/JS bundle, not a runnable app. Cloudflare Pages received an empty/broken deployment.

3. **`@cloudflare/next-on-pages` not installed.** The project had no mechanism to produce the `.vercel/output/static` directory that Cloudflare Pages needs for a full Next.js SSR deploy.

---

## Fixes Applied

### 1. GitHub Secrets
Set both missing secrets via `gh secret set`:
- `CLOUDFLARE_API_TOKEN` — the `CLOUDFLARE_API_KEY_NU1` token from `.env`
- `CLOUDFLARE_ACCOUNT_ID` — `8d9169bfecfc72d7e3b664406d006540` (from `wrangler whoami`)

### 2. Next.js downgrade: 16 → 15
`@cloudflare/next-on-pages` supports up to Next.js 15.5.2 (peer dep). The project was on Next 16. Pinned to `next@^15.5.19` (latest 15.x patch).

### 3. Install `@cloudflare/next-on-pages` + `wrangler`
Added to `devDependencies`:
- `@cloudflare/next-on-pages@^1.13.16`
- `wrangler@^4.105.0`

### 4. `wrangler.toml` updated
Added required fields:
```toml
name = "nuwrrrld-portal"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = ".vercel/output/static"
```

### 5. `package.json` scripts updated
```json
"build": "next build && npx @cloudflare/next-on-pages --skip-build"
"pages:build": "next build && npx @cloudflare/next-on-pages --skip-build"
"pages:deploy": "wrangler pages deploy"
"pages:watch": "wrangler pages dev --compatibility-date=2024-09-23"
```
`--skip-build` avoids the `vercel build` step (which requires Vercel project settings and a supported Node version) and runs only the next-on-pages transform on the already-built `.next` output.

### 6. GitHub Actions workflow fixed
`.github/workflows/deploy-cloudflare.yml` — removed `.next/static` from the deploy command. Wrangler now reads `pages_build_output_dir` from `wrangler.toml`:
```yaml
command: pages deploy --project-name=nuwrrrld-portal
```

### 7. Edge runtime added to all API routes (26 files)
`@cloudflare/next-on-pages` requires all API routes to use the edge runtime. Added `export const runtime = 'edge';` to 25 routes that were missing it, and changed 1 route (`signals/card/route.ts`) from `'nodejs'` to `'edge'`.

**Method used:** `echo -e "export const runtime = 'edge';\n$(cat $f)" > $f`

> ⚠️ **Do not reuse this method.** `echo -e` interprets backslash escapes in the *file contents*, which corrupted `\n` inside string literals (see Issue A). A safe equivalent: `printf '%s\n' "export const runtime = 'edge';" | cat - "$f" > tmp && mv tmp "$f"`, or insert with `sed`/an editor.

> ⚠️ **Edge runtime caveat:** the edge runtime has no Node.js built-ins (`fs`, `crypto` Node API, etc.) and a stricter API surface. Any route doing Node-only work will fail at runtime, not build time. The one route previously pinned to `'nodejs'` (`signals/card`) only does string/SVG work, so the switch is safe — but verify each route's runtime behavior, not just that it compiles.

---

## Issues Introduced During Fix

### A. `echo -e` corrupted `\n` escape sequences
The prepend method expanded `\n` inside file content. Four files had string literals broken:
- `app/api/brief/route.ts` — `.join("\n")` became literal newline
- `app/api/feedback/route.ts` — `.join("\n")` became literal newline
- `app/api/nuai/route.ts` — `.join("\n")` and `.split("\n")` became literal newlines
- `app/api/portfolio/health-ai/route.ts` — `.join("\n")` became literal newline

**Fix:** Binary `bytes.replace(b'.join("\n")', b'.join("\\n")')` and `re.sub(rb'(")\n(")', ...)` to restore proper escape sequences.

### B. `store` exported from a Next.js route (invalid)
`app/api/portfolio/watchlist/route.ts` exported a `Map` called `store` so the `[ticker]` sub-route could share it. Next.js 15 route validation rejects non-HTTP exports.

**Fix:** Created `lib/watchlist-store.ts` and updated 4 import sites:
- `app/api/portfolio/watchlist/route.ts`
- `app/api/portfolio/watchlist/[ticker]/route.ts`
- `app/api/portfolio/health-ai/route.ts`
- `app/dashboard/portfolio/page.tsx`

> ⚠️ **Functional caveat:** this `Map` is **per-isolate in-memory state**. On Cloudflare's edge it does *not* persist across requests reliably — each request may hit a different isolate, and isolates are evicted freely. The watchlist will appear to lose data. This was already true with module-level state in Node, but the edge makes it worse. Flagged as pre-launch tech debt — replace with D1/KV/Neon before relying on it. Same applies to Issue C's cache.

### C. `globalDigestCache` exported from a route (invalid)
Same issue: `app/api/signals/refresh/route.ts` exported `globalDigestCache` for `signals/digest` to share.

**Fix:** Created `lib/digest-cache.ts` and updated 2 import sites:
- `app/api/signals/refresh/route.ts`
- `app/api/signals/digest/route.ts`

### D. ESLint config broken after eslint-config-next upgrade
`eslint.config.mjs` used `...nextVitals` and `...nextTs` spread, but `eslint-config-next` exports CommonJS `module.exports` objects, not flat config arrays — not iterable.

**Fix:** Rewrote to use `FlatCompat` from `@eslint/eslintrc`:
```js
const compat = new FlatCompat({ baseDirectory: __dirname });
export default [...compat.extends("next/core-web-vitals", "next/typescript")];
```
Added `@eslint/eslintrc` to `devDependencies`.

---

## Current Status
Build was interrupted before confirming a clean compile. The last `npm run build` run was reaching the ESLint/type-check stage (past webpack compile) before being stopped. Outstanding: confirm full build passes, then push to trigger GHA deploy.

## Remaining Risks / Open Items
- **Build not yet verified green.** Re-run `npm run build` locally to confirm webpack + lint + type-check all pass before pushing.
- **Token scope unconfirmed.** `CLOUDFLARE_API_KEY_NU1` was set up for DNS; it returned `[]` for account-level reads. Confirm it has **Pages:Edit** (Account → Cloudflare Pages → Edit) or the GHA deploy step will still fail with a 403/auth error even though the secret exists.
- **`nodejs_compat` flag** is set in `wrangler.toml` but not necessarily in the Pages project dashboard settings. If routes use Node polyfills, also enable the compat flag in the Pages project's runtime settings.
- **Multiple lockfiles warning.** Next detected `/Users/adamaslan/package-lock.json` as the workspace root. Set `outputFileTracingRoot` in `next.config.ts` or remove the stray lockfile to avoid build ambiguity.
- **In-memory state on edge** (watchlist `store`, `globalDigestCache`) — see Issues B/C caveats; pre-launch tech debt.

## Verification Steps (post-deploy)
```bash
# 1. confirm GHA run is green
gh run list --repo adamaslan/nuwrrrld-portal --limit 3

# 2. confirm a fresh successful Pages deployment exists
npx wrangler pages deployment list --project-name nuwrrrld-portal | head

# 3. confirm the live site returns 200, not 404
curl -sI https://financial.nuwrrrld.com | head -1   # expect HTTP/2 200

# 4. spot-check an API route actually runs on edge
curl -s https://financial.nuwrrrld.com/api/health
```

## Rollback
If the new deploy is worse than the stale-but-working `6970d8bc` build:
```bash
# re-point the custom domain / promote the last known-good deployment from the dashboard:
# Cloudflare Dashboard → Pages → nuwrrrld-portal → Deployments → 6970d8bc → "Rollback to this deployment"
```
Code-side: `git revert` the deploy-fix commit, or `git checkout main -- <file>` for individual files. No destructive history rewrite needed.

---

## 10 Best Practices: Deploying a Next.js App on Cloudflare

> Distilled from this incident plus current Cloudflare/Next.js guidance. Cloudflare is moving toward **OpenNext (`@opennextjs/cloudflare`)** as the recommended adapter; `@cloudflare/next-on-pages` (used here) still works but is in maintenance. Re-check the active adapter before a fresh setup.

1. **Match the adapter to your Next.js version *before* upgrading.** `@cloudflare/next-on-pages` caps at Next 15.5.2; Next 16 broke our build. Pin Next to a version the adapter supports, or migrate to OpenNext, rather than chasing the newest Next release. Treat the adapter's supported-version range as a hard constraint.

2. **Every server route needs `export const runtime = 'edge'`** when using `next-on-pages`. The edge runtime has **no Node.js built-ins** (`fs`, native `crypto`, raw TCP) — code that compiles can still fail at request time. Audit each route's actual dependencies, don't just bulk-add the export. (OpenNext relaxes this with a Node-compat layer, another reason to evaluate it.)

3. **Never put non-HTTP exports in a route file.** A Next.js App Router route may only export HTTP handlers (`GET`/`POST`/…) and config (`runtime`, `dynamic`, etc.). Shared state like a `Map` or cache must live in a `lib/` module and be imported — exporting it from the route fails build validation (Issues B & C above).

4. **Don't rely on in-memory state on the edge.** Module-level `Map`s, caches, and counters do **not** persist across isolates and are evicted freely. Use a real binding — **D1** (SQL), **KV** (cache/config), **R2** (objects), or **Durable Objects** (coordinated state) — for anything that must survive between requests.

5. **`wrangler.toml`/`wrangler.jsonc` is the source of truth, and prefer JSONC.** Newer Cloudflare features are JSON-only. Commit it, set a recent `compatibility_date` (within ~30 days, refresh quarterly), and include `compatibility_flags = ["nodejs_compat"]` if any code touches Node APIs. Set `pages_build_output_dir` so `wrangler pages deploy` needs no directory argument.

6. **Verify token *scope*, not just token presence.** Our DNS-scoped token existed but couldn't read the account or deploy Pages. CI secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) must carry **Pages:Edit** (plus any binding scopes). A present-but-underscoped token fails with auth errors that look like missing secrets.

7. **Manage secrets securely — never echo them.** Set them with `wrangler secret put` (interactive), `wrangler secret bulk` (from an uncommitted JSON file), or `gh secret set` reading from a file. Keep local secrets in `.dev.vars` / `.env.local`, both git-ignored. Never pass a secret as a CLI argument or interpolate it inline.

8. **Validate the build in CI before it can poison production.** A custom domain points at the last *successful* deployment, so silent CI failures leave a stale site serving 404s for the *new* routes. Gate deploys on `next build` + `wrangler pages deploy --dry-run` (or `wrangler deploy --dry-run` for Workers), and fail the pipeline loudly on any non-zero exit.

9. **Keep one lockfile and a clean workspace root.** Next picked a stray `~/package-lock.json` as the workspace root, risking wrong dependency resolution. Remove stray lockfiles or set `outputFileTracingRoot` in `next.config.ts` so the build traces from the project directory.

10. **Know your rollback and observability path before you need them.** Cloudflare Pages keeps deployment history — promote a known-good build from the dashboard (or `wrangler rollback` for Workers) instead of hot-fixing forward under pressure. Enable observability (`wrangler tail`, `observability.enabled`) so runtime edge failures (which won't show at build time) are visible.

## Files Changed
| File | Change |
|------|--------|
| `.github/workflows/deploy-cloudflare.yml` | Remove `.next/static` from deploy command |
| `wrangler.toml` | Add `compatibility_date`, `compatibility_flags`, `pages_build_output_dir` |
| `package.json` | Downgrade next 16→15, add wrangler/next-on-pages, update scripts |
| `eslint.config.mjs` | Rewrite using FlatCompat |
| `lib/watchlist-store.ts` | New — extracted store from route |
| `lib/digest-cache.ts` | New — extracted globalDigestCache from route |
| `app/api/*/route.ts` (26 files) | Add `export const runtime = 'edge'` |
| `app/api/signals/card/route.ts` | Change runtime `nodejs` → `edge` |
| `app/api/portfolio/watchlist/route.ts` | Import store from lib |
| `app/api/portfolio/watchlist/[ticker]/route.ts` | Import store from lib |
| `app/api/portfolio/health-ai/route.ts` | Import store from lib |
| `app/api/signals/refresh/route.ts` | Import cache from lib |
| `app/api/signals/digest/route.ts` | Import cache from lib |
| `app/dashboard/portfolio/page.tsx` | Import store from lib |
