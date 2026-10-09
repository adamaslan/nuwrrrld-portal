"use server";

/**
 * Server Actions behind the nulogdash "Beta testers" tab
 * (docs/beta-testers-robust-plan.md §4a). Mutating, so every action
 * re-derives permission from the session via canPerformAdminAction (MFA-gated)
 * — nothing the client sends about identity is trusted. Audit lines log the
 * Clerk user ID only, never an email.
 */
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { canPerformAdminAction } from "@/lib/nulogdash";
import { buildBetaGrant } from "@/lib/beta-grant";

export interface BetaGrantRow {
  userId: string;
  email: string;
  grantedAt: string | null;
  expiresAt: string | null;
  note: string | null;
}

export type BetaActionResult = { ok: true; message: string } | { ok: false; error: string };

const LIST_LIMIT = 200;
const NOTE_MAX = 120;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireAdmin(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated.");
  const user = await currentUser();
  if (!canPerformAdminAction(user)) {
    throw new Error(
      "This action needs an allowlisted admin account with two-factor authentication enabled.",
    );
  }
  return userId;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** Users holding a `beta` metadata object (active or expired). */
export async function listBetaGrants(): Promise<BetaGrantRow[]> {
  await requireAdmin();
  const client = await clerkClient();
  const { data } = await client.users.getUserList({ limit: LIST_LIMIT, orderBy: "-created_at" });
  return data.flatMap((u) => {
    const beta = u.publicMetadata?.beta;
    if (typeof beta !== "object" || beta === null) return [];
    const b = beta as Record<string, unknown>;
    const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId);
    return [
      {
        userId: u.id,
        email: primary?.emailAddress ?? "",
        grantedAt: str(b.grantedAt),
        expiresAt: str(b.expiresAt),
        note: str(b.note),
      },
    ];
  });
}

/** Grant Pro to the Clerk user whose primary email matches. */
export async function grantBeta(raw: {
  email: string;
  expiresInDays?: number | null;
  note?: string;
}): Promise<BetaActionResult> {
  const adminId = await requireAdmin();

  const email = String(raw?.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  const days = raw?.expiresInDays;
  if (days !== undefined && days !== null && !(Number.isInteger(days) && days > 0 && days <= 3650)) {
    return { ok: false, error: "Expiry must be a whole number of days (1–3650), or none." };
  }

  const client = await clerkClient();
  const { data } = await client.users.getUserList({ emailAddress: [email], limit: 2 });
  const target = data[0];
  if (!target) return { ok: false, error: "No account with that email — ask them to sign up first." };

  const grant = buildBetaGrant({
    expiresInDays: days,
    note: raw?.note?.slice(0, NOTE_MAX),
  });
  await client.users.updateUserMetadata(target.id, { publicMetadata: { beta: grant } });
  console.info(`[beta-grant] granted target=${target.id} by=${adminId} expires=${grant.expiresAt}`);
  revalidatePath("/dashboard/nulogdash/beta");
  return { ok: true, message: `Granted Pro${grant.expiresAt ? ` until ${grant.expiresAt}` : " (no expiry)"}.` };
}

/** Remove a grant. Clerk deep-merges metadata, so null clears just `beta`. */
export async function revokeBeta(raw: { userId: string }): Promise<BetaActionResult> {
  const adminId = await requireAdmin();
  const userId = String(raw?.userId ?? "");
  if (!userId.startsWith("user_")) return { ok: false, error: "Invalid user." };

  const client = await clerkClient();
  await client.users.updateUserMetadata(userId, { publicMetadata: { beta: null } });
  console.info(`[beta-grant] revoked target=${userId} by=${adminId}`);
  revalidatePath("/dashboard/nulogdash/beta");
  return { ok: true, message: "Revoked." };
}
