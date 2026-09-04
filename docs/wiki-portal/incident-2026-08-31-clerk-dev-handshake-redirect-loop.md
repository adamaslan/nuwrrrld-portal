---
date: 2026-08-31
type: incident
tags: [clerk, auth, middleware, cookies, samesite, local-dev, playwright, e2e, redirect-loop]
sources: [../../middleware.ts, ../../e2e/api/auth-boundaries.spec.ts, ../../e2e/auth.setup.ts, ../../playwright.config.ts]
---

# Incident — Clerk dev-instance handshake redirect loop on `/dashboard/*` (2026-08-31)

## What happened

A signed-out browser navigating to any `/dashboard/*` route on a local
`next dev` server (`http://localhost:3000`) never reaches the sign-in page.
Instead it enters an unbounded 307 redirect cycle and Chromium aborts with
`net::ERR_TOO_MANY_REDIRECTS`.

Found while writing [[entity-playwright-e2e]]'s new unauthenticated `api`
project — the first test suite in this repo to request a protected route from a
genuinely signed-out, cold browser context.

## The loop

Reproduced with a signed-out Chromium context against local `next dev`:

```text
307  http://localhost:3000/dashboard
307  https://<instance>.clerk.accounts.dev/v1/client/handshake
       ?redirect_url=http%3A%2F%2Flocalhost%3A3000%2Fdashboard
       &__clerk_hs_reason=dev-browser-missing&format=nonce
307  http://localhost:3000/dashboard?__clerk_handshake=<jwt>
307  http://localhost:3000/dashboard
…   repeats until the browser gives up (19+ redirects observed)
```

## Root cause

`__clerk_hs_reason=dev-browser-missing` is the tell: Clerk believes the
dev-browser cookie is absent on every pass, because the browser is **refusing
to store it**.

Decoding the `__clerk_handshake` JWT shows the `Set-Cookie` directives it
carries:

```text
__client_uat=;   Path=/; Expires=Thu, 01 Jan 1970 …;      SameSite=None
__client_uat=0;  Path=/; Domain=localhost; Max-Age=…;     SameSite=None
__session=;      Path=/; Expires=Thu, 01 Jan 1970 …;      SameSite=None
__clerk_db_jwt=dvb_…; Path=/; Expires=…;                  SameSite=None
```

Every one is `SameSite=None` and **none carries `Secure`**. Chromium rejects
`SameSite=None` cookies that lack `Secure` — that is the rule that bites here.
(Chromium *does* treat `http://localhost` as a secure context, so a
`SameSite=None; Secure` cookie would be accepted there; the problem is the
missing `Secure` attribute, not the `http://` scheme per se. On a non-localhost
plain-`http://` origin, `Secure` cookies can't be set at all.) So:

1. Clerk's middleware sees no `__clerk_db_jwt` → redirects to the handshake.
2. The handshake returns cookies the browser silently discards.
3. The request returns to `/dashboard` with still no dev-browser cookie.
4. Go to 1.

This is the Clerk **dev instance** handshake meeting an **http** origin. It is
not a defect in `middleware.ts`'s `isProtectedRoute` matcher — the matcher is
behaving exactly as written.

## Why nothing caught it before

Every existing authenticated Playwright project depends on
`e2e/auth.setup.ts`, which navigates to **`/sign-in` first** — a public route.
The handshake completes there (no auth gate to bounce off), the session cookie
is set, and `/dashboard` is only ever requested with a live session. The loop
is unreachable from that path.

It requires all three conditions at once, which no prior test combined:

- signed-out (no `storageState`),
- a cold browser context (no dev-browser cookie yet),
- a **protected** route as the *first* navigation.

`curl` also does not reproduce it: with no cookie jar and no JS, `/dashboard`
returns a plain `404` (Clerk's `auth.protect()` response for a non-browser
request). The loop is browser-only.

## Impact

- **Local dev only, and only for signed-out visitors.** A developer who is
  already signed in never sees it.
- Preview deployments are served over https and the handshake completes there
  normally (observed). Production is expected to behave the same way — it uses a
  Clerk **production** instance over https — but the production `Set-Cookie`
  attributes have not been captured directly; see Open items.
- Real cost: a signed-out developer cannot navigate from a protected route to
  the sign-in page locally — they must visit `/sign-in` directly.

## Resolution

**Not fixed in this repo, and cannot be** — the offending cookie attributes are
set by Clerk's handshake endpoint, not by any code here. Mitigations, in order
of preference:

1. Run dev over TLS: `next dev --experimental-https`. The origin becomes
   `https://localhost`, so the `SameSite=None` cookies are accepted and the
   handshake completes on the first pass.
2. Visit `/sign-in` directly rather than a protected route when signed out —
   this is what `e2e/auth.setup.ts` already does, which is why the suite works.
3. Use a Clerk production instance or a proxied domain instead of raw
   `localhost`.

No production action is required: the https origin (preview and production)
gives the handshake cookies a secure context. Verified 2026-08-31 that the loop
does not occur on preview; production is inferred from the same https +
production-instance setup, not separately captured (Open items).

## How it is pinned

`e2e/api/auth-boundaries.spec.ts` asserts the property that still holds — a
signed-out visitor never gets the protected page rendered — and treats
`ERR_TOO_MANY_REDIRECTS` as "boundary held, known issue", pushing a
`known-issue` annotation so the loop stays visible in the report rather than
silently passing. If the loop is ever fixed, those tests strengthen
automatically to the `/sign-in` URL assertion with no edit.

## Impact on design

- **Auth-boundary tests must assert the property, not the mechanism.** The
  original test asserted "redirects to `/sign-in`". That is a statement about
  *how* the boundary is enforced, and it broke on an environment quirk that left
  the boundary itself perfectly intact. The rewritten test asserts "the
  protected page never renders" — the security property that actually matters —
  and treats the loop as a known, annotated path. It will strengthen to the
  URL assertion automatically if the loop is ever fixed, with no edit.
- **A test tier's *absence* of a fixture is itself a feature.** The `api`
  project found this precisely because it deliberately has no `storageState`.
  Every authenticated tier is structurally incapable of seeing signed-out bugs.
  Coverage gaps track fixture assumptions, so a suite needs at least one tier
  per distinct auth state — not just per feature area.
- **`curl` and a browser disagree here, and the browser is the user.** `curl`
  reports a clean `404` for `/dashboard`; only a cookie-storing, JS-executing
  browser reproduces the loop. Diagnosing auth flows with `curl` alone would
  have concluded "working as designed."

## Open items

- [ ] Decide whether local dev should default to `next dev --experimental-https`
      so signed-out navigation behaves like production. Cheap, but it changes
      every developer's local URL and any hardcoded `http://localhost:3000`.
- [ ] Confirm on a Clerk **production** instance that the handshake sets
      `Secure` — assumed from the https origin, not yet directly observed.
- [ ] Consider a `README`/`docs/e2e.md` note so the next person who hits
      `ERR_TOO_MANY_REDIRECTS` locally does not re-derive this from scratch.

## See also

- [[entity-playwright-e2e]] — the `api` project and the tier dependency graph
- [[concept-graceful-degradation]] — refusing rather than crashing
- `middleware.ts` — `isProtectedRoute` / `isProtectedApiRoute`
