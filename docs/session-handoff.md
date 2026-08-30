# Session handoff — auth/cookies plan

**Date:** 2026-08-29
**Branch:** `feat/auth-cookies-phase-1-3-6` — **contains a local merge of the
consent branch** (`origin/feat/consent-cookies-tracking`, PR #77). Not pushed as
a PR yet, by instruction.

## Why this branch contains PR #77

Phases 3/4/5/7 import `lib/shared/consent.ts` + `lib/consent.ts`, which live
only on PR #77. #77 is MERGEABLE but its CI is red, so waiting for it to reach
`main` would have blocked everything. Merging it in locally cost exactly **one**
conflict (`lib/db/schema.sql`, both sides append-only DDL — resolved by keeping
both blocks) and unblocked four phases. When #77 merges to `main`, its commits
drop out of this branch's diff automatically.

## Done

| Phase | What shipped |
|---|---|
| **1.3** | `lib/http-auth.ts` (Edge-safe pure-JS constant-time compare — do NOT reintroduce `node:crypto`, it breaks the Edge middleware bundle); 10 internal-secret routes off `===`; middleware matcher 3→23 prefixes; `docs/API-ROUTE-AUTH.md` |
| **6** | `/api/privacy/rectify`; `privacy_requests` statutory-clock ledger; `lib/rate-limit.ts`; export rate-limited 3/hr + ledgered; delete ledgered on both paths; profile returns DSAR history |
| **3.2** | `docs/analytics-event-taxonomy.md` (13 events); `lib/analytics.ts` — consent-gated, validates, drops. `deliver()` is the stub Phase 3.1 fills. |
| **4.1** | `lib/shared/attribution.ts`, `nu_attrib` cookie, `user_attribution`, consent-gated `/api/attribution` |
| **1.4, 2** | from PR #77 (merged in) |

Verified: tsc, eslint, `check-shared-drift`, `next build` all clean; 421 unit
tests pass.

## Not done — and why (none are engineering blockers)

- **1.1 / 1.2** — Clerk Production instance + session posture. Needs Clerk
  **Dashboard** access + DNS for `clerk.financial.nuwrrrld.com`. Pure config.
- **3.1** — analytics vendor. Needs a signed DPA first (plan §3.1). The sink is
  built; wiring a vendor is one function (`deliver()` in `lib/analytics.ts`).
- **3.3** — session replay. **Decided: off** on authenticated financial screens.
- **4.2–4.4** — ad pixels, Consent Mode v2, "Do Not Sell or Share" link. No
  pixel ships before 3.1 + legal review.
- **5** — full `customer_profile` store. Partially served by
  `/api/privacy/profile`; the rest wants Phase 3 data that doesn't exist yet.
- **7** — policy rewrite. Plan §7 requires a qualified pre-launch review.

## Next steps

1. `node --env-file=.env.local scripts/db-migrate.mjs` — applies
   `privacy_requests` + `user_attribution` (+ #77's consent tables). Was
   permission-blocked in the authoring session; DDL verified to parse.
2. Mount the attribution capture client-side on the landing page (POST the
   current `location.search` + `document.referrer` to `/api/attribution`).
3. Open **one** PR. Then the wiki ingest: `docs/wiki-portal/` per its
   `SCHEMA.md`, plus recompute `concept-mobile-web-parity.md` in both this repo
   and `gcp3-mobile/docs/wiki-mobile/` per
   `~/.claude/rules/mobile-web-wiki-sync.md`.
4. Mirror `lib/shared/attribution.ts` into `gcp3-mobile` (it is written to be
   mirrored; `scripts/check-shared-drift.mjs` currently passes).

## Gotchas

- `rm -rf .next/types` before `tsc --noEmit` — stale route types across branches.
- `scripts/db-migrate.mjs` reads ONLY `lib/db/schema.sql`; new tables append there.
- A stray local branch `docs/automation-logs` appeared mid-session (hook
  artifact), reset to `73396fd`. Ignore or delete.
- `scripts/resume-auth-phases.sh` predates the local merge — its "wait for #77"
  gate is now obsolete for this branch.
