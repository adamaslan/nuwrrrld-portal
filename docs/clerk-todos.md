# Clerk — Open TODOs

Auth-related work that is known, deliberate, and not yet done. Scope is
Clerk specifically: session handling, the admin gate, user metadata, and
webhooks. Anything here that turns out to be wrong should be corrected in
place rather than left to rot — this file is only useful if it tracks
reality.

Related: `docs/nulogdash-admin-console-plan.md` (admin console plan, whose
gating section this file's P0/P1 items feed), `docs/wiki-portal/entity-billing.md`
(subscription metadata lives on the Clerk user).

Priority key: **P0** blocks the admin console's mutating actions ·
**P1** should land before the console grows past read-only ·
**P2** correctness/hygiene, no known exploit.

---

## P0 — Enforce MFA in the Clerk dashboard

**Status: half done.** The application-side check exists
(`canPerformAdminAction` in `lib/nulogdash.ts`, pinned by
`__tests__/nulogdash-admin.test.ts`), and the nulogdash console shows an
un-enrolled admin a notice explaining that mutating actions are withheld.

What is **not** done is the Clerk-side half:

- [ ] Enable a second factor (TOTP at minimum) in the Clerk dashboard for
      the instance. `twoFactorEnabled` can never be `true` for anyone until
      MFA is actually offered, so today `canPerformAdminAction` returns
      `false` for every user — correct, but vacuous.
- [ ] Enrol each address in `NULOGDASH_ADMIN_EMAILS` in a second factor.
- [ ] Decide whether MFA is *required* for admins at the Clerk level, or
      only enforced by our `canPerformAdminAction` check. Belt-and-braces
      is preferable: a Clerk-level requirement means a new admin can't skip
      it, while our check means a Clerk misconfiguration still fails closed.

**Why it matters:** an env-var email allowlist is one string comparison
away from full admin access. Acceptable for reading a test-sweep report;
not acceptable for impersonate/disable/reset-password.

---

## P0 — `NULOGDASH_ADMIN_EMAILS` is undocumented and unvalidated

The variable is read directly via `process.env` in `lib/nulogdash.ts` and
appears **nowhere else** — not in `.env.example`, and there is no env schema
module in this branch (no `lib/env.ts`).

- [ ] Add `NULOGDASH_ADMIN_EMAILS` to `.env.example` with a comment stating
      the format (comma-separated) and that empty/unset denies everyone.
- [ ] Decide whether this app wants a validated env module at all. If yes,
      that is its own task and this variable should be part of it; if no,
      record that decision so the absence stops looking like an oversight.

**Why it matters:** an admin allowlist that isn't in `.env.example` is one
a new deploy silently omits. The fail-closed default makes that safe rather
than catastrophic, but it presents as "the console 404s for everyone" with
no obvious cause.

---

## P1 — Audit remaining `emailAddresses[0]` reads

The admin gate was fixed to resolve the **primary, verified** address (see
`lib/nulogdash.ts`). One other site still uses the old index-0 pattern:

- [ ] `app/dashboard/beta/page.tsx:20` —
      `user?.emailAddresses?.[0]?.emailAddress ?? ""`. This is **display and
      feedback-attribution only**, not an access-control gate, so it is not
      the same severity. It can still show the wrong address for a user with
      several, and attribute feedback to an address they don't consider
      theirs.
- [ ] Consider extracting a shared `primaryEmail(user)` helper so index-0
      reads stop being reintroduced by copy-paste. The gate deliberately
      takes the user object rather than a string for this reason; a helper
      gives non-gate callers the same correctness without loosening that.

---

## P1 — Impersonation is the highest-risk action, treat it as such

Not yet built (see the Actions section of the admin console plan), but the
decision should be made before the code exists:

- [ ] Require re-verification immediately before an impersonation starts,
      not merely an MFA-enrolled session. Clerk supports step-up
      reverification; a session that authenticated hours ago should not be
      able to impersonate on the strength of that alone.
- [ ] Write the `admin_actions` audit row **before** the impersonated
      session is issued, so an impersonation that crashes mid-flight still
      leaves a trace.
- [ ] Decide whether impersonation is time-boxed and how it visibly ends.

**Why it matters:** impersonation converts one compromised admin session
into arbitrary user access, and it is the admin action least likely to look
anomalous in logs — it produces exactly the traffic a real user would.

---

## P2 — Clerk webhook hardening

`app/api/webhooks/clerk/route.ts` uses `verifyWebhook` from
`@clerk/nextjs/webhooks`, which is the correct primitive (signature
verification, not a bare secret comparison).

- [ ] Confirm the signing secret is set in every deployed environment, and
      that a verification failure is logged loudly rather than swallowed.
- [ ] Confirm replay behaviour: `verifyWebhook` checks the Svix timestamp,
      but the handler should be idempotent regardless, since Clerk retries.

---

## P2 — Session/JWT claim decisions

- [ ] Subscription tier currently rides on Clerk `publicMetadata`
      (`parseSubscriptionMetadata`, see `lib/subscription.ts` and
      `docs/wiki-portal/entity-billing.md`). Note that `publicMetadata` is
      readable by the client — fine for a tier label, wrong for anything
      that must not be user-visible. Keep entitlement *decisions* server-side.
- [ ] If admin status ever moves off the env allowlist onto a Clerk claim or
      org role, it must be `privateMetadata` or an org role — never
      `publicMetadata`, which the user can read and which would advertise
      the existence of the admin surface.

---

## Done

- [x] **Admin gate reads the primary, verified email.** Was
      `emailAddresses[0]` with no verification check, allowing two bypasses:
      an unverified allowlisted address, and a non-primary allowlisted
      address at index 0. Fixed in `lib/nulogdash.ts`; pinned by 22 cases in
      `__tests__/nulogdash-admin.test.ts`.
- [x] **`isNulogdashAdmin` takes the Clerk user, not an email string.**
      Passing a string let the caller resolve the address, which is what
      made both bypasses reachable. The signature now makes the unsafe call
      unrepresentable — keep it that way.
- [x] **Read access separated from mutate permission.**
      `canPerformAdminAction` requires MFA on top of the identity checks, so
      an un-enrolled admin still reads reports instead of hitting an
      unexplained `notFound()`.
