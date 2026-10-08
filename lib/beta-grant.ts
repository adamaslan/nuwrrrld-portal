/**
 * Beta-tester grants stored on the Clerk user (`publicMetadata.beta`).
 *
 * Pure and dependency-free so gcp3-mobile can adopt a byte-identical copy
 * (docs/beta-testers-robust-plan.md §5A) without touching lib/subscription.ts.
 * Only the Clerk backend secret key can write publicMetadata, so a grant
 * cannot be self-assigned by a user.
 *
 * Shape: { beta: { tier: 'pro', grantedAt, expiresAt: string | null, ... } }
 */

/** `now` is injectable so expiry is testable without fake timers. */
export function hasActiveBetaGrant(
  publicMetadata: Record<string, unknown> | null | undefined,
  now: Date = new Date(),
): boolean {
  const beta = publicMetadata?.beta;
  if (typeof beta !== 'object' || beta === null) return false;

  const { tier, expiresAt } = beta as Record<string, unknown>;
  if (tier !== 'pro') return false;

  if (expiresAt === null || expiresAt === undefined) return true;
  if (typeof expiresAt !== 'string') return false;

  const expiry = Date.parse(expiresAt);
  // A malformed expiry fails closed — a typo must not become a permanent grant.
  if (Number.isNaN(expiry)) return false;
  return expiry > now.getTime();
}
