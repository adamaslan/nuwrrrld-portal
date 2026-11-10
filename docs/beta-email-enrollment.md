# Email-first beta enrollment

Draft implementation. No live grants or invitations were created during development.

## Owner flow

Open nulogdash > Beta testers and enter an email. Optional expiry and note stay collapsed.

- Existing account with that verified address: the existing per-user beta metadata grant applies.
- No account: save an email-based grant in the adding admin's private Clerk metadata. The user signs up normally and verifies that email as their primary address. Server-side feature gates then check the current admin registry.
- An existing unverified claimant is rejected. They must verify their email first.
- Share the ordinary signup link if useful. It contains no invitation ticket, credential or entitlement. Anyone can open it; only a qualifying verified primary email gets beta.

No invitation is created, and no email is sent automatically. In particular, this does not use Clerk application invitations, which can automatically verify the invited address when their bearer link is used. The earlier invitation implementation in this draft PR is superseded.

## Storage and boundaries

The adding admin's `privateMetadata.nwfBetaEmails` contains SHA-256 email keys and email/grant records. Hashing keys avoids unsafe nested key names; emails remain personal data in backend-only private metadata. This is not encryption. Metadata updates merge one entry, preserving other metadata. There is no new database, migration, environment setting, billing change or role change.

Each admin can store up to ten email-based grants. A conservative 7,000-byte total metadata budget leaves headroom under Clerk's 8KB limit. Capacity errors are explicit, not successful no-ops. Concurrent different-key updates use Clerk's deep merge rather than replacing a stale whole map; the provider's metadata limit remains authoritative.

Only users who still meet the existing verified-primary-email admin allowlist can supply a registry. Changing the admin allowlist or losing verified-primary status stops that registry from qualifying. A missing, incomplete or failed registry read denies email-based beta. Existing paid plans, direct user grants and the existing built-in beta path retain their prior behavior.

Email-based grants are evaluated on authoritative server reads rather than copied into another user's metadata. Revocation removes the current admin's registry key and stops that grant on the next check. It does not revoke another admin's independent grant, an existing direct user grant, or paid access. Registry entries remain until revoked, even after signup. The panel distinguishes registry grants from direct account grants.

The existing configured MFA policy is unchanged. MFA is required only when `NULOGDASH_REQUIRE_MFA=true`.

## Validation and remaining work

Unit and component tests cover metadata merge shape, capacity, admin gating, normal signup link, verified-primary matching, unverified/secondary/different claimants, expiry, revocation, provider errors and partial registry reads. All server entitlement callers use the async registry-aware wrapper. The shared mobile subscription module is unchanged; billing views continue to show real Stripe state.

A real signup/verification/grant/revoke test still requires an authorized test recipient and environment. Local tests and screenshots are not that proof. Independent exact-head review, required CI and source-bound deployed proof remain release gates. Nothing here authorizes issuing actual grants, sending messages or deploying to production.
