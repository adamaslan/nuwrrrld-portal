import { hasPendingEmailBeta } from "@/lib/beta-email-registry";
import { resolveTier, type TierAdminIdentity } from "@/lib/subscription-admin";
import { parseSubscriptionMetadata, type SubscriptionStatus } from "@/lib/subscription";

/** Server-only extension: ordinary verified primary email, never a signup ticket. */
export async function resolveTierWithPendingBeta(status: SubscriptionStatus, user: TierAdminIdentity | null | undefined) {
  const tier = resolveTier(status, user);
  if (tier === "pro") return tier;
  return await hasPendingEmailBeta(user) ? "pro" as const : tier;
}
export async function parseSubscriptionWithPendingBeta(raw: Record<string, unknown> | null | undefined, user: TierAdminIdentity | null | undefined) {
  const base = parseSubscriptionMetadata(raw);
  return { ...base, tier: await resolveTierWithPendingBeta(base.status, user) };
}
