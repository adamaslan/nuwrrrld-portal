import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type FeatureStatus = "pass" | "fail" | "blocked" | "not_run";

export interface FeatureResult {
  feature: string;
  label: string;
  entrypoints: string[];
  tier: "api" | "browser" | null;
  dependencies: string[];
  latencyMs: number | null;
  status: FeatureStatus;
  reason: string | null;
}

export interface ExcludedFeature {
  feature: string;
  path: string;
  reason: string;
}

export interface NulogdashRun {
  runId: string;
  runAt: string;
  gitSha: string;
  branch: string;
  baseUrl: string;
  tiers: string[];
  results: FeatureResult[];
  excluded: ExcludedFeature[];
  driftWarnings: string[];
}

const LATEST_FILE = join(process.cwd(), ".nulogdash", "latest.json");

/** The subset of Clerk's User this gate needs. Declared structurally so the
 * check can be unit-tested without constructing a full Clerk User. */
export interface AdminIdentity {
  primaryEmailAddressId: string | null;
  emailAddresses: {
    id: string;
    emailAddress: string;
    verification: { status: string | null } | null;
  }[];
  /** Clerk's User.twoFactorEnabled. Optional so existing read-only callers
   * that build a partial identity still typecheck; absent is treated as
   * "no MFA", which is the safe reading. */
  twoFactorEnabled?: boolean;
}

/** Admin gate for the nulogdash console.
 *
 * Takes the Clerk user rather than a bare email string on purpose: both
 * checks below can be silently bypassed by a caller that resolves the
 * address itself, which is exactly how this went wrong before.
 *
 *   - Only the PRIMARY address counts. A user can hold several addresses
 *     and reorder them, so `emailAddresses[0]` carries no guarantee.
 *   - The address must be VERIFIED. Otherwise anyone able to sign up with
 *     an allowlisted address passes without ever proving they own it.
 *
 * Fails closed: an unset/empty NULOGDASH_ADMIN_EMAILS denies everyone, so a
 * typo'd env var locks admins out rather than letting strangers in.
 */
export function isNulogdashAdmin(user: AdminIdentity | undefined | null): boolean {
  if (!user?.primaryEmailAddressId) return false;

  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  if (!primary) return false;
  if (primary.verification?.status !== "verified") return false;

  const allowlist = (process.env.NULOGDASH_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return false;

  return allowlist.includes(primary.emailAddress.trim().toLowerCase());
}

/** Whether an admin may perform a MUTATING action (impersonate, disable,
 * reset password, reindex, …) — not merely view a read-only report.
 *
 * Deliberately separate from `isNulogdashAdmin`. An env-var email allowlist
 * is one string comparison away from full admin access, which is an
 * acceptable risk for reading a test-sweep report and an unacceptable one
 * for actions that reach other users' accounts. Requiring a second factor
 * means a leaked session or a compromised mailbox alone isn't enough.
 *
 * Splitting the two also keeps the failure mode humane: an admin who hasn't
 * enrolled MFA yet still sees the console (and can be told to enrol) rather
 * than getting an unexplained notFound().
 *
 * Every mutating server action must call THIS, not `isNulogdashAdmin`.
 */
export function canPerformAdminAction(user: AdminIdentity | undefined | null): boolean {
  if (!isNulogdashAdmin(user)) return false;
  return user?.twoFactorEnabled === true;
}

/** v0 sink: reads the local JSON file the runner writes. See the "Persisting
 * run results" section of docs/nulogdash-dashboard-plan.md for the planned
 * migration to a Neon-backed sink with run history. */
export function getLatestRun(): NulogdashRun | null {
  if (!existsSync(LATEST_FILE)) return null;
  try {
    return JSON.parse(readFileSync(LATEST_FILE, "utf8")) as NulogdashRun;
  } catch {
    return null;
  }
}
