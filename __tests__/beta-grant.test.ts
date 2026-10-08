import { describe, expect, it } from "vitest";
import { hasActiveBetaGrant } from "@/lib/beta-grant";
import { resolveTier, type TierAdminIdentity } from "@/lib/subscription-admin";

const NOW = new Date("2026-10-08T12:00:00Z");

describe("hasActiveBetaGrant", () => {
  it("grants on a pro grant with no expiry", () => {
    expect(hasActiveBetaGrant({ beta: { tier: "pro", expiresAt: null } }, NOW)).toBe(true);
    expect(hasActiveBetaGrant({ beta: { tier: "pro" } }, NOW)).toBe(true);
  });

  it("grants until the expiry, then stops", () => {
    expect(hasActiveBetaGrant({ beta: { tier: "pro", expiresAt: "2027-01-08" } }, NOW)).toBe(true);
    expect(hasActiveBetaGrant({ beta: { tier: "pro", expiresAt: "2026-10-01" } }, NOW)).toBe(false);
  });

  it("fails closed on a malformed expiry or non-string expiry", () => {
    expect(hasActiveBetaGrant({ beta: { tier: "pro", expiresAt: "soon" } }, NOW)).toBe(false);
    expect(hasActiveBetaGrant({ beta: { tier: "pro", expiresAt: 12345 } }, NOW)).toBe(false);
  });

  it("rejects non-pro tiers and malformed or missing grants", () => {
    expect(hasActiveBetaGrant({ beta: { tier: "free" } }, NOW)).toBe(false);
    expect(hasActiveBetaGrant({ beta: "pro" }, NOW)).toBe(false);
    expect(hasActiveBetaGrant({ beta: null }, NOW)).toBe(false);
    expect(hasActiveBetaGrant({}, NOW)).toBe(false);
    expect(hasActiveBetaGrant(null, NOW)).toBe(false);
    expect(hasActiveBetaGrant(undefined, NOW)).toBe(false);
  });
});

describe("resolveTier with a metadata beta grant", () => {
  const withMeta = (publicMetadata: Record<string, unknown>): TierAdminIdentity => ({
    primaryEmailAddressId: "idn_1",
    emailAddresses: [
      { id: "idn_1", emailAddress: "someone@example.com", verification: { status: "verified" } },
    ],
    publicMetadata,
  });

  it("resolves pro for a free user holding an active grant", () => {
    expect(resolveTier("free", withMeta({ beta: { tier: "pro", expiresAt: null } }))).toBe("pro");
  });

  it("stays free once the grant has expired", () => {
    expect(resolveTier("free", withMeta({ beta: { tier: "pro", expiresAt: "2020-01-01" } }))).toBe("free");
  });
});
