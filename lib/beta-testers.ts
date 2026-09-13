/**
 * Portal-only beta-tester Pro allowlist.
 *
 * Deliberately NOT part of lib/subscription.ts — that file must stay
 * byte-identical to gcp3-mobile's copy (docs/wiki-portal/concept-sync-requirements.md
 * §1). This sits alongside lib/subscription-admin.ts, which applies it.
 *
 * A beta tester is NOT an admin: this grants Pro feature entitlements only,
 * never the nulogdash console or any mutating admin action. The two
 * allowlists are separate env vars so widening beta access can never widen
 * admin access by accident.
 */

/**
 * Minimal identity shape needed to check the allowlist — structurally
 * satisfied by Clerk's `currentUser()` result, so this module never depends
 * on Clerk's User type directly. Mirrors lib/subscription-admin.ts's
 * TierAdminIdentity.
 */
export interface BetaTesterIdentity {
  primaryEmailAddressId: string | null;
  emailAddresses: {
    id: string;
    emailAddress: string;
    verification: { status: string | null } | null;
  }[];
}

/**
 * Beta testers that are always allowlisted, in every environment.
 *
 * Checked into source on purpose: the requirement is "free Pro locally AND
 * on the cloud", and an env-var-only list silently grants nothing wherever
 * the var wasn't set — which for a tester reads as "the app is broken", not
 * as "config is missing". These are not secrets. Additional testers go in
 * BETA_TESTER_EMAILS so the list can change without a deploy.
 */
const BUILT_IN_BETA_TESTERS: readonly string[] = ['chillcoders@gmail.com'];

/** Env-var additions, merged with the built-ins. Unset ⇒ built-ins only. */
function allowlist(): string[] {
  const fromEnv = (process.env.BETA_TESTER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...BUILT_IN_BETA_TESTERS, ...fromEnv];
}

/**
 * Whether this user is an allowlisted beta tester.
 *
 * Takes the Clerk user rather than a bare email for the same reason
 * `isNulogdashAdmin` does: only the PRIMARY address counts (a user can hold
 * and reorder several), and it must be VERIFIED — otherwise anyone able to
 * sign up with an allowlisted address gets Pro without proving they own it.
 */
export function isBetaTester(user: BetaTesterIdentity | undefined | null): boolean {
  if (!user?.primaryEmailAddressId) return false;

  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  if (!primary) return false;
  if (primary.verification?.status !== 'verified') return false;

  return allowlist().includes(primary.emailAddress.trim().toLowerCase());
}
