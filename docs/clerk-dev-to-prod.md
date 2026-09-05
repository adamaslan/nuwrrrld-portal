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

The globally-pinned CLI is `1.5.0`; the deploy wizard and `deploy status`
gate both improved well beyond that, so use a current release. **Every
`clerk` command in this guide was run with `clerk@3.2.0` during the
2026-09-02 cutover** — that is the tested version, pinned throughout so the
commands are reproducible. `clerk@3.3.0` is the latest at time of writing;
if you move to it, re-check the flags below (`--mode agent`, `--instance`,
`env pull --file`) still behave the same before relying on them.

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

> The `$KEYDIR/pk.txt` and `$KEYDIR/sk.txt` files that §5 pipes into
> Vercel/GitHub do not exist yet — `env pull --file` writes a single dotenv
> file. Derive the two key files from it first, into a private temp dir that
> is wiped on **any** exit (not just success), and check each value before
> touching any hosted env:
>
> ```bash
> umask 077                                   # new files are 0600
> KEYDIR="$(mktemp -d)"                        # 0700, unpredictable name
> trap 'rm -rf "$KEYDIR"' EXIT                 # wiped even on error / Ctrl-C
>
> npx -y clerk@3.2.0 env pull --instance prod --file "$KEYDIR/clerk-prod.env"
> grep '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' "$KEYDIR/clerk-prod.env" | cut -d= -f2- > "$KEYDIR/pk.txt"
> grep '^CLERK_SECRET_KEY='                  "$KEYDIR/clerk-prod.env" | cut -d= -f2- > "$KEYDIR/sk.txt"
> grep -q '^pk_live_' "$KEYDIR/pk.txt" && grep -q '^sk_live_' "$KEYDIR/sk.txt" \
>   || { echo 'keys are not pk_live_/sk_live_ — stop'; exit 1; }
> ```
>
> Keep §5's commands in the **same shell** so `$KEYDIR` and the `trap` still
> apply; the dir is gone the moment that shell exits.

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

## 5. Sync the live keys to Vercel — and NOT to GitHub's E2E secrets

One variable pair moves, to exactly one place: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
and `CLERK_SECRET_KEY` **in Vercel only.**

> ⚠️ **This section originally also ran `gh secret set` on these same two
> secret names.** `.github/workflows/e2e-resiliency.yml` read
> `secrets.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `secrets.CLERK_SECRET_KEY` at
> the time, so that command silently pointed the E2E suite's `next dev`
> (which runs on localhost) at the live, domain-locked production instance.
> Clerk's SDK refuses to load off localhost with a production key
> ("Production Keys are only allowed for domain ..."), so the sign-in page's
> email field never rendered and `e2e/auth.setup.ts` timed out 30s later with
> no indication why. That is exactly what happened to every CI run from the
> 2026-09-02 cutover onward — see `docs/known-bugs.md` for the corrected
> writeup. The workflow now reads a **separate** `E2E_CLERK_PUBLISHABLE_KEY` /
> `E2E_CLERK_SECRET_KEY` pair, which must stay on the dev instance per §6
> below. Do not repoint those two secret names at this step's live keys.

**Never paste a secret key into a chat session or a commit.** Use the
`secrets-sync` skill, which pipes values file→CLI over stdin without
routing them through an LLM. The underlying command it wraps:

Run this in the **same shell** as the §4 extraction block, so `$KEYDIR` and
its `EXIT` trap are still in scope:

```bash
# Vercel — production environment only. --force upserts, so it works whether
# or not the variable already exists (no need to `env rm` first).
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production --force < "$KEYDIR/pk.txt"
vercel env add CLERK_SECRET_KEY production --force < "$KEYDIR/sk.txt"

# $KEYDIR is removed automatically by the trap when this shell exits; to wipe
# it now: rm -rf "$KEYDIR"
```

Scope Vercel to `production` deliberately. Setting it for all environments
puts live keys on every preview deploy, which inflates production MAU counts
and means a preview branch can mutate real user data.

GitHub's `E2E_CLERK_PUBLISHABLE_KEY` / `E2E_CLERK_SECRET_KEY` secrets are a
one-time setup, not part of this cutover — see §6 and
`docs/manual-setup-todo.md` §5b. They should already hold the dev instance's
`pk_test_`/`sk_test_` values (the same ones in `.env.local`) and this
procedure never needs to touch them again.

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

**Enforced by a dedicated secret pair, not just this document.** CI's
`e2e-resiliency.yml` reads `E2E_CLERK_PUBLISHABLE_KEY` / `E2E_CLERK_SECRET_KEY`
— separate GitHub secret names from the production `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
/ `CLERK_SECRET_KEY` that Vercel reads — precisely so a future prod-key rotation
can't silently repoint E2E again the way §5's original version did. Both must
hold the dev instance's `pk_test_`/`sk_test_` values; see
`docs/manual-setup-todo.md` §5b if they're ever unset. A preflight test
(`e2e/preflight/credentials.spec.ts`, "EXPOSE: E2E running against Clerk's
production instance") fails fast and legibly if that pair ever gets pointed
at production instead.

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
was incomplete. **Both check key *shape* only** — that the publishable key
starts `pk_live_` rather than `pk_test_`. Neither proves Clerk accepts the
credentials or that a sign-in actually succeeds; treat them as a
configuration guard, and rely on the manual smoke test below (or a real
authenticated E2E run) for proof the flow works.

**Health endpoint — rejects a *development* key.**
`app/api/health/route.ts:95` returns `degraded` with the error `using a
Clerk Development instance key (pk_test_...) in production` whenever
`VERCEL_ENV === "production"` and the key still starts `pk_test_`. That is
its *only* Clerk assertion — it does not check for a `pk_live_` prefix, and
the overall response can still be non-`ok` because a different dependency is
down.

```bash
curl -s https://<your-prod-domain>/api/health | jq '.dependencies.clerk'
```

Expect `{"status":"ok", …}`. A `degraded` Clerk entry means the env didn't
take (usually a forgotten redeploy); a non-`ok` top-level status with Clerk
`ok` points at another dependency.

**Preflight E2E — asserts the *live* prefix.**
`e2e/preflight/credentials.spec.ts:32` has a production-only guard asserting
the publishable key starts with `pk_live_`. It skips outside production, so
it only fires where it matters. Between the two, you've confirmed the key is
neither a dev key nor missing — but still not that sign-in works.

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
