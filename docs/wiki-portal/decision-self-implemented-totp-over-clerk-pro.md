---
date: 2026-08-17
type: decision
tags: [auth, clerk, mfa, totp, nulogdash, security]
sources: [docs/admin-totp-plan.md, docs/clerk-todos.md, lib/nulogdash.ts, PR#63]
---

# decision: self-implement TOTP rather than pay for Clerk Pro or migrate providers

## Decision

The nulogdash admin console's mutation gate (`canPerformAdminAction` in
`lib/nulogdash.ts`) will get its second factor from a self-implemented TOTP
(RFC 6238) system — new `admin_totp_credentials` table in Neon, `otplib` +
`qrcode`, secrets encrypted at rest with a versioned key scheme — rather than
from Clerk's native MFA feature. **Not yet implemented**; `docs/admin-totp-plan.md`
is the full design, this page records the choice and why the two obvious
alternatives were rejected.

## Date

2026-08-17 (plan authored; implementation not started as of this page)

## Context

`canPerformAdminAction` already reads `user.twoFactorEnabled` from Clerk and
has since it was written (see [[incident-2026-08-06-bugmerge1-command-file-loss]]'s
sibling PR #60, which recovered this console with the MFA gate in place). That
flag can never be `true`, though: Clerk gates MFA (TOTP/SMS) behind its **Pro
plan, $25/mo** — confirmed via Clerk's pricing page, not available on the free
Hobby tier this app runs on. The check is correct but permanently vacuous —
every allowlisted admin is stuck read-only, which is [[entity-billing]]'s
"Clerk is the source of truth for entitlements" model running into its own
cost boundary for a feature the *app itself* needs, not an end user.

## Alternatives considered

- **Pay for Clerk Pro ($25/mo).** Rejected: unlocks a single boolean flag for
  what is currently one admin console with effectively one operator
  (`NULOGDASH_ADMIN_EMAILS` resolves to a single address today — see
  `docs/admin-totp-plan.md`'s lost-device-recovery section, which had to
  design around exactly this).
- **Migrate identity providers** (Auth0 free tier includes TOTP at 25K MAU,
  Supabase Auth at 50K MAU). Rejected: Clerk is load-bearing across the whole
  app — session handling, `app/api/webhooks/clerk/route.ts`, and the
  `publicMetadata` entitlement model [[entity-billing]] documents — not just
  this one gate. Migrating the app's entire identity layer to unblock one
  admin console is a wildly disproportionate response.
- **Self-implement TOTP** (chosen). Keeps Clerk for everything it already does
  well; adds a narrow, free, self-owned second factor scoped only to the admin
  mutation gate. TOTP is an open standard (RFC 6238) built for exactly this —
  any authenticator app works without per-user Clerk coordination.

## Consequences

- New attack surface the app now owns directly: TOTP secrets stored in Neon
  (encrypted, `admin_totp_credentials.secret_cipher` + versioned keys —
  `ADMIN_TOTP_ENCRYPTION_KEY_V{n}` / `ADMIN_TOTP_CURRENT_KEY_VERSION`), a
  replay guard (`last_used_step`), and a rate limiter that did not previously
  exist and is a **blocking** requirement before step-up ships (without it,
  RFC 6238 §5.2's brute-force math gives ~90 minutes to a >50% chance of a
  code guess at a modest 100 req/s).
- Lost-device recovery had to be designed from scratch — Clerk would have
  owned this. Resolved as recovery codes → authenticated re-enroll → a local
  CLI break-glass script, explicitly **not** a second-admin approval (no
  second admin exists) and **not** an in-app reset (would bypass the gate: a
  stolen session could self-enroll a new factor).
- Explicit threat-model gap accepted: this defends against a stolen Clerk
  session or a leaked-but-unverified allowlist email, but **not** real-time
  phishing/adversary-in-the-middle (a captured code is replayable within its
  window) and **not** a malicious admin acting deliberately (MFA proves
  possession, not intent — that's [[decision-four-field-verdict-scaffold]]'s
  sibling problem in a different subsystem: no control here substitutes for
  the still-unbuilt `admin_actions` audit trail per `docs/clerk-todos.md` P1).
- `docs/clerk-todos.md`'s "Enforce MFA in the Clerk dashboard" P0 item is
  marked superseded by this decision rather than done — the Clerk-native
  approach it described is no longer the plan.

## Validated by

Not yet — plan only. Will be validated by `docs/admin-totp-plan.md`'s own
testing section (RFC 6238 vectors, replay, skew, rate-limit lockout, recovery
code single-use, crypto round-trip, key-version resolution, fail-closed cases)
once implemented.

## See also

- `docs/admin-totp-plan.md` — the full design this decision summarizes
- [[entity-billing]] — the Clerk/Stripe entity this gate is a narrow exception
  to (Clerk remains the source of truth for *user* entitlements; this decision
  only carves out the admin-console second factor)
- [[entity-dev-command-suite]] — nulogdash's place in the dev tooling catalog
- `docs/clerk-todos.md` — the P0/P1 checklist this decision partially resolves
