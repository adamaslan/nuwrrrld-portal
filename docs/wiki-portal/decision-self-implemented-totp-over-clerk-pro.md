---
date: 2026-08-17
type: decision
tags: [auth, clerk, mfa, totp, nulogdash, security]
sources: [docs/admin-totp-plan.md, docs/clerk-todos.md, lib/nulogdash.ts, lib/nulogdash-actions.ts, PR#63]
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

## Update — the gate now has its first real consumer (2026-09-08)

The nulogdash pipeline **trigger buttons** (`lib/nulogdash-actions.ts`,
[[decision-nulogdash-browser-trigger-handshake]]) render and function only under
`canPerformAdminAction`. Until this, the gate protected nothing — it was a
correct check with no call site. Now the console's one write path sits behind
it, which means: with `twoFactorEnabled` permanently `false` on the free Clerk
tier, **every operator is dry-run-only in the browser**, and the self-TOTP plan
is what stands between "the buttons exist" and "the buttons work". The rate
limiter this decision lists as a **blocking** prerequisite is partly in place
for the trigger path (`lib/rate-limit.ts`, 1 live run / pipeline / 5 min / user)
but is still the in-process best-effort limiter, not the hardened one
`docs/admin-totp-plan.md` specifies.

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
- [[entity-clerk]] — full picture of this app's Clerk usage and its free-plan
  constraints
- [[decision-clerk-subdomain-without-satellite]] — the other free-plan
  limitation hit on this instance (satellite domains, not MFA), from the
  2026-09-02 production cutover
- [[decision-nulogdash-browser-trigger-handshake]] — the write path that made
  this gate load-bearing
- [[entity-model-usage-log]] — the pipeline audit table the gated buttons fire
