# Self-implemented TOTP for the nulogdash admin gate — Plan

A plan for replacing Clerk's paid MFA feature with a self-implemented TOTP
second factor, scoped to the nulogdash admin console's mutating actions. This
doc is a plan only; nothing here is implemented yet.

Related: `docs/clerk-todos.md` (the P0 item this plan supersedes), `lib/nulogdash.ts`
(`canPerformAdminAction`, the check being replaced), `docs/nulogdash-admin-console-plan.md`
(the broader admin console this gate protects).

## Why

Clerk gates MFA (TOTP/SMS) behind its Pro plan ($25/mo) — confirmed via
Clerk's pricing page, listed explicitly in the Authentication & User Features
comparison table, not available on the free Hobby tier. `canPerformAdminAction`
in `lib/nulogdash.ts` already reads `user.twoFactorEnabled`, but since MFA was
never enabled at the Clerk-instance level, that flag can never be `true` for
anyone — the check is correct but permanently vacuous, and every admin is
stuck read-only.

Two directions were considered and rejected in favor of this one:

- **Pay for Clerk Pro** — simplest, but $25/mo to unlock a single boolean
  flag for what is, today, one admin console with a handful of allowlisted
  users.
- **Switch identity providers** (Auth0 free tier includes TOTP MFA at 25K
  MAU, Supabase Auth at 50K MAU) — much larger migration than the problem
  warrants; Clerk is used for session handling, webhooks, and subscription
  metadata (`lib/subscription.ts`) across the whole app, not just this gate.

Self-implementing TOTP keeps Clerk for everything it's already doing
(identity, sessions, webhooks) and adds a narrow, free, self-owned second
factor purely for the admin mutation gate. This is a well-trodden pattern —
TOTP (RFC 6238) is an open standard designed for exactly this: any
authenticator app (Google Authenticator, Authy, 1Password, etc.) works
without per-user coordination with Clerk.

## Scope

Replace the `user.twoFactorEnabled` read in `canPerformAdminAction` with a
verification against a TOTP secret we generate, encrypt, and store ourselves
in Neon — checked at the point of each mutating admin action, not merely
"enrolled at some point in the session."

This plan does **not** cover:
- MFA for the general user base (only the nulogdash admin surface).
- WebAuthn/passkeys (TOTP only, for v0 — see Open decisions).
- The impersonation-specific step-up reverification design in
  `docs/clerk-todos.md`'s P1 section — this plan provides the primitive
  (`verifyForAction`) that design would call, but doesn't itself decide
  impersonation's time-boxing or audit-row ordering.

## Design

### 1. Library

`otplib` (TOTP generation/verification, RFC 6238) + `qrcode` (renders the
enrollment QR as a data URI, no client-side JS dependency). Both MIT-licensed,
zero paid tier — `otplib` 13.4.1 (published 2026-05), `qrcode` 1.5.4.

**Use v13's API, not the v12 examples that dominate search results.** v13 is a
complete rewrite: the separate `authenticator` export is gone (TOTP now covers
it), legacy crypto adapters were replaced with audited `@noble/hashes` /
`@scure/base` plugins, and **the API is async-first**. The v12 idiom
(`authenticator.check(token, secret)`, synchronous) will not typecheck. Verified
v13 shape:

```ts
import { generateSecret, generateURI, verify } from "otplib";

const secret = generateSecret();                       // sync
const uri = generateURI({ issuer, label, secret });    // sync — feed to qrcode
const { valid } = await verify({ secret, token, epochTolerance: 30 }); // async
```

`generateSync`/`verifySync` exist only for sync-capable plugins
(`@otplib/plugin-crypto-node`); the default noble plugin is async. This is
why `confirmEnrollment` below is async too — not an arbitrary choice.

**`epochTolerance` must be passed explicitly — it has no forgiving default.**
v13 replaced v12's `window` option (a step count, e.g. `window: 1` = ±1 step)
with `epochTolerance` (seconds, either a number for symmetric tolerance or a
`[past, future]` tuple for asymmetric — RFC 6238 recommends past-only, to
absorb transmission delay without accepting future codes). **Its default is
`0`: exact match only, no clock-skew forgiveness at all.** An unset
`epochTolerance` isn't "reasonably lenient by default," it's "any admin whose
phone clock has drifted a few seconds is locked out." Every call site in this
plan (`confirmEnrollment`, `verifyForAction`) must pass `epochTolerance: 30`
explicitly to get the documented ±1-step-equivalent behavior — this is a
required line, not an optional tuning knob.

### 2. Schema — new table in `lib/db/schema.sql`

```sql
-- ── Admin TOTP credentials (self-implemented MFA for nulogdash) ──────────
-- Second factor for canPerformAdminAction, independent of Clerk's paid MFA
-- feature. One credential per admin; keyed by Clerk userId so it survives
-- email changes.

CREATE TABLE IF NOT EXISTS admin_totp_credentials (
  user_id              text PRIMARY KEY,        -- Clerk userId
  secret_cipher        bytea       NOT NULL,     -- AES-256-GCM ciphertext of the TOTP secret
  secret_iv            bytea       NOT NULL,     -- 12-byte GCM IV, unique per row
  secret_auth_tag      bytea       NOT NULL,     -- GCM auth tag
  -- Which ADMIN_TOTP_ENCRYPTION_KEY_V{n} encrypted this row. Lets a rotation
  -- re-wrap secrets one row at a time instead of invalidating every enrollment
  -- at once. NOT NULL with no default on purpose: a writer that forgets to set
  -- it fails loudly rather than silently claiming v1.
  key_version          int         NOT NULL,
  recovery_codes_hash  text[]      NOT NULL,     -- scrypt-hashed one-time recovery codes
  recovery_codes_used  int         NOT NULL DEFAULT 0,
  enrolled_at          timestamptz NOT NULL DEFAULT now(),
  last_used_at         timestamptz,
  -- Replay guard: the last TOTP counter step accepted for this user. A code is
  -- valid for ~30s, so without this the same code works repeatedly inside its
  -- window. Monotonic — verifyForAction rejects any step <= this value.
  last_used_step       bigint,
  -- Rate limiting (see Open decisions). Kept on the credential row rather than
  -- a separate table: it is 1:1 with the credential and needs the same
  -- transaction to be race-free.
  failed_attempts      int         NOT NULL DEFAULT 0,
  locked_until         timestamptz
);
```

The secret is encrypted at rest, not stored plaintext — a TOTP secret is a
long-lived shared credential equivalent to a password; a Neon read (backup
leak, misconfigured access, SQL injection elsewhere in the app) should not
be sufficient to mint valid codes for every admin.

### 2a. What this does and does not defend against

Stating this explicitly so the gate isn't credited with more than it provides:

| Threat | Defended? |
| --- | --- |
| Leaked/guessed admin email on the allowlist, no device | **Yes** — allowlist alone no longer grants mutation |
| Stolen Clerk session cookie | **Yes** for mutations (attacker lacks the current code); read-only console still exposed |
| Neon read (backup leak, SQLi, misconfigured access) | **Yes** — secrets are AES-256-GCM encrypted; key lives in env, not the DB |
| Env leak *and* DB leak together | **No** — attacker can mint codes. Accepted: that combination already implies full app compromise |
| Real-time phishing / adversary-in-the-middle | **No** — a captured code is replayable within its window by the relaying attacker. This is TOTP's known structural weakness and the reason passkeys are the eventual upgrade |
| Malicious/compromised admin acting deliberately | **No** — MFA proves possession, not intent. The `admin_actions` audit trail (`docs/clerk-todos.md` P1) is the control for this, not this gate |

### 3. Encryption keys — versioned from day one

Node's built-in `crypto` (`createCipheriv`/`createDecipheriv`, `aes-256-gcm`) —
no new crypto dependency beyond `otplib`/`qrcode`.

Keys are **versioned from the first commit**, not retrofitted. Env vars are
numbered rather than singular:

```text
ADMIN_TOTP_ENCRYPTION_KEY_V1=<openssl rand -base64 32>
ADMIN_TOTP_CURRENT_KEY_VERSION=1
```

- **Writes** always use `ADMIN_TOTP_CURRENT_KEY_VERSION`, stamping the row's
  `key_version`.
- **Reads** resolve the key by the row's `key_version`, so old and new
  ciphertexts coexist during a rotation.
- **Fail-closed**, matching `NULOGDASH_ADMIN_EMAILS`' framing in
  `.env.example`: a missing key for a requested version throws, and a missing
  `ADMIN_TOTP_CURRENT_KEY_VERSION` throws rather than defaulting to `1` — a
  silent default is how a rotation half-happens and nobody notices.

Why version now rather than later: the alternative is a single unversioned key,
where rotation means every stored secret becomes undecryptable simultaneously
and every admin must re-enroll from scratch. That's tolerable at today's admin
count and intolerable later — but the migration to add the column is *also*
harder later, because by then there are rows to backfill and a live gate
depending on them. A `NOT NULL int` column and a key-resolution lookup cost
almost nothing to add before any row exists. This is the cheap-now /
expensive-during-an-incident tradeoff the earlier draft flagged, resolved in
favor of now.

**Rotation procedure** (no re-enrollment, no downtime):

1. Add `ADMIN_TOTP_ENCRYPTION_KEY_V2`, leave `CURRENT_KEY_VERSION=1`. Deploy —
   nothing changes behaviorally; v2 is merely available.
2. Set `CURRENT_KEY_VERSION=2`. New enrollments and re-wraps now use v2; v1
   rows still decrypt fine.
3. Run a re-wrap task: for each row where `key_version < 2`, decrypt with its
   version, re-encrypt under v2 with a **fresh IV** (never reuse an IV across
   keys), update ciphertext + tag + IV + `key_version` in one transaction.
4. Once no rows report `key_version = 1`, remove `ADMIN_TOTP_ENCRYPTION_KEY_V1`
   from the environment.

Step 3 is the only step that touches rows, and it is idempotent — a partial run
leaves a valid mixed-version table that a re-run finishes. Verify with
`SELECT key_version, count(*) FROM admin_totp_credentials GROUP BY 1;` before
step 4; that query is also the thing to check if decryption starts failing.

A compromised key is a different procedure: rotation re-wraps secrets that the
attacker may already hold plaintext for, so a *suspected key leak* requires
revoking enrollments and having admins re-enroll with new secrets, not merely
re-wrapping the old ones. Rotation protects against key aging, not key
compromise.

### 4. New module `lib/admin-totp.ts`

Mirrors the existing `lib/nulogdash.ts` style (small exported functions,
explicit fail-closed defaults, doc comments explaining *why* not *what*):

- `generateEnrollment(userId): { secret, qrCodeDataUri, recoveryCodes }` —
  creates a new TOTP secret and `RECOVERY_CODE_COUNT` (a single exported
  constant, `= 10`) single-use recovery codes, returns them once for display,
  does **not** persist yet (persistence happens on confirmation, so an
  abandoned enrollment doesn't lock a user into an unconfirmed secret). Every
  other reference to the recovery-code count in this plan (rollout, UI,
  tests) reads this constant rather than restating a number, so the two
  don't drift out of sync with each other.
- `confirmEnrollment(userId, secret, code): Promise<boolean>` — verifies the
  user's first code against the just-generated secret, then persists the
  encrypted secret + hashed recovery codes. Async because `otplib` v13's
  `verify` is (see Library above). **`userId` is never taken from a request
  body or client-supplied argument** — every real call site resolves it from
  the authenticated Clerk session server-side (`auth()`'s `userId`, same as
  `canPerformAdminAction`'s own callers), and `secret` must be bound to a
  short-lived (~10 min) pending-enrollment record keyed by that session's
  `userId` rather than trusted as a bare parameter. Skipping this is the
  difference between "MFA" and "an attacker with a stolen Clerk cookie
  enrolls their own authenticator and passes `isEnrolled`" — the exact bypass
  the "why not an in-app reset" reasoning in Lost-device recovery already
  rules out for the *reset* path; enrollment needs the same discipline.
  Replacing an *existing* factor additionally requires a valid code against
  the current one first (self-service re-enroll, not a way around it).
- `verifyForAction(userId, code): Promise<boolean>` — the check mutating
  admin actions call, `userId` likewise from the session, never a parameter
  supplied by the caller's request. Accepts either a live 6-digit TOTP code
  or an unused recovery code (marking it consumed on success, matching
  standard TOTP recovery patterns). Must reject a code already used in the
  current time step — see Replay below. **The read-check-write for
  `last_used_step` (and recovery-code consumption, and `failed_attempts`)
  must happen in one transaction with row-level locking
  (`SELECT ... FOR UPDATE`) or a single conditional `UPDATE ... WHERE
  last_used_step < $step`, not a separate read then a separate write** — two
  concurrent requests reading the same prior step before either writes back
  would otherwise both accept the same code, silently defeating the replay
  guard under concurrency.
- `isEnrolled(userId): Promise<boolean>` — replaces the
  `user.twoFactorEnabled` read.
- `revokeEnrollment(userId, revokedBy, reason?): Promise<void>` — deletes the
  credential row **and** inserts the `admin_totp_revocations` row in one
  transaction (not two separate calls — a crash between them would either
  leave revocation unaudited or leave a dangling audit row for a credential
  that's still live). `revokedBy` is a required parameter, not optional:
  the schema's `revoked_by NOT NULL` only works if every caller — the CLI
  script included — is made to supply it rather than the function inventing
  a placeholder. **Not reachable from the web app** — see Lost-device
  recovery below. Exported for the CLI script and tests only.

### 5. `canPerformAdminAction` becomes async

```ts
// lib/nulogdash.ts
export async function canPerformAdminAction(
  user: AdminIdentity | undefined | null,
): Promise<boolean> {
  if (!isNulogdashAdmin(user)) return false;
  if (!user?.userId) return false;
  return isEnrolled(user.userId);
}
```

This is a **breaking signature change** (sync → async). Every call site and
all 28 cases in `__tests__/nulogdash-admin.test.ts` need updating:

- `app/dashboard/nulogdash/page.tsx` — already an async server component,
  so `await canPerformAdminAction(user)` is a one-line change.
- `AdminIdentity` needs a `userId: string` field added (currently only
  carries email/verification/twoFactorEnabled) so the function can look up
  the TOTP row — Clerk's `currentUser()` result already has `.id`, so this
  is available at every real call site; only the test fixtures need it.
- The `twoFactorEnabled` field on `AdminIdentity` becomes dead — remove it
  once no caller reads it, rather than leaving an unused flag that looks
  load-bearing.

### 6. Enrollment UI

New route `/dashboard/nulogdash/security` (admin-only via `isNulogdashAdmin`,
same `notFound()`-over-403 convention as the rest of the console): shows the
QR code + manual-entry secret, a confirmation code field, and displays the
recovery codes exactly once with a "save these now" warning. A server action
handles `confirmEnrollment`.

The page also shows enrollment state (`enrolled_at`, `last_used_at`,
`recovery_codes_used` / total remaining) so an admin can see that codes are
running low *before* they run out — which is the cheapest way to avoid the
recovery path entirely.

### 6a. Lost-device recovery

**Decision: recovery codes are the primary path; a local CLI script is the
break-glass. There is no in-app reset, and no second-admin approval flow.**

Three layers, cheapest first:

1. **Recovery codes** (covers the ordinary case). 10 single-use codes issued at
   enrollment. A lost phone is not a lockout — it's one recovery code. This is
   the whole reason they exist, and it means the paths below should be rare.
2. **Re-enroll while still authenticated** (covers "phone is dying / I'm
   switching devices"). If the admin can still produce a code or a recovery
   code, `/dashboard/nulogdash/security` lets them revoke-and-re-enroll in one
   step-up-verified flow. This is the graceful case and should be the one most
   often used.
3. **Break-glass CLI** (covers total loss: no device, no codes). A local script
   `scripts/revoke-admin-totp.ts`, run by whoever holds the `DATABASE_URL`, that
   calls `revokeEnrollment(userId)` and prints what it deleted. The next sign-in
   finds no credential and is prompted to enroll fresh.

**Why not a second-admin approval control.** It was the more "correct-looking"
option and it is wrong here: `NULOGDASH_ADMIN_EMAILS` currently resolves to a
single operator, so a two-person rule has nobody to ask. It would convert total
device loss from an inconvenience into a permanent, unrecoverable lockout of the
only admin — a self-inflicted denial of service dressed up as rigor. Revisit
only if the allowlist grows past ~3 people who are actually reachable.

**Why not an in-app "reset my MFA" button.** Any in-app reset reachable by a
session that has *not* proven the second factor is a bypass of the entire gate:
an attacker with a stolen Clerk cookie clicks reset, enrolls their own
authenticator, and now satisfies `canPerformAdminAction`. Email-link resets have
the same flaw one mailbox compromise away, and the mailbox is exactly what the
allowlist already trusts — MFA exists to stop email alone from being sufficient.
So the reset is deliberately pushed out of the web app entirely, into a
credential (`DATABASE_URL`) that a web attacker doesn't hold.

**Access equivalence, stated plainly.** Whoever holds `DATABASE_URL` can already
delete the credential row by hand; the script only makes that safe and legible
rather than a hand-written `DELETE`. This is not a new privilege — it is the
existing one, documented. The honest boundary is: *database access is admin
access.* Anyone with production `DATABASE_URL` can defeat this gate, which is
why that credential's handling matters more than the gate's own strength.

**Requirements on the script:**

- Takes an explicit `--user-id`; never a bare "reset all" or an email-prefix
  match that could hit the wrong row.
- Prints the target row's `enrolled_at` / `last_used_at` and requires a typed
  confirmation before deleting — this is a security-control removal, so it obeys
  the same "warn before destroying state" bar as the rest of this repo.
- Records the revocation. Until `admin_actions` exists (planned in
  `docs/nulogdash-admin-console-plan.md`, **not in `lib/db/schema.sql` today**),
  a revocation leaves no trace beyond the row vanishing. Interim: the script
  appends to a `admin_totp_revocations` table created alongside
  `admin_totp_credentials` — cheap, and it means the break-glass path is
  auditable from day one instead of retroactively.

```sql
-- Break-glass audit. Survives the credential row it describes, which is the
-- point: the interesting record is that a second factor was removed, by whom,
-- and when. Folds into admin_actions once that table exists.
CREATE TABLE IF NOT EXISTS admin_totp_revocations (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     text        NOT NULL,   -- whose credential was revoked
  revoked_by  text        NOT NULL,   -- operator identifier passed to the script
  reason      text,
  revoked_at  timestamptz NOT NULL DEFAULT now()
);
```

**Recovery-code hygiene**: re-issue the full set on re-enrollment (never top up
a partially-used set), and surface remaining count in the UI per 6 above. If
codes are exhausted without a device, that is the break-glass case — by design,
not by accident.

### 7. Step-up on mutating actions

Each server action gated by `canPerformAdminAction` (impersonate, disable,
reset password, reindex — per `docs/clerk-todos.md`) additionally calls
`verifyForAction(userId, code)` with a code the admin enters at the moment
of the action, not merely "enrolled at some point." This is what makes the
check step-up reverification rather than a one-time enrollment gate, and is
the primitive the impersonation P1 item in `clerk-todos.md` builds on.

## Open decisions

- ~~**Lost-device recovery**~~ — **decided**: recovery codes primary,
  authenticated re-enroll for device switches, local CLI break-glass for total
  loss. No in-app reset (it would bypass the gate) and no second-admin approval
  (single operator today; it would create an unrecoverable lockout). See
  "Lost-device recovery" above. Remaining sub-question: nothing blocking — but
  note the whole design rests on `DATABASE_URL` being treated as an admin
  credential, so revisit if that ever gets shared more widely than it is now.
- **WebAuthn/passkeys as a v1 upgrade**: TOTP is the standard baseline and
  what this plan builds, but passkeys are phishing-resistant in a way TOTP
  isn't (a captured code is still replayable within its 30s window). Worth
  revisiting once the admin console's blast radius grows past its current
  scope (see the "same app, not a separate deployment" revisit conditions
  in `docs/nulogdash-admin-console-plan.md`).
- **Rate limiting `verifyForAction` (blocking — must land before step-up
  ships).** A 6-digit code is 10⁶ values. With a ±1-step tolerance window
  three codes are simultaneously valid, so the per-guess hit rate is ~3/10⁶.
  Unlimited guessing at a modest 100 req/s yields ~3,000 attempts per 30s
  window ≈ 0.9% chance per window, i.e. better-than-even odds within about
  90 minutes of sustained guessing — and each attempt is cheap for the
  attacker. RFC 6238 §5.2 requires throttling for exactly this reason.
  Proposal: 5 failures → lock 15 min (`failed_attempts` / `locked_until`
  columns above), reset on success. The counter must be updated in the same
  transaction as the verify to avoid a concurrent-request bypass.
- ~~**Clock skew tolerance**~~ — **decided**: `epochTolerance: 30` passed
  explicitly at every `verify` call (see Library above) — v13's default is
  `0`, exact match only, not a forgiving ±1 step as the original draft of
  this plan assumed. Widening beyond 30s trades brute-force resistance (see
  rate-limiting math above, which assumes exactly this tolerance) for
  forgiveness of unsynced phones; only widen if enrollment testing shows
  real failures at 30s.
- ~~**Encryption key rotation**~~ — **decided**: versioned keys from day one
  (`key_version` column + numbered `ADMIN_TOTP_ENCRYPTION_KEY_V{n}` env vars).
  See "Encryption keys" above for the rotation procedure. Remaining sub-question
  is only operational: whether rotation is calendar-driven (e.g. annually) or
  event-driven (personnel change, suspected exposure). Note that a suspected key
  *compromise* needs re-enrollment, not rotation.

## Testing

Time-dependent and crypto-dependent code is exactly where fixture-driven tests
earn their keep, in the style of the existing `__tests__/nulogdash-admin.test.ts`.
Inject the clock (don't call `Date.now()` inside the module) so these are
deterministic rather than flaky:

- **RFC 6238 test vectors** — verify the TOTP implementation against the
  published vectors, so a library upgrade that changes defaults fails loudly
  instead of silently accepting wrong codes.
- **Replay** — the same code at the same step is accepted once, rejected the
  second time (`last_used_step`).
- **Concurrent replay** — two simultaneous `verifyForAction` calls with the
  same code/step: exactly one succeeds, the other observes the already-
  advanced `last_used_step` and is rejected. This is the case a naive
  read-then-write implementation gets wrong (`SELECT` then `UPDATE` as two
  statements loses the race); the test should exercise the actual
  transaction/locking mechanism, not just the sequential case above.
- **Skew** — a code from the adjacent step is accepted; one two steps away is
  rejected.
- **Rate limit** — the 6th failure locks; a correct code during lockout is
  still rejected; success resets the counter.
- **Recovery codes** — single-use (second presentation fails), consuming one
  increments `recovery_codes_used`, re-enrollment issues a fresh full set rather
  than topping up, and an exhausted set denies rather than falling open.
- **Revocation** — `revokeEnrollment` removes the credential and writes an
  `admin_totp_revocations` row; a revoked user reports `isEnrolled === false`
  and so cannot mutate until re-enrolled; the revocation row survives the
  credential's deletion.
- **Crypto round-trip** — encrypt/decrypt returns the original secret; a
  tampered `secret_auth_tag` throws rather than returning garbage (this is the
  point of GCM over CBC).
- **Key versioning** — a row written under v1 still decrypts after
  `CURRENT_KEY_VERSION` moves to v2; a row whose `key_version` has no
  corresponding env key throws (not silently falls back to another version);
  re-wrap produces a new IV rather than reusing the old one; re-wrap is
  idempotent, so a re-run over an already-migrated table is a no-op.
- **Fail-closed** — unset key env vars throw (including a missing
  `ADMIN_TOTP_CURRENT_KEY_VERSION`, which must not default to `1`); unenrolled user
  returns `false` from `isEnrolled`; `canPerformAdminAction` returns `false`
  for a non-allowlisted user regardless of TOTP state.

## Rollout

Ordered so the app is never in a state where the gate is weaker than it is
today. Steps 1–3 are additive (nothing reads the new table yet); step 5 is the
cutover.

**Step 5 must ship `verifyForAction` alongside the `canPerformAdminAction`
cutover, not after it.** An earlier draft of this rollout put step-up
verification in a later step (old step 6), which would have left a window
where `canPerformAdminAction` accepts *enrollment having happened at some
point* as sufficient for mutation — no current code required — precisely the
"enrolled at some point in the session" weakness Scope and section 7 both
already reject. Since no mutating admin actions exist yet (they're gated only
in the abstract, per `docs/nulogdash-admin-console-plan.md`), the ordering
below has no real intermediate state to worry about — but if any mutating
action ships before this plan completes, `canPerformAdminAction` must not go
live on its own.

1. Schema migration (`lib/db/schema.sql` + `npm run db:migrate`); document
   `ADMIN_TOTP_ENCRYPTION_KEY_V1` and `ADMIN_TOTP_CURRENT_KEY_VERSION=1` in
   `.env.example` and set both in Vercel (all environments — a missing key in
   Preview surfaces as enrollment throwing, not as a silent bypass).
2. `lib/admin-totp.ts` + unit tests (see Testing above), including the rate
   limiter and the transactional replay/consumption guards — neither is a
   follow-up.
3. Enrollment UI route, still gated only by `isNulogdashAdmin`.
4. **Each admin enrolls before the gate flips**, saves their recovery codes, and
   `scripts/revoke-admin-totp.ts` exists and has been exercised once against a
   throwaway row. Enrolling after step 5 locks every admin out of their own
   mutation path; shipping without a tested break-glass means the first lost
   device is an outage.
5. `canPerformAdminAction` async migration **and** `verifyForAction` land
   together, existing 28 test cases updated. This is the cutover — mutations
   now require both enrollment and a fresh code, not enrollment alone.
6. `verifyForAction` wired into each mutating server action as those actions
   are built (they don't fully exist yet per
   `docs/nulogdash-admin-console-plan.md`) — the primitive already exists as
   of step 5, this step is only "call it from new code," not "build it."
7. Update `docs/clerk-todos.md` (P0 already marked superseded) and ingest into
   `docs/wiki-portal/` per that folder's `SCHEMA.md` — this introduces a new
   entity (the admin TOTP credential) and a decision (self-implement over
   Clerk Pro) the wiki should carry.

**Rollback**: before step 5, revert is a no-op (nothing reads the table).
After step 5, **do not** revert `canPerformAdminAction` to
`return isNulogdashAdmin(user)` — that removes both Clerk MFA (already
vacuous) and TOTP at once, silently permitting every allowlisted admin to
mutate with no second factor at all, which is strictly weaker than the
pre-rollout state this plan exists to fix. Instead, roll back to
`return false` (deny all mutation, matching today's actual vacuous-flag
behavior of "no one can mutate") until the forward fix lands — read access via
`isNulogdashAdmin` is unaffected either way, so this only blocks mutating
actions, not the console itself.
