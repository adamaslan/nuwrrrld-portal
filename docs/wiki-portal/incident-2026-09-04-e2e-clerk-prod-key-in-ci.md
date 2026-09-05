---
date: 2026-09-04
type: incident
tags: [ci, e2e, playwright, clerk, secrets, github-actions, misdiagnosis]
sources: [../../.github/workflows/e2e-resiliency.yml, ../../e2e/auth.setup.ts, ../../e2e/preflight/credentials.spec.ts, ../../docs/clerk-dev-to-prod.md, ../../docs/known-bugs.md, ../../docs/manual-setup-todo.md, PR#112]
---

# Incident: A Prod-Cutover Doc Repointed E2E's Own Clerk Secrets, Misdiagnosed as an OTP Flake

## Date & severity

**2026-09-04** — Severity: **Low** for the product (no user impact, docs-only
+ CI-config root cause, no code path affecting real traffic changed), but
**four consecutive CI runs** (PRs #106–#109 and #110's own first two attempts)
failed on this before the real cause was found, and the working diagnosis in
`docs/moo-todo.md` was actively wrong for all of them.

## What happened

Every `auth` job run in `.github/workflows/e2e-resiliency.yml` failed the same
way from 2026-09-02 onward: `e2e/auth.setup.ts:71`,
`getByLabel(/email/i).fill(EMAIL)`, a flat 30s timeout. `docs/moo-todo.md`
attributed this to the known, documented OTP fragility
([[entity-playwright-e2e]] / `docs/known-bugs.md` item 16 — the `+clerk_test`/
fixed-OTP workaround) without reading the actual failure logs.

Reading `gh run view --log-failed` across all four runs showed the OTP step
was never reached — the failure is two steps earlier, at page load. The
`[WebServer]` log printed the real reason on every run:

```
Clerk: Production Keys are only allowed for domain "nuwrrrld.com".
API Error: The Request HTTP Origin header must be equal to or a subdomain of the requesting URL.
```

Clerk's client SDK refuses to initialize at all when handed a **production**
(domain-locked) publishable key from an origin outside its configured domain.
`e2e-resiliency.yml`'s `auth`/`e2e` jobs run `next dev` on `localhost` — never
`nuwrrrld.com` — so the sign-in page's Clerk-rendered email field never
mounts. `getByLabel(/email/i)` waits for an element that will never exist.

## Root cause

[[entity-clerk]]'s 2026-09-02 production cutover
(`docs/clerk-dev-to-prod.md`) is real and correct on its own terms — it moved
`financial.nuwrrrld.com` onto the `pk_live_`/`sk_live_` production instance.
But that doc's §5 scripted `gh secret set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
/ `gh secret set CLERK_SECRET_KEY` — the **same two secret names**
`e2e-resiliency.yml` was reading for its own, separate purpose (signing a
throwaway test user into `next dev`, per [[entity-playwright-e2e]]). The doc's
own §6 explicitly documents that E2E must stay on the development instance
(`+clerk_test` addresses and the fixed OTP `424242` are dev-instance-only
features) — but §5's script wasn't cross-checked against §6's own constraint,
and it silently repointed E2E at production the moment it ran.

This is the same failure *category* as failure #1 in
[[incident-2026-08-17-e2e-ci-cascade]] ("wrong Clerk instance active"), just
reached by a different path: that incident was local dotenv precedence
picking the wrong pair; this one was a documented, intentional secret-rotation
procedure that didn't account for a second consumer of the same secret names.
Same lesson, different mechanism — worth noting on both pages since neither
alone would have caught this class of regression a second time.

## Resolution

- `.github/workflows/e2e-resiliency.yml`'s `auth` and `e2e` jobs now read a
  dedicated `E2E_CLERK_PUBLISHABLE_KEY` / `E2E_CLERK_SECRET_KEY` secret pair,
  decoupled from the `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`
  secrets Vercel reads for production.
- `e2e/preflight/credentials.spec.ts` gained an inverse check: outside
  `VERCEL_ENV === "production"`, the Clerk keys must NOT be `pk_live_`/
  `sk_live_`. A future recurrence now fails in under a second with a named
  cause, instead of a 30s timeout with no diagnostic content.
- `docs/clerk-dev-to-prod.md` §5 no longer touches the E2E secret names at
  all, and carries an explicit warning about what its original version did.
- `docs/known-bugs.md` item 16 keeps its original (still-true) claim about
  the OTP workaround being fragile, but now carries a correction stating this
  specific incident was not that.

## Impact on design

Confirms a pattern worth generalizing: **a secret name shared between a
production deployment target and a CI test target is a latent coupling that
survives until someone rotates one side.** `E2E_CLERK_TEST_EMAIL`/`PASSWORD`
already got this right (dedicated names, never overlapping with anything
production uses); the publishable/secret key pair didn't, because it was
initially set up before a production instance existed to collide with. Worth
checking whether any other CI secret still aliases a production one.

## Open items

- The two new secrets (`E2E_CLERK_PUBLISHABLE_KEY` / `E2E_CLERK_SECRET_KEY`)
  need their actual values set — `docs/manual-setup-todo.md` §5b. Until then,
  `auth` still fails, but now with the new preflight test's explicit message
  rather than a silent timeout.
- Whether any other CI workflow in this repo aliases a Vercel/production
  secret name unintentionally hasn't been audited; this incident was found by
  investigating one specific symptom, not a systematic sweep.

## See also

- [[entity-clerk]] — the dev/production instance split this incident's root
  cause lives in
- [[entity-playwright-e2e]] — the suite whose `auth` job broke
- [[incident-2026-08-17-e2e-ci-cascade]] — the same "wrong Clerk instance"
  failure category, reached by a different mechanism
- `docs/clerk-dev-to-prod.md` — the cutover procedure whose §5 caused this,
  now corrected
- `docs/known-bugs.md` item 16 — the OTP-fragility item this was
  misattributed to
