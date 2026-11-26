import { createHash } from "node:crypto";
import { clerkClient } from "@clerk/nextjs/server";
import { isNulogdashAdmin, type AdminIdentity } from "@/lib/nulogdash";
import { hasActiveBetaGrant } from "@/lib/beta-grant";
import type { BetaGrant } from "@/lib/beta-grant-admin";

export const BETA_EMAIL_KEY = "nwfBetaEmails";
export const MAX_PENDING_BETA_EMAILS = 10;
export const MAX_METADATA_BYTES = 7000; // Clerk limit is 8KB; leave headroom.
export interface BetaEmailEntry { email: string; grant: BetaGrant }
export function betaEmailId(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}
export function readBetaEmails(metadata: Record<string, unknown> | null | undefined): Record<string, BetaEmailEntry> {
  const raw = metadata?.[BETA_EMAIL_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([id, value]) => {
    if (!value || typeof value !== "object") return false;
    const entry = value as BetaEmailEntry;
    return typeof entry.email === "string" && betaEmailId(entry.email) === id &&
      !!entry.grant && typeof entry.grant === "object" && entry.grant.tier === "pro";
  }));
}
export function verifiedPrimaryEmail(user: AdminIdentity | null | undefined): string | null {
  if (!user?.primaryEmailAddressId || !Array.isArray(user.emailAddresses)) return null;
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  return primary?.verification?.status === "verified" ? primary.emailAddress.trim().toLowerCase() : null;
}
/** Backend-only registry. Link possession never authorizes this lookup. */
export async function hasPendingEmailBeta(user: AdminIdentity | null | undefined): Promise<boolean> {
  const email = verifiedPrimaryEmail(user);
  if (!email) return false;
  const admins = [...new Set((process.env.NULOGDASH_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!admins.length || admins.length > 100) return false;
  try {
    const clerk = await clerkClient();
    const { data, totalCount } = await clerk.users.getUserList({ emailAddress: admins, limit: 500 });
    if (totalCount > data.length) return false; // Never certify a partial registry read.
    return data.some((admin) => isNulogdashAdmin(admin) &&
      hasActiveBetaGrant({ beta: readBetaEmails(admin.privateMetadata)[betaEmailId(email)]?.grant }));
  } catch {
    console.warn("[beta] pending-email registry unavailable; denied");
    return false;
  }
}
