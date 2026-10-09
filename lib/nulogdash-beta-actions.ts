"use server";

/**
 * Write path for the nulogdash "Beta testers" panel: grant and revoke Pro via
 * Clerk `publicMetadata.beta` (docs/beta-testers-robust-plan.md §4a).
 *
 * Granting Pro is a mutating admin action, so every call re-derives identity
 * from the session and requires `canPerformAdminAction` (allowlisted admin +
 * two-factor), the same gate as nulogdash-actions.ts. Nothing the client sends
 * about who it is is trusted.
 */
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { canPerformAdminAction } from "@/lib/nulogdash";
import { rateLimit } from "@/lib/rate-limit";
import { buildBetaGrant, parseGrantInput, type GrantInput } from "@/lib/beta-grant-admin";

const CHANGES_PER_WINDOW = 20;
const CHANGE_WINDOW_MS = 5 * 60_000;
const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const PANEL_PATH = "/dashboard/nulogdash/beta";

export type BetaActionResult = { ok: true; message: string } | { ok: false; error: string };

async function requireAdmin(): Promise<{ userId: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated.");
  const user = await currentUser();
  if (!canPerformAdminAction(user)) {
    throw new Error(
      "This action needs an allowlisted admin account with two-factor authentication enabled.",
    );
  }
  return { userId };
}

function checkRate(adminId: string): BetaActionResult | null {
  const rl = rateLimit(`beta-grant:${adminId}`, CHANGES_PER_WINDOW, CHANGE_WINDOW_MS);
  if (rl.ok) return null;
  const mins = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 60_000));
  return { ok: false, error: `Too many changes. Try again in ~${mins} min.` };
}

/** Grant (or re-grant, replacing any existing grant) Pro to the account with this email. */
export async function grantBeta(raw: GrantInput): Promise<BetaActionResult> {
  const { userId: adminId } = await requireAdmin();

  const parsed = parseGrantInput(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const limited = checkRate(adminId);
  if (limited) return limited;

  const clerk = await clerkClient();
  const { data: matches } = await clerk.users.getUserList({ emailAddress: [parsed.email] });
  const target = matches[0];
  if (!target) {
    return { ok: false, error: "No account with that email. Ask them to sign up first, then grant." };
  }

  // Only a verified address counts: Clerk's email filter also matches
  // unverified addresses, and an unverified claim on someone else's address
  // must not turn into a Pro grant.
  const address = target.emailAddresses.find((e) => e.emailAddress.toLowerCase() === parsed.email);
  if (address?.verification?.status !== "verified") {
    return { ok: false, error: "That email isn't verified on the account yet. Ask them to verify it first." };
  }

  await clerk.users.updateUserMetadata(target.id, {
    publicMetadata: { beta: buildBetaGrant(parsed) },
  });

  // User ID only — never log the email.
  console.info("[nulogdash] beta grant", { by: adminId, target: target.id, expiresAt: parsed.expiresAt });
  revalidatePath(PANEL_PATH);
  return { ok: true, message: "Granted. They may need to refresh or sign in again to see Pro." };
}

/** Remove a user's beta grant. Clerk deletes a metadata key set to null. */
export async function revokeBeta(raw: { userId: string }): Promise<BetaActionResult> {
  const { userId: adminId } = await requireAdmin();

  const targetId = raw?.userId;
  if (typeof targetId !== "string" || !CLERK_USER_ID_PATTERN.test(targetId)) {
    return { ok: false, error: "Invalid user." };
  }

  const limited = checkRate(adminId);
  if (limited) return limited;

  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(targetId, { publicMetadata: { beta: null } });

  console.info("[nulogdash] beta revoke", { by: adminId, target: targetId });
  revalidatePath(PANEL_PATH);
  return { ok: true, message: "Revoked." };
}
