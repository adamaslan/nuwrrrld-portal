---
ARCHIVED: false
date: 2026-08-31
topic: e2e test build-out + backtest-badge bug report
status: paused — concurrent-process conflict, awaiting user input
---

# Session Summary — E2E Feature Sweep & "Historical Hit-Rate Unavailable" Report

## What was asked

1. Investigate: "historical hit rate data unavailable for all tickers"
2. Write more e2e tests exploring all the app's features
3. (Mid-session) Create a PR, run `/bugmerge1`, then keep looping
   build-out → PR → `/bugmerge1` until the e2e build-out is complete

## What was found — the reported bug

**Root cause confirmed, not a code bug.** `SIGNALS_ENGINE_URL` in
`.env.local` is **present but set to an empty string**.

- [lib/backtest.ts:56](../lib/backtest.ts#L56) — `fetchBacktest()` returns
  `null` immediately when `SIGNALS_ENGINE_URL` is falsy, before making any
  request.
- [app/api/backtest/[symbol]/route.ts](../app/api/backtest/%5Bsymbol%5D/route.ts)
  turns a `null` into `204 No Content`.
- [components/TrackRecordBadge.tsx](../components/TrackRecordBadge.tsx)
  renders `"Historical hit-rate data unavailable for {symbol}."` on 204.

Because the check is a single global env var, **every** ticker hits the same
branch — which is exactly the reported symptom ("unavailable for all
tickers"). That uniformity is itself diagnostic: a real backend outage would
not be perfectly uniform across every symbol the same way an unset config
value is.

This is already a known, documented gap
(`docs/wiki-portal/entity-backtest-engine.md`, "Silent absence in
production"). Fix is operational, not code: point `SIGNALS_ENGINE_URL` at a
deployed signals-app backtest engine.

## What was built — e2e specs (654 lines, 3 files)

All work is committed as **`0dda5e5`** on branch **`test/e2e-feature-specs`**
(see Incident below for why it's not on the branch it was authored on).

1. **`e2e/frontend/track-record.spec.ts`** — pins `TrackRecordBadge`'s
   contract across all four states (204/empty, valid payload, malformed
   payload, zero-sample bucket), plus a diagnostic test that distinguishes
   "engine unconfigured" from "engine configured but unreachable" — the two
   causes the UI currently renders identically.

2. **`e2e/api/auth-boundaries.spec.ts`** (new Playwright project: `api`,
   deliberately **no** `storageState`) — sweeps `middleware.ts`'s full route
   classification table (auth-required GET/POST, public, internal-secret
   bearer routes, signed webhooks, protected pages) and asserts each bucket
   actually rejects/accepts as documented in `docs/API-ROUTE-AUTH.md`.
   Assertions were corrected against **verified live behavior** (curl'd every
   endpoint) rather than assumed status codes — e.g. Clerk's edge rejection is
   404 not 401, the pipeline routes fail-closed with 503 when `CRON_SECRET`
   is unset, unsigned webhooks return 400.

3. **`e2e/frontend/watchlist-crud.spec.ts`** — the only user-owned mutable
   collection in the portal (add/remove/duplicate-409/503-recovery). Correctly
   seeds rows through the UI rather than a GET mock, since
   `PortfolioClient`'s initial list is server-rendered via an
   `initialWatchlist` prop that a `page.route()` GET mock cannot intercept.

Also added: `{ name: "api", testDir: "./e2e/api", dependencies: ["preflight"] }`
to `playwright.config.ts`.

**Test run result:** 51 passed / 10 initially failed. All 10 failures were
over-narrow assertions in the new tests, fixed after curling each endpoint
directly to confirm real behavior — except one, which was a genuine finding
(next section).

## Real bug found — Clerk dev-handshake redirect loop (local dev only)

Reproduced with a signed-out Chromium context against local `next dev`:
navigating to any `/dashboard/*` route loops forever —
`net::ERR_TOO_MANY_REDIRECTS` after 19+ redirects.

**Cause, decoded from the handshake JWT:** Clerk's dev-instance handshake sets
`__clerk_db_jwt` and `__client_uat` as `SameSite=None` **without `Secure`**.
Chromium rejects such cookies over plain `http://localhost`, so the
dev-browser cookie never persists, Clerk keeps reporting
`__clerk_hs_reason=dev-browser-missing`, and the 307 cycle never terminates.

- **Why nothing caught it before:** every existing authenticated Playwright
  project (`e2e/auth.setup.ts`) visits `/sign-in` — a *public* route — first,
  so the handshake completes before any protected route is hit.
- **Why `curl` doesn't see it:** no cookie jar, no JS — `curl /dashboard`
  returns a clean 404 (Clerk's `auth.protect()` response). Browser-only bug.
- **Scope:** local dev, signed-out visitors only. Production/preview are
  https, so `SameSite=None` cookies are accepted there — unaffected.
- **Fix options (not applied):** `next dev --experimental-https`, or always
  visit `/sign-in` first when signed out locally, or use a Clerk production
  instance / proxied domain instead of raw `localhost`.

Documented as
`docs/wiki-portal/incident-2026-08-31-clerk-dev-handshake-redirect-loop.md`
(full frontmatter + required incident sections written, wiki-lint clean) plus
matching updates to `entity-playwright-e2e.md`'s known-failures list,
`entity-backtest-engine.md`'s known-failures list, `index.md`, and `log.md`.

**⚠️ Wiki-side risk:** those wiki file edits were made with the same Python
in-place-edit approach as the code changes, in the same window where the
concurrent-process conflict below occurred. Their survival on disk was not
re-verified after that conflict was discovered — **re-check before assuming
they're intact.**

## Incident — a concurrent process rewrote the working tree mid-session

While re-running tests, discovered:

- The checked-out branch had silently changed from
  `test/e2e-feature-spec` to **`feat/followed-tickers-dashboard`**.
- A commit neither authored nor requested in this session appeared in the
  reflog: `4f7a512 feat(followed-tickers): dashboard surface — cohort cards,
  scoreboard, judge quadrant`, followed by a rebase onto `origin/main`.
- All three new spec files and the `playwright.config.ts` edit were **gone
  from the working tree** as a result.

**No data was lost** — the commit (`0dda5e5`) survived on a branch named
`test/e2e-feature-specs`, a name this session didn't choose either, which is
itself evidence of a second actor (or a second session of the same agent)
operating on this repo concurrently.

A near-identical, smaller version of this already happened once earlier in
the session: an initial `playwright.config.ts` edit was reverted by this
session's own `git checkout -b ... origin/main` (the exact failure the
`stay-on-branch-after-merge` rule warns about) — caught and re-applied
immediately. The second occurrence was not self-inflicted and was larger.

**Work paused at this point rather than continuing the requested
PR → `/bugmerge1` → repeat loop**, because:
- `/bugmerge1` performs checkouts/merges; running it while another process is
  actively rebasing branches risks destroying either side's work.
- The requested loop assumes exclusive control of the working tree, which was
  no longer a safe assumption.

## Where things stand / next steps

1. **Confirm no other session/loop is running against `nuwrrrld-portal`**
   before resuming any branch/PR automation. This is the blocking question —
   the session paused here rather than guess.
2. Once clear: verify `test/e2e-feature-specs` still contains commit
   `0dda5e5`, re-run `npx playwright test --project=api` to reconfirm the 51
   passing / 0 failing state before opening a PR.
3. Re-verify the wiki edits (see risk note above) actually landed — the
   Python in-place-edit pattern doesn't guarantee it under a concurrent writer.
4. Then resume the originally requested loop: open PR → run `/bugmerge1` →
   continue building out e2e coverage for remaining untested surfaces
   (nuai chat, holdfold detail page, stripe checkout/portal, privacy
   export/delete, consent banner, disclaimer modal, referral, digest email —
   none of these have dedicated e2e specs yet).
5. Fix or explicitly accept the Clerk dev-handshake redirect loop (see fix
   options above) — currently just documented, not resolved.
