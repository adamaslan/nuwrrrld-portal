# Cloudflare Pages Integration — Keep or Kill?

**Date:** 2026-07-24
**Trigger:** the `Cloudflare Pages` GitHub check has failed on every recent PR
(#37–#41), including PR #41 which touched only a dev script and docs.

## TL;DR

**Disable the GitHub integration only — keep the Pages project.** It is not
deploying anything usable and there is no code left in the repo that
supports it, but the Pages project itself is still where you're getting live
domain hit/traffic info from, so it should **not** be deleted. The fix is to
turn off GitHub-triggered builds (`deployments_enabled` /
`production_deployments_enabled` / `pr_comments_enabled`) via one `curl`
call — the project, its `*.pages.dev` domain, and its traffic analytics stay
exactly as they are; only the auto-build-on-push/PR-check behavior stops.
DNS nameservers are untouched either way. Email is Resend + Namecheap MX
forwarding, neither of which is Cloudflare.

> **Correction from the original version of this doc:** it previously
> recommended a full disconnect/delete. That was wrong once "I'm getting
> domain hit info from it" was in scope — deleting the project would kill
> that. §"How to do it via CLI" below is the surgical fix: kill the noisy
> GitHub check, keep the analytics.

---

## What Cloudflare actually does for this project today (evidence, not assumption)

| Claim | Reality | Evidence |
|-------|---------|----------|
| "Cloudflare deploys the site" | **No — Vercel does.** | `curl -I https://financial.nuwrrrld.com` → `server: Vercel`, HTTP 200. DNS: `financial.nuwrrrld.com` → CNAME → `nuwrrrld-portal.vercel.app`. |
| "Cloudflare is used for email" | **No.** App-level sending is **Resend** (`api.resend.com`, `RESEND_API_KEY`). Inbound is **Namecheap forwarding**, not Cloudflare Email Routing. | `grep resend app/api/retention/*.ts app/api/launch/remind/route.ts` → 3 routes call `api.resend.com`. `dig nuwrrrld.com MX` → `eforward{1-5}.registrar-servers.com` (Namecheap), not Cloudflare. |
| "Cloudflare does analytics" | **No signal found.** | `curl -s https://financial.nuwrrrld.com \| grep -i cloudflareinsights` → nothing. `privacy-policy/page.tsx` mentions "Analytics (if enabled)" generically — no Cloudflare-specific script is wired. |
| "Cloudflare hosts DNS" | **Yes — this is the one real, live role.** | `dig nuwrrrld.com NS` → `dion.ns.cloudflare.com`, `emerie.ns.cloudflare.com`. This is what actually needs to keep working. |

So the premise in the question ("it's just for email and maybe analytics") is
close but not quite right: Cloudflare isn't doing email or analytics either —
its **only** live job is being the DNS zone host. Everything else attributed
to it (deploys, email, analytics) is already handled by other providers.

---

## Why Pages specifically is dead weight

### 1. The supporting code was already archived, on purpose
`file-archive/` (this project's designated "archived, not deleted" location —
see `AGENTS.md`/`CLAUDE.md` doc policy) already contains:
- `deploy-cloudflare.yml` (the GitHub Actions workflow)
- `wrangler.jsonc` (the Pages build config)
- `deploy-to-cloudflare.sh`
- `deploy-fix-log.md` — a 14KB incident log from 2026-06-28/29 documenting a
  full from-scratch fix of the Cloudflare Pages pipeline

Someone already did the work, hit the ceiling, and shelved it. Nothing in
`.github/workflows/` today references Cloudflare (`compile-grounding-pack.yml`,
`integration-tests.yml`, `refresh-free-models.yml` — none of them).

### 2. It is now version-incompatible, not just unmaintained
Per `deploy-fix-log.md`: `@cloudflare/next-on-pages` caps at **Next.js
15.5.2**. The fix log shows Next was deliberately downgraded 16→15 to make
Pages work. The current `package.json` has **`"next": "16.2.9"`** — the
project moved back to Next 16 after that fix, which structurally breaks the
Cloudflare adapter. This isn't a flaky build; it can't succeed as configured.

### 3. It has failed on 100% of recent PRs
| PR | Cloudflare Pages check |
|----|------------------------|
| #37 | ❌ FAILURE |
| #38 | ❌ FAILURE |
| #39 | ❌ FAILURE |
| #40 | ❌ FAILURE |
| #41 | ❌ FAILURE |

Also failing on `main` itself (confirmed via `gh api
repos/.../commits/main/check-runs`). This is not a regression to fix — it is
the steady state.

### 4. The production domain no longer points at it
`financial.nuwrrrld.com` is a CNAME to `nuwrrrld-portal.vercel.app` and
actively serves `server: Vercel`. Even if a Cloudflare Pages build *did*
succeed, nothing would route traffic to it — the custom domain binding has
already moved on. The `pages.dev` deployment the 2026-06-28 incident was
fighting to keep alive is orphaned infrastructure at this point.

### 5. It carries a small, avoidable cost for existing as a GitHub check
- **A permanently red check** on every PR trains you (and any future
  collaborator or review bot) to ignore failing CI, which is exactly the
  habit that lets a *real* failure slip through unnoticed.
- **Minor GitHub Actions/dashboard noise** — not a cost driver at this scale,
  but it's not zero either.
- The two repo secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are
  **not** dead weight, though — they're exactly what's needed to run the
  CLI fix in the next section, and to manage the (still-live, still
  analytics-producing) Pages project going forward.

---

## Cost/risk of disabling just the GitHub integration

**Effectively zero, and nothing analytics-facing is touched:**
- The Pages project, its `.pages.dev` domain, and its dashboard traffic/hit
  data are **not** deleted or altered — `source.config`'s build-trigger flags
  are the only thing changing.
- DNS/nameservers are unaffected (Cloudflare stays as the DNS host regardless
  of the Pages product).
- Resend email is unaffected (separate provider, separate secret).
- Vercel deploys are unaffected (separate, already-working pipeline).
- No code changes required in the app.
- **Reversible in one API call** (§ Rollback above) — flip the same three
  flags back to `true`.

The only thing "lost" is automatic builds-on-push to a deploy target that
isn't functional today anyway (Next 16 vs. the adapter's Next 15.5.2 cap). If
Cloudflare Pages/Workers deploys are wanted again later, `file-archive/`
already has a working recipe (`deploy-fix-log.md`'s "10 Best Practices"
section) and a path via **OpenNext (`@opennextjs/cloudflare`)**, which the
log itself flags as the forward-looking replacement for
`@cloudflare/next-on-pages`. Re-enabling `deployments_enabled` at that point
(§ Rollback) is instant — nothing has to be rebuilt from scratch.

---

## Recommended action

1. **Disable GitHub-triggered builds via the CLI** (§ below) — the Pages
   project, its `nuwrrrld-portal.pages.dev` domain, and its traffic/hit
   analytics are untouched. Only automatic builds-on-push and the PR
   status-check/comment stop.
2. **Leave Cloudflare DNS (nameservers) exactly as-is** — `nuwrrrld.com`'s NS
   records stay on Cloudflare. This is unrelated to Pages and is presumably
   why the domain is on Cloudflare's registrar-adjacent DNS in the first
   place.
3. **Leave Resend and Namecheap MX forwarding as-is** — neither is Cloudflare
   and neither is affected by this change.
4. **Keep the `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo
   secrets** (or at minimum, keep a token with `Pages:Edit` scope somewhere
   you can reach) — you need them again if you ever want to re-enable builds
   or otherwise manage the project from the CLI. There's no ongoing cost to
   an unused GitHub Actions secret, unlike a live integration.
5. **Do not delete `file-archive/deploy-*` files** — per this project's
   archive-not-delete policy, they stay as a recipe if Pages/Workers is
   revisited via OpenNext later.

---

## How to do it via CLI

Cloudflare Pages doesn't expose a "disconnect" subcommand in `wrangler`
(`wrangler pages project` only has `list` / `create` / `delete` — confirmed
against `wrangler` 4.98.0 locally). The Git integration itself is only
manageable through the dashboard's GitHub App settings — but the thing that
actually *does* the auto-building and posts the PR check, `source.config`,
**is** a documented field on the Pages REST API's project-update endpoint. So
the CLI path is a direct API call, not `wrangler`.

### 0. Prerequisites
- A Cloudflare API token with **Account → Cloudflare Pages → Edit**
  permission. Per `file-archive/deploy-fix-log.md`, the token that was set up
  for this repo (`CLOUDFLARE_API_KEY_NU1` / the `CLOUDFLARE_API_TOKEN` repo
  secret) was originally scoped for DNS and its Pages scope was **never
  confirmed**. Check it, or mint a fresh one at
  <https://dash.cloudflare.com/profile/api-tokens> with the Pages:Edit
  template, before running the commands below.
- Your account ID: `wrangler whoami` prints it, or read it from
  `file-archive/deploy-fix-log.md` (`8d9169bfecfc72d7e3b664406d006540`).
- Project name: `nuwrrrld-portal` (confirmed via `wrangler pages project list`).

```bash
export CLOUDFLARE_API_TOKEN="…"        # needs Pages:Edit
export CLOUDFLARE_ACCOUNT_ID="8d9169bfecfc72d7e3b664406d006540"
export CF_PAGES_PROJECT="nuwrrrld-portal"
```

### 1. Confirm current state (optional but recommended)
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CF_PAGES_PROJECT" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result.source'
```
You should see `"type": "github"` and `"deployments_enabled": true` — this
confirms the GitHub App connection this doc is about to neuter.

### 2. Disable GitHub-triggered builds + the PR check/comment
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CF_PAGES_PROJECT" \
  -X PATCH \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "source": {
          "config": {
            "deployments_enabled": false,
            "production_deployments_enabled": false,
            "pr_comments_enabled": false
          }
        }
      }' | jq '{success, source: .result.source}'
```
`deployments_enabled: false` stops preview builds (what fires on a PR);
`production_deployments_enabled: false` stops builds on pushes to
`main`; `pr_comments_enabled: false` stops the Cloudflare bot's PR comment.
Together these are what make the `Cloudflare Pages` GitHub status check and
comment disappear from future PRs. **The project itself, its `.pages.dev`
domain, and its dashboard analytics are not touched by this call** — only
`source.config`'s build-trigger flags change.

### 3. Verify
```bash
# API: deployments_enabled should now be false
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CF_PAGES_PROJECT" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result.source.config'

# GitHub: the check should no longer appear on your next PR
gh pr view <next-pr> --json statusCheckRollup

# Site: still Vercel, unaffected
curl -sI https://financial.nuwrrrld.com | head -3

# Pages project: still exists, still collecting hits
npx wrangler pages project list
```

### Rollback (re-enable if needed)
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/$CF_PAGES_PROJECT" \
  -X PATCH \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":{"config":{"deployments_enabled":true,"production_deployments_enabled":true,"pr_comments_enabled":true}}}'
```

### If you ever do want the project itself gone
That's a separate, more destructive step this doc does **not** recommend
given the analytics use case — but for completeness:
```bash
npx wrangler pages project delete nuwrrrld-portal
```
This deletes the project (and its hit data) entirely. Not what you want here.

---

_Sources: `file-archive/deploy-fix-log.md`, `file-archive/wrangler.jsonc`,
`.github/workflows/*`, `package.json`, `app/api/retention/*.ts`,
`app/api/launch/remind/route.ts`, `app/privacy-policy/page.tsx`, live `dig`/
`curl` checks against `financial.nuwrrrld.com` and `nuwrrrld.com`, `gh pr
view`/`gh api` check-run history for PRs #37–#41, `wrangler pages project
list` (v4.98.0), and the Cloudflare Pages "Update Project" API reference
(`PATCH /accounts/{account_id}/pages/projects/{project_name}`), 2026-07-24._
