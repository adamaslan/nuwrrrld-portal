/**
 * Portal-only Pro-tier override for nulogdash admins.
 *
 * Deliberately NOT part of lib/subscription.ts — that file must stay
 * byte-identical to gcp3-mobile's copy (docs/wiki-portal/concept-sync-requirements.md
 * §1; mobile PR #29 de-drifted it once already). nulogdash has no mobile
 * equivalent, so admin-tier logic belongs in a portal-only module instead of
 * inside the shared one.
 */

import { isNulogdashAdmin } from './nulogdash';
import {
  parseSubscriptionMetadata,
  tierFromStatus,
  type SubscriptionState,
  type SubscriptionStatus,
  type SubscriptionTier,
} from './subscription';

/**
 * Minimal shape needed to check the nulogdash admin allowlist, duplicated
 * from lib/nulogdash.ts's AdminIdentity rather than imported, so this module
 * never depends on Clerk's User type directly — callers pass their
 * already-fetched `currentUser()` result, which satisfies this structurally.
 */
export interface TierAdminIdentity {
  primaryEmailAddressId: string | null;
  emailAddresses: {
    id: string;
    emailAddress: string;
    verification: { status: string | null } | null;
  }[];
}

/**
 * Effective tier for feature gating: an allowlisted nulogdash admin
 * (NULOGDASH_ADMIN_EMAILS) always resolves to 'pro', independent of Stripe
 * status — lets admins exercise Pro features without a real subscription.
 * Real billing pages (dashboard/billing, dashboard/upgrade) intentionally
 * bypass this and read tierFromStatus() directly, since they display actual
 * Stripe state and a fabricated "Pro" plan there would be misleading.
 */
export function resolveTier(
  status: SubscriptionStatus,
  adminIdentity: TierAdminIdentity | null | undefined,
): SubscriptionTier {
  if (isNulogdashAdmin(adminIdentity)) return 'pro';
  return tierFromStatus(status);
}

/**
 * parseSubscriptionMetadata, with the admin override applied to the
 * resulting tier. Thin wrapper — the actual metadata parsing stays in
 * lib/subscription.ts (shared, byte-identical); only the tier resolution
 * step differs on the portal.
 */
export function parseSubscriptionMetadataWithAdmin(
  raw: Record<string, unknown> | null | undefined,
  adminIdentity: TierAdminIdentity | null | undefined,
): SubscriptionState {
  const base = parseSubscriptionMetadata(raw);
  return { ...base, tier: resolveTier(base.status, adminIdentity) };
}
