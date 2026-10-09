/**
 * Lists users holding a `publicMetadata.beta` grant, for the nulogdash panel.
 *
 * Deliberately not a Server Action: it is only called from the panel's server
 * component, which has already passed isNulogdashAdmin. Reading needs no MFA
 * (same as the rest of the console); only grant/revoke do.
 */
import { clerkClient } from "@clerk/nextjs/server";
import { summarizeBetaGrant, type BetaGrantSummary } from "@/lib/beta-grant-admin";

// Clerk's page maximum. The grant list is filtered client-side of the API (there
// is no metadata filter), so at beta scale one page of recent users is enough;
// the panel says so when this cap is hit.
const USER_PAGE_SIZE = 500;

export interface BetaGrantList {
  grants: BetaGrantSummary[];
  /** True when the user page was full, so older users may not have been scanned. */
  truncated: boolean;
}

export async function listBetaGrants(now: Date = new Date()): Promise<BetaGrantList> {
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({ limit: USER_PAGE_SIZE, orderBy: "-created_at" });

  const grants: BetaGrantSummary[] = [];
  for (const user of users) {
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
    const summary = summarizeBetaGrant(
      user.id,
      primary?.emailAddress ?? "(no primary email)",
      user.publicMetadata as Record<string, unknown>,
      now,
    );
    if (summary) grants.push(summary);
  }

  // Active first, then most recently granted.
  grants.sort((a, b) => Number(b.active) - Number(a.active) || (b.grantedAt ?? "").localeCompare(a.grantedAt ?? ""));
  return { grants, truncated: users.length >= USER_PAGE_SIZE };
}
