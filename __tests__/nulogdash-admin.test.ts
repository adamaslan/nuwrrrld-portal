import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isNulogdashAdmin,
  canPerformAdminAction,
  summarizeCounts,
  splitResults,
  type AdminIdentity,
  type FeatureResult,
} from "@/lib/nulogdash";

const ORIGINAL_ALLOWLIST = process.env.NULOGDASH_ADMIN_EMAILS;

/** Builds a Clerk-shaped user. Defaults to the happy path (single primary,
 * verified) so each test only states the one thing it's varying. */
function user(overrides: {
  email?: string;
  verified?: boolean;
  primaryId?: string | null;
  extra?: AdminIdentity["emailAddresses"];
  twoFactorEnabled?: boolean;
} = {}): AdminIdentity {
  const {
    email = "admin@example.com",
    verified = true,
    primaryId = "idn_primary",
    extra = [],
    twoFactorEnabled = true,
  } = overrides;

  return {
    primaryEmailAddressId: primaryId,
    twoFactorEnabled,
    emailAddresses: [
      ...extra,
      {
        id: "idn_primary",
        emailAddress: email,
        verification: { status: verified ? "verified" : "unverified" },
      },
    ],
  };
}

describe("isNulogdashAdmin", () => {
  beforeEach(() => {
    process.env.NULOGDASH_ADMIN_EMAILS = "admin@example.com,second@example.com";
  });

  afterEach(() => {
    if (ORIGINAL_ALLOWLIST === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  });

  it("admits an allowlisted, verified primary address", () => {
    expect(isNulogdashAdmin(user())).toBe(true);
  });

  it("admits any entry in the allowlist, not just the first", () => {
    expect(isNulogdashAdmin(user({ email: "second@example.com" }))).toBe(true);
  });

  it("rejects an address that is not on the allowlist", () => {
    expect(isNulogdashAdmin(user({ email: "stranger@example.com" }))).toBe(false);
  });

  // Defect 1: an unverified address must never pass. Otherwise anyone able to
  // sign up with an allowlisted address gets in without proving ownership.
  it("rejects an allowlisted address that is not verified", () => {
    expect(isNulogdashAdmin(user({ verified: false }))).toBe(false);
  });

  it("rejects when the primary address has no verification object at all", () => {
    expect(
      isNulogdashAdmin({
        primaryEmailAddressId: "idn_primary",
        emailAddresses: [
          { id: "idn_primary", emailAddress: "admin@example.com", verification: null },
        ],
      }),
    ).toBe(false);
  });

  // Defect 2: the check must follow primaryEmailAddressId, not array order.
  // Here an allowlisted address sits at index 0 but is NOT the primary — the
  // old `emailAddresses[0]` read would have admitted this user.
  it("ignores a non-primary allowlisted address sitting at index 0", () => {
    const attacker: AdminIdentity = {
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        {
          id: "idn_other",
          emailAddress: "admin@example.com",
          verification: { status: "verified" },
        },
        {
          id: "idn_primary",
          emailAddress: "stranger@example.com",
          verification: { status: "verified" },
        },
      ],
    };
    expect(isNulogdashAdmin(attacker)).toBe(false);
  });

  it("admits when the allowlisted primary is not at index 0", () => {
    expect(
      isNulogdashAdmin(
        user({
          extra: [
            {
              id: "idn_other",
              emailAddress: "unrelated@example.com",
              verification: { status: "verified" },
            },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("rejects when primaryEmailAddressId points at no known address", () => {
    expect(isNulogdashAdmin(user({ primaryId: "idn_missing" }))).toBe(false);
  });

  it("rejects when there is no primary address id", () => {
    expect(isNulogdashAdmin(user({ primaryId: null }))).toBe(false);
  });

  // Fail-closed: a typo'd or unset env var must lock admins out, never open up.
  it("denies everyone when the allowlist is unset", () => {
    delete process.env.NULOGDASH_ADMIN_EMAILS;
    expect(isNulogdashAdmin(user())).toBe(false);
  });

  it("denies everyone when the allowlist is empty or only separators", () => {
    process.env.NULOGDASH_ADMIN_EMAILS = " , , ";
    expect(isNulogdashAdmin(user())).toBe(false);
  });

  it("matches case-insensitively and tolerates whitespace in the allowlist", () => {
    process.env.NULOGDASH_ADMIN_EMAILS = "  ADMIN@Example.COM  ";
    expect(isNulogdashAdmin(user({ email: "Admin@example.com" }))).toBe(true);
  });

  it("rejects a null or undefined user", () => {
    expect(isNulogdashAdmin(null)).toBe(false);
    expect(isNulogdashAdmin(undefined)).toBe(false);
  });

  // Read access must NOT depend on MFA — an un-enrolled admin should still
  // see the console (and the notice telling them to enrol), not a notFound().
  it("admits an allowlisted admin who has not enrolled MFA", () => {
    expect(isNulogdashAdmin(user({ twoFactorEnabled: false }))).toBe(true);
  });
});

describe("canPerformAdminAction", () => {
  beforeEach(() => {
    process.env.NULOGDASH_ADMIN_EMAILS = "admin@example.com";
  });

  afterEach(() => {
    if (ORIGINAL_ALLOWLIST === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  });

  it("permits an allowlisted admin with MFA enrolled", () => {
    expect(canPerformAdminAction(user({ twoFactorEnabled: true }))).toBe(true);
  });

  it("refuses an allowlisted admin without MFA", () => {
    expect(canPerformAdminAction(user({ twoFactorEnabled: false }))).toBe(false);
  });

  // A partial identity built by an older caller has no twoFactorEnabled at
  // all. Absent must read as "no MFA", never as permission.
  it("refuses when twoFactorEnabled is absent entirely", () => {
    const partial: AdminIdentity = {
      primaryEmailAddressId: "idn_primary",
      emailAddresses: [
        { id: "idn_primary", emailAddress: "admin@example.com", verification: { status: "verified" } },
      ],
    };
    expect(canPerformAdminAction(partial)).toBe(false);
  });

  it("refuses a truthy-but-not-true twoFactorEnabled", () => {
    const coerced = {
      ...user({ twoFactorEnabled: false }),
      twoFactorEnabled: "yes" as unknown as boolean,
    };
    expect(canPerformAdminAction(coerced)).toBe(false);
  });

  // MFA must never substitute for the identity checks — it is an additional
  // requirement, not an alternative one.
  it("refuses a non-allowlisted user even with MFA enrolled", () => {
    expect(canPerformAdminAction(user({ email: "stranger@example.com" }))).toBe(false);
  });

  it("refuses an unverified allowlisted address even with MFA enrolled", () => {
    expect(canPerformAdminAction(user({ verified: false }))).toBe(false);
  });

  it("refuses everyone when the allowlist is unset, MFA notwithstanding", () => {
    delete process.env.NULOGDASH_ADMIN_EMAILS;
    expect(canPerformAdminAction(user({ twoFactorEnabled: true }))).toBe(false);
  });

  it("refuses a null or undefined user", () => {
    expect(canPerformAdminAction(null)).toBe(false);
    expect(canPerformAdminAction(undefined)).toBe(false);
  });
});

/** Builds a minimal FeatureResult fixture; each test only states the status
 * it's varying, since that's the only field the reducers under test read. */
function feature(status: FeatureResult["status"], overrides: Partial<FeatureResult> = {}): FeatureResult {
  return {
    feature: overrides.feature ?? `feature-${status}-${Math.random().toString(36).slice(2)}`,
    label: overrides.label ?? "Some Feature",
    entrypoints: overrides.entrypoints ?? [],
    tier: overrides.tier ?? null,
    dependencies: overrides.dependencies ?? [],
    latencyMs: overrides.latencyMs ?? null,
    status,
    reason: overrides.reason ?? null,
  };
}

describe("summarizeCounts", () => {
  it("tallies each status independently", () => {
    const results = [feature("pass"), feature("pass"), feature("fail"), feature("blocked"), feature("not_run")];
    expect(summarizeCounts(results)).toEqual({ pass: 2, fail: 1, blocked: 1, not_run: 1 });
  });

  it("returns zero for every status on an empty run", () => {
    expect(summarizeCounts([])).toEqual({ pass: 0, fail: 0, blocked: 0, not_run: 0 });
  });

  it("zero-fills statuses that never occur, rather than omitting the key", () => {
    const results = [feature("pass")];
    expect(summarizeCounts(results)).toEqual({ pass: 1, fail: 0, blocked: 0, not_run: 0 });
  });
});

describe("splitResults", () => {
  it("routes blocked and not_run into notExercised, pass and fail into exercised", () => {
    const passResult = feature("pass");
    const failResult = feature("fail");
    const blockedResult = feature("blocked");
    const notRunResult = feature("not_run");

    const { notExercised, exercised } = splitResults([passResult, failResult, blockedResult, notRunResult]);

    expect(notExercised).toEqual([blockedResult, notRunResult]);
    expect(exercised).toEqual([passResult, failResult]);
  });

  it("returns two empty arrays for an empty run", () => {
    const { notExercised, exercised } = splitResults([]);
    expect(notExercised).toEqual([]);
    expect(exercised).toEqual([]);
  });

  it("never drops or duplicates a result across the two buckets", () => {
    const results = [feature("pass"), feature("fail"), feature("blocked"), feature("not_run"), feature("pass")];
    const { notExercised, exercised } = splitResults(results);
    expect(notExercised.length + exercised.length).toBe(results.length);
  });
});
