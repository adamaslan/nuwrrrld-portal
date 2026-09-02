# Clerk — Promoting Login from Development to Production

How to move this app's Clerk auth off the **Development** instance
(`pk_test_…` / `sk_test_…`) and onto the **Production** instance
(`pk_live_…` / `sk_live_…`).

Scope is the dev→prod instance promotion specifically. For auth *features*
that are still open (MFA, the admin gate, webhooks), see
`docs/clerk-todos.md`. For the general credential-rotation procedure, see
`docs/env-rotation.md`. **If your production app lives on a subdomain of
Clerk's configured domain and you're on the free plan, read
`docs/clerk-free-plan-best-practices.md` first** — it covers what this file
originally got wrong about satellite domains and `change_domain`, learned
during this app's actual 2026-09-02 cutover.

> **Status: this cutover is done.** `financial.nuwrrrld.com` has run on
> `pk_live_`/`sk_live_` since 2026-09-02; `/api/health` reports Clerk `ok`.
> The rest of this file is kept for the general procedure and reference.

---

## 0. State as of 2026-08-31

Verified via `clerk doctor --json` against this repo:

| Fact | Value |
| --- | --- |
| Local keys | `pk_test_…` / `sk_test_…` — **Development instance** |
| Dev instance | `ins_3F0z8RjA81olOCoXwLggiGvrqsX` |
| Prod instance | `ins_3F16mRsfWlS41NinEiWfi4frXgo` — **already provisioned** |
| Repo → app link | Linked via git remote, no CLI flags needed |
| Clerk CLI login | **Not logged in** — this is the blocker |
| `CLERK_PLATFORM_API_KEY` | Not set |

Two things follow from this table:

1. **A production instance already exists.** You are not creating one; you
   are finishing its DNS/OAuth setup and repointing keys at it.
2. **No code changes are required.** Every consumer reads from env
   (`lib/env.ts`, `app/api/health/route.ts`); nothing hardcodes an instance.
   This is purely a key + DNS + OAuth change.

### Why an agent can't do this for you

`clerk auth login` opens a system browser and binds a localhost OAuth
callback. `clerk deploy` is an interactive wizard that needs real stdin.
Neither works from a non-interactive agent session, and the headless
alternative (`CLERK_PLATFORM_API_KEY`) isn't set in this environment.

**Run steps 1–3 yourself in a normal terminal.** Steps 4–6 are scriptable
and an agent can drive them once you're logged in.

---

## 1. Log in and update the CLI

The globally-pinned CLI is `1.5.0`; current is `3.2.0`. Use the newer one —
the deploy wizard and `deploy status` gate both improved across that range.

```bash
cd ~/code/nuwrrrld-portal
npx -y clerk@3.2.0 auth login     # opens a browser
npx -y clerk@3.2.0 whoami         # confirm the account
```

Verify the link resolved to the right application before going further:

```bash
npx -y clerk@3.2.0 doctor --json | jq '.[] | select(.name=="Project linked")'
```

---

## 2. Run the deploy wizard

```bash
npx -y clerk@3.2.0 deploy
```

Run this in **its own terminal window**, interactively. Do not hand it to an
agent — bare `clerk deploy` in agent mode is read-only and only emits a JSON
handoff; it will never drive the wizard.

The wizard covers the two things that genuinely cannot be automated:

### 2a. DNS

Clerk gives you CNAME records to add at your DNS provider (`clerk.`,
`accounts.`, and mail-related subdomains on your production domain).
Propagation is typically minutes but can take longer.

### 2b. OAuth credentials — the real time sink

**Production instances require your own OAuth app credentials.** In
development, Clerk lets you use its shared pre-configured credentials for
Google, GitHub, etc. Those **do not carry over to production**. For every
social provider you support you must:

1. Create an OAuth app in that provider's own console (Google Cloud
   Console, GitHub Developer Settings, …).
2. Add Clerk's production redirect URI to it.
3. Paste the client ID + secret into Clerk.

Budget real time for this. It is the step that surprises people, and a
provider you forget will simply fail at sign-in on launch day.

Note `e2e/auth.setup.ts` selects the sign-in Continue button with
`exact: true` *because* social buttons render as "Sign in with Google
Continue". If you change which providers are enabled, re-check that E2E
selector still resolves to one element.

---

## 3. Verify the deploy completed

```bash
npx -y clerk@3.2.0 deploy status --mode agent
```

This triggers a DNS check and reports aggregate domain + OAuth readiness.
**It exits `0` only when everything is complete** — so it's safe to use as a
gate in a script. Add `--wait` to keep polling instead of doing one check.

Do not proceed to step 4 until this exits 0.

---

## 4. Decide where the live keys go

This is the step where the obvious action is usually the wrong one.

**Your production surface reads keys from Vercel and GitHub Actions, not
from `.env.local`.** Local `.env.local` only affects your dev server and
local E2E runs. So the switch that actually matters is updating the hosted
env, and there are two strategies:

### Recommended: prod keys hosted, dev keys local

Leave `.env.local` on `pk_test_`/`sk_test_` and push the live keys only to
Vercel + GitHub. You keep a working local dev loop against the dev instance
(including `+clerk_test` E2E addresses — see §6), while production runs
live.

### Alternative: pull prod keys locally too

```bash
npx -y clerk@3.2.0 env pull --instance prod
```

> ⚠️ **`env pull` rewrites the Clerk keys in `.env.local`.** It merges rather
> than clobbering the whole file, but your dev Clerk keys will be replaced.
> They are recoverable from the Clerk dashboard, so this is annoying rather
> than unrecoverable — but only do this if you actually want local pointed at
> production, and read §6 first.

To preview without writing, pull to a scratch file instead:

```bash
npx -y clerk@3.2.0 env pull --instance prod --file /tmp/clerk-prod.env
```

---

## 5. Sync the live keys to Vercel and GitHub

Two variables move: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY`.

**Never paste a secret key into a chat session or a commit.** Use the
`secrets-sync` skill, which pipes values file→CLI over stdin without
routing them through an LLM. The underlying commands it wraps:

```bash
# Vercel — production environment only
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production < /tmp/pk.txt
vercel env add CLERK_SECRET_KEY production < /tmp/sk.txt

# GitHub Actions — used by e2e-resiliency.yml
gh secret set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY < /tmp/pk.txt
gh secret set CLERK_SECRET_KEY < /tmp/sk.txt

shred -u /tmp/pk.txt /tmp/sk.txt   # or: rm -P on macOS
```

Scope Vercel to `production` deliberately. Setting it for all environments
puts live keys on every preview deploy, which inflates production MAU counts
and means a preview branch can mutate real user data.

Redeploy after updating — Vercel env changes do not apply to existing
deployments.

---

## 6. What breaks when you switch — read before flipping

### E2E test users are a development-instance feature

`e2e/auth.setup.ts` depends on `E2E_CLERK_TEST_EMAIL` being a reserved
Clerk `+clerk_test` address, which is exempt from bot protection **by
design in development**. The file says so explicitly:

> Bot protection isn't a problem for us because `E2E_CLERK_TEST_EMAIL` is a
> reserved Clerk `+clerk_test` address, which is exempt by design. If that
> ever changes to a normal address, the token helper (and a different OTP
> strategy) will be needed again.

The fixed OTP `424242` works the same way. **Neither is available against a
production instance.** If you point E2E at prod you must create a real test
user and solve bot protection + a real OTP delivery path — a meaningfully
harder problem.

This is the strongest argument for the §4 "recommended" split: keep E2E and
local dev on the development instance.

### Users do not migrate

Development and production are **separate user stores**. Accounts created
against the dev instance do not exist in production. Anyone testing against
dev will need to sign up again. Plan for this if you have testers who think
they already have accounts.

### Sessions are invalidated

Live keys mean a different instance signing JWTs. Everyone signed in against
the old keys is logged out on deploy. Harmless, but don't ship it mid-demo.

---

## 7. Confirm it worked

Two guardrails already exist in this repo and will tell you if the switch
was incomplete.

**Health endpoint** — `app/api/health/route.ts:95` returns `degraded` with
the error `using a Clerk Development instance key (pk_test_...) in
production` whenever `VERCEL_ENV === "production"` and the key still starts
`pk_test_`:

```bash
curl -s https://<your-prod-domain>/api/health | jq '.dependencies.clerk'
```

Expect `{"status":"ok", …}`. Anything else means the env didn't take —
most often a forgotten redeploy.

**Preflight E2E** — `e2e/preflight/credentials.spec.ts:32` has a
production-only guard asserting the publishable key starts with `pk_live_`.
It skips outside production, so it only fires where it matters.

Manual smoke test, in a fresh incognito window against the production
domain:

- [ ] `/sign-in` loads and shows the expected social providers
- [ ] Email/password sign-up completes
- [ ] **Each** social provider completes (this is where forgotten
      step-2b credentials surface)
- [ ] Redirect lands on `/dashboard` per
      `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`
- [ ] Sign-out works
- [ ] `/api/health` reports Clerk `ok`

---

## Quick reference

```bash
# interactive — you must run these
npx -y clerk@3.2.0 auth login
npx -y clerk@3.2.0 deploy

# scriptable — an agent can drive these once logged in
npx -y clerk@3.2.0 deploy status --mode agent
npx -y clerk@3.2.0 doctor --json
npx -y clerk@3.2.0 env pull --instance prod --file /tmp/clerk-prod.env
npx -y clerk@3.2.0 api /users --instance prod | jq '.[] | .id'
```

Always `--dry-run` any `clerk api` mutation, and pass `--instance prod`
explicitly rather than relying on the resolved default when the target is
production.
