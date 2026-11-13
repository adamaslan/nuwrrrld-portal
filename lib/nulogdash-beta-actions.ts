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
import { BETA_EMAIL_KEY, betaEmailId, readBetaEmails, MAX_PENDING_BETA_EMAILS, MAX_METADATA_BYTES } from "@/lib/beta-email-registry";
import { rateLimit } from "@/lib/rate-limit";
import { buildBetaGrant, parseGrantInput, type GrantInput } from "@/lib/beta-grant-admin";

const CHANGES_PER_WINDOW = 20;
const CHANGE_WINDOW_MS = 5 * 60_000;
const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9]+$/;
const PANEL_PATH = "/dashboard/nulogdash/beta";

export type BetaActionResult = { ok: true; message: string; signupUrl?: string } | { ok: false; error: string };

async function requireAdmin(): Promise<{ userId: string }> {
  const { userId } = await auth();
  if (!userId) throw new Error("Not authenticated.");
  const user = await currentUser();
  if (!canPerformAdminAction(user)) {
    throw new Error(
      "This action needs a verified allowlisted admin account and the configured MFA policy.",
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
    const admin = await clerk.users.getUser(adminId);
    const entries = readBetaEmails(admin.privateMetadata);
    const id = betaEmailId(parsed.email);
    if (!entries[id] && Object.keys(entries).length >= MAX_PENDING_BETA_EMAILS) {
      return { ok: false, error: "Pending-email capacity reached (10). Revoke an entry before adding another." };
    }
    const entry = { email: parsed.email, grant: buildBetaGrant(parsed) };
    const nextPrivate = { ...admin.privateMetadata, [BETA_EMAIL_KEY]: { ...entries, [id]: entry } };
    const bytes = Buffer.byteLength(JSON.stringify({ publicMetadata: admin.publicMetadata, privateMetadata: nextPrivate, unsafeMetadata: admin.unsafeMetadata }), "utf8");
    if (bytes > MAX_METADATA_BYTES) return { ok: false, error: "Account metadata is near capacity. No beta entry was saved." };
    await clerk.users.updateUserMetadata(adminId, { privateMetadata: { [BETA_EMAIL_KEY]: { [id]: entry } } });
    revalidatePath(PANEL_PATH);
    return {
      ok: true,
      message: "Email added. They get beta Pro after normal signup and verification of this primary email. The signup link conveys no access by itself.",
      signupUrl: "/sign-up?redirect_url=/dashboard",
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

/** Remove only the current admin's pending-email entry. No account or invitation mutation. */
export async function revokePendingBeta(raw: { emailId: string }): Promise<BetaActionResult> {
  const { userId: adminId } = await requireAdmin();
  if (!/^[a-f0-9]{64}$/.test(raw?.emailId ?? "")) return { ok: false, error: "Invalid pending entry." };
  const limited = checkRate(adminId);
  if (limited) return limited;
  const clerk = await clerkClient();
  await clerk.users.updateUserMetadata(adminId, { privateMetadata: { [BETA_EMAIL_KEY]: { [raw.emailId]: null } } });
  revalidatePath(PANEL_PATH);
  return { ok: true, message: "Pending email revoked." };
}
