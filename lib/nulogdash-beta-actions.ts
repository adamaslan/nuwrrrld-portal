"use server";

/**
 * Write path for the nulogdash "Beta testers" panel: grant and revoke Pro via
 * Clerk `publicMetadata.beta` (docs/beta-testers-robust-plan.md §4a).
 *
 * Granting Pro is a mutating admin action, so every call re-derives identity
 * from the session and requires `canPerformAdminAction` (allowlisted admin +
 * configured MFA policy), the same gate as nulogdash-actions.ts. Nothing the client sends
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

export type BetaActionResult = { ok: true; message: string; inviteUrl?: string } | { ok: false; error: string };

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
  if (matches.length === 0) {
    // Invitations carry only beta entitlements, never admin or billing metadata.
    // No automatic email: the owner chooses where to share the private link.
    const { data: pending } = await clerk.invitations.getInvitationList({ status: "pending", query: parsed.email, limit: 100 });
    const existing = pending.find((i) => i.emailAddress.toLowerCase() === parsed.email);
    if (existing) {
      return { ok: false, error: "There is already a pending invitation for this email. Use or revoke it before adding another." };
    }
    const invitation = await clerk.invitations.createInvitation({
      emailAddress: parsed.email,
      publicMetadata: { beta: buildBetaGrant(parsed) },
      notify: false,
      expiresInDays: 7,
      redirectUrl: "/sign-up",
    });
    console.info("[nulogdash] beta invitation", { by: adminId, invitation: invitation.id });
    revalidatePath(PANEL_PATH);
    return {
      ok: true,
      message: "Invite created. Share the private link with this person. It expires in 7 days; beta access starts when they finish signing up.",
      inviteUrl: invitation.url,
    };
  }

  // Only a verified address counts: Clerk's email filter also matches
  // unverified addresses, and an unverified claim on someone else's address
  // must not turn into a Pro grant. Scan every match so an unverified claim
  // listed first cannot hide the account that actually owns the address.
  const target = matches.find((u) =>
    u.emailAddresses.some(
      (e) => e.emailAddress.toLowerCase() === parsed.email && e.verification?.status === "verified",
    ),
  );
  if (!target) {
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

/** Revoke a pending beta invitation without changing an existing account. */
export async function revokeBetaInvitation(raw: { invitationId: string }): Promise<BetaActionResult> {
  const { userId: adminId } = await requireAdmin();
  const id = raw?.invitationId;
  if (typeof id !== "string" || !/^(inv|invitation)_[A-Za-z0-9]+$/.test(id)) {
    return { ok: false, error: "Invalid invitation." };
  }
  const limited = checkRate(adminId);
  if (limited) return limited;
  const clerk = await clerkClient();
  const { data } = await clerk.invitations.getInvitationList({ status: "pending", limit: 500 });
  const invitation = data.find((i) => i.id === id &&
    (i.publicMetadata?.beta as { tier?: unknown } | undefined)?.tier === "pro");
  if (!invitation) return { ok: false, error: "Pending beta invitation not found. Refresh the page." };
  await clerk.invitations.revokeInvitation(id);
  revalidatePath(PANEL_PATH);
  console.info("[nulogdash] beta invitation revoke", { by: adminId, invitation: id });
  return { ok: true, message: "Invitation revoked." };
}
