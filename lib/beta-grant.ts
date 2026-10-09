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
const LEADING_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

function hasValidCalendarDate(value: string): boolean {
  const match = LEADING_ISO_DATE.exec(value);
  if (!match) return true; // non-ISO forms are left to Date.parse's own result
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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
  // Date.parse normalizes impossible calendar dates ("2027-02-30" → Mar 2), so
  // the leading Y-M-D must round-trip or the grant is treated as malformed.
  if (!hasValidCalendarDate(expiresAt)) return false;
  return expiry > now.getTime();
}

/** Default lifetime for a new grant (owner decision, 2026-10-08). */
export const DEFAULT_GRANT_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export interface BetaGrant {
  tier: 'pro';
  grantedAt: string;
  expiresAt: string | null;
  grantedBy: string;
  note?: string;
}

/**
 * Build the `publicMetadata.beta` value. `expiresInDays: null` means no
 * expiry; undefined means DEFAULT_GRANT_DAYS. Dates are ISO `YYYY-MM-DD`.
 */
export function buildBetaGrant(opts: {
  now?: Date;
  expiresInDays?: number | null;
  grantedBy?: string;
  note?: string;
}): BetaGrant {
  const now = opts.now ?? new Date();
  const days = opts.expiresInDays === undefined ? DEFAULT_GRANT_DAYS : opts.expiresInDays;
  const expiresAt =
    days === null ? null : new Date(now.getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
  const note = opts.note?.trim().slice(0, 120);
  return {
    tier: 'pro',
    grantedAt: now.toISOString().slice(0, 10),
    expiresAt,
    grantedBy: opts.grantedBy ?? 'admin',
    ...(note ? { note } : {}),
  };
}
