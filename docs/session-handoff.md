# Session handoff — auth/cookies plan, Phases 1.3 + 6

**Date:** 2026-08-29
**Branch:** `feat/auth-cookies-phase-1-3-6` (2 commits, ahead of `origin/main` by 2, **not pushed**, **no PR** — per instruction: no PR until every unblocked phase is done)
**Plan:** `docs/todo-auth-cookies-tracking.md` (exists only on the PR #77 branch, not on `main` yet)

---

## What is DONE on this branch (verified: tsc + eslint + `next build` + 372 unit tests, 23 new)

### Phase 1.3 — close the authorization gaps (`693e36b`)
- **`lib/http-auth.ts`** — NEW. `timingSafeEqualStr()` + `bearerTokenMatches()`.
  Pure-JS constant-time compare, **no `node:crypto`** — `middleware.ts` imports it
  and runs on the Edge runtime where `node:crypto` is unavailable. (First attempt
  used `node:crypto.timingSafeEqual`; `next build` printed an Ecmascript error for
  the Edge Middleware bundle. Rewrote to XOR-accumulate loop. Don't reintroduce
  `node:crypto` here.)
- **`middleware.ts`** — `isProtectedApiRoute` matcher expanded from 3 prefixes to
  23; every per-user route now edge-guarded as defense-in-depth. `council/{public,
  sample}` explicitly excluded via `isPublicCouncilRoute`. `PORTAL_PUSH_SECRET`
  digest carve-out now uses `bearerTokenMatches`. Webhooks deliberately NOT in the
  matcher (signature is the auth).
- **10 internal-secret route handlers** migrated off `===`/`!==` on the
  `Authorization` header → `bearerTokenMatches()`:
  `pipeline/hydrate-universe`, `pipeline/precompute-ai`,
  `signals/{drain,live,refresh,digest,top}`, `launch/remind`,
  `retention/{digest-email,trial-nudge}`.
- **`docs/API-ROUTE-AUTH.md`** — NEW. Full route classification table
  (public / auth-required / internal-secret / webhook-signed). Keep in sync with
  the matcher.
- **`lib/env.ts`** — added `LAUNCH_REMIND_SECRET` (was referenced, never declared).

### Phase 6 remainder — data-subject rights (`1c88dc0`)
- **`app/api/privacy/rectify/route.ts`** — NEW. GDPR Art. 16. Logs a structured
  correction request; does not self-mutate. 202 + statutory deadline. Rate-limited
  5/hr/user.
- **`lib/privacy-requests-db.ts`** + **`privacy_requests` table** (appended at END
  of `lib/db/schema.sql`) — statutory-clock ledger: one append-only row per DSAR
  (export/delete/rectify) with `received_at` + `due_at` (received + 30d). Fail-open
  writes. Deliberately outside the erasure cascade.
- **`lib/rate-limit.ts`** — NEW. Dependency-free per-instance sliding-window
  limiter. `__resetRateLimitState()` for tests.

---

## BLOCKED — cannot proceed this session

### Phases 1.1, 1.2 — Clerk Production instance + session posture
Needs Clerk **Dashboard** access + DNS for `clerk.financial.nuwrrrld.com`. Pure
config, zero code. Ask the user to grant Dashboard access or do it themselves.

### Phases 3, 4, 5, 7 — analytics / ads / profiles / policy rewrite
**Hard-blocked on PR #77** (`feat/consent-cookies-tracking`), which ships
`lib/shared/consent.ts` + `lib/consent.ts` that all of Phase 3–4 code imports.
Attempted a first-party-only slice this session (attribution cookie + a
consent-gated no-vendor `track()` sink + event-taxonomy doc); **backed it out**
because it `import`s `@/lib/shared/consent`, which does not exist on `main`. It
cannot land without either merging #77 first or duplicating its consent module
(which would then conflict).

Also: Phases 3.1 / 4.2 need a signed vendor DPA + ad-account verification per the
plan's own ordering — not just a code task.

**PR #77 status as of handoff:** OPEN, `mergeable` but CI RED — `test`,
`integration`, and all 4 `e2e` jobs failing. Not merging imminently. Not our PR.

---

## RESUME PROCEDURE (run `scripts/resume-auth-phases.sh` or do this by hand)

### Step 0 — is #77 merged yet?
```
git fetch origin
git branch -r --contains origin/feat/consent-cookies-tracking | grep -q origin/main && echo MERGED || echo "still blocked"
```

### Step 1 — if NOT merged: only thing to do is push the branch (optional) and stop
```
git push -u origin feat/auth-cookies-phase-1-3-6   # branch only, DO NOT open a PR
```
Then wait. Nothing else is unblocked.

### Step 2 — once #77 IS merged: rebase this branch onto main
```
git fetch origin main
git checkout feat/auth-cookies-phase-1-3-6
git rebase origin/main
```
**Expected conflict: `lib/db/schema.sql`** — both branches append blocks at the
end. Resolution: keep BOTH #77's `consent_records` / `legal_consent_events`
blocks AND this branch's `privacy_requests` block, in that order. Pure
concatenation, no logic overlap.

No other file conflicts expected (middleware.ts, the 10 route handlers, and all
new files are untouched by #77).

### Step 3 — post-rebase wiring (now that lib/consent* exists)
1. **`app/api/privacy/export/route.ts`** (from #77) — it has a
   `TODO(privacy): add a per-user rate limit` comment. Wire in:
   ```ts
   import { rateLimit } from "@/lib/rate-limit";
   import { logPrivacyRequest } from "@/lib/privacy-requests-db";
   // in GET, after auth:
   const gate = rateLimit(`privacy:export:${userId}`, 3, 60*60_000);
   if (!gate.ok) return NextResponse.json({error:"rate_limited"},{status:429});
   await logPrivacyRequest({ userId, kind: "export", ip, userAgent });
   ```
2. **`app/api/privacy/delete/route.ts`** (from #77) — add
   `await logPrivacyRequest({ userId, kind: "delete", ... })` on both the dry-run
   and the confirmed-execute paths.
3. **`app/api/privacy/profile/route.ts`** (from #77) — surface the user's own
   request history: `import { listPrivacyRequests }` and add it to the payload.

### Step 4 — re-attempt Phases 3.2 / 4.1 (first-party, no vendor)
The backed-out files are NOT saved anywhere — rewrite from the plan + the
taxonomy design below. All of this is safe once `lib/shared/consent.ts` exists:
- `lib/shared/attribution.ts` — `nu_attrib` first-party cookie model (UTM +
  gclid/fbclid + referrer), `analytics` category, mobile-mirrorable. 90-day,
  first-touch-only.
- `lib/attribution-db.ts` + `user_attribution` table (`user_id` PK, `first_touch`
  jsonb, `last_touch` jsonb) — append at end of schema.sql.
- `app/api/attribution/route.ts` — consent-gated (`resolveConsent(readConsentFromRequest(req), hdrs)`,
  bail 204 if `!analytics`), sets the cookie, persists on authed calls.
- `docs/analytics-event-taxonomy.md` + `lib/analytics.ts` — `track({userId, event,
  props, consent})`, validates against `EVENT_SCHEMA`, no-op without
  `consent.choices.analytics`, `deliver()` is an empty stub until a vendor + DPA
  (Phase 3.1). Event list: signal_viewed, signal_shared, verdict_requested,
  council_session_started, nuai_prompt_submitted, watchlist_item_added,
  portfolio_health_run, backtest_viewed, paywall_hit, trial_started,
  subscription_started, referral_code_copied, disclaimer_acknowledged. Forbidden
  keys hard-rejected: holdings, positions, amount, portfolio_value, prompt,
  response, email, name, ip.

### Step 5 — check off the plan
Edit `docs/todo-auth-cookies-tracking.md` (now on main via #77): tick every
`[ ]` under **1.3** and the completed **Phase 6** items (export/profile/delete +
rectify + rate-limit + statutory-clock). Note 1.1/1.2 still pending Dashboard.

### Step 6 — migrate + ship ONE PR
```
node --env-file=.env.local scripts/db-migrate.mjs   # applies privacy_requests (+ user_attribution)
npx tsc --noEmit && npx eslint . && npx vitest run --project unit && npx next build
git push -u origin feat/auth-cookies-phase-1-3-6
gh pr create --title "feat(auth): Phase 1.3 + 6 — timing-safe auth, middleware coverage, DSAR rights" --body "..."
```

### Step 7 — wiki ingest (required by ~/.claude rules on `gh pr create`)
`docs/wiki-portal/` exists. Follow its `SCHEMA.md` "On Ingest": update/create
`entity-*` / `concept-*` for the auth-middleware change + DSAR ledger, bump
`index.md`, append one line to `log.md`. Also recompute
`concept-mobile-web-parity.md` headline % + matrix per
`~/.claude/rules/mobile-web-wiki-sync.md` (and mirror into
`gcp3-mobile/docs/wiki-mobile/`).

---

## Gotchas
- `.next/types/` goes stale between branches (references #77's routes). `rm -rf
  .next/types` before every `tsc --noEmit`.
- `scripts/db-migrate.mjs` reads ONLY `lib/db/schema.sql` — no multi-file
  migrations. New tables MUST be appended there.
- A stray local branch `docs/automation-logs` appeared mid-session (a hook
  artifact) and briefly captured a commit. It's reset to `73396fd` now. Ignore /
  delete it.
- Live-DB migration was permission-blocked this session; DDL verified to parse
  with the migrate splitter. It runs in `prebuild` on deploy regardless.
