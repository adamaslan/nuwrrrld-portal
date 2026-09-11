import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseSubscriptionMetadataWithAdmin,
  resolveTier,
  type TierAdminIdentity,
} from "@/lib/subscription-admin";

const ORIGINAL_ALLOWLIST = process.env.NULOGDASH_ADMIN_EMAILS;

/** Builds a Clerk-shaped admin identity — mirrors __tests__/nulogdash-admin.test.ts's fixture. */
function admin(email = "admin@example.com", verified = true): TierAdminIdentity {
  return {
    primaryEmailAddressId: "idn_primary",
    emailAddresses: [
      { id: "idn_primary", emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
    ],
  };
}

describe("resolveTier", () => {
  beforeEach(() => {
    process.env.NULOGDASH_ADMIN_EMAILS = "admin@example.com";
  });

  afterEach(() => {
    if (ORIGINAL_ALLOWLIST === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  });

  it("gives an allowlisted admin pro regardless of status", () => {
    expect(resolveTier("free", admin())).toBe("pro");
    expect(resolveTier("canceled", admin())).toBe("pro");
  });

  it("falls back to tierFromStatus for a non-admin", () => {
    expect(resolveTier("free", null)).toBe("free");
    expect(resolveTier("active", undefined)).toBe("pro");
  });
});

describe("parseSubscriptionMetadataWithAdmin", () => {
  beforeEach(() => {
    process.env.NULOGDASH_ADMIN_EMAILS = "admin@example.com";
  });

  afterEach(() => {
    if (ORIGINAL_ALLOWLIST === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  });

  it("resolves pro for an allowlisted admin regardless of subscription_status", () => {
    const result = parseSubscriptionMetadataWithAdmin({ subscription_status: "canceled" }, admin());
    expect(result.status).toBe("canceled");
    expect(result.tier).toBe("pro");
  });

  it("does not override tier for a non-admin user", () => {
    const result = parseSubscriptionMetadataWithAdmin(
      { subscription_status: "canceled" },
      admin("someone-else@example.com"),
    );
    expect(result.tier).toBe("free");
  });

  it("does not override tier for an unverified admin address", () => {
    const result = parseSubscriptionMetadataWithAdmin(
      { subscription_status: "canceled" },
      admin("admin@example.com", false),
    );
    expect(result.tier).toBe("free");
  });
});
