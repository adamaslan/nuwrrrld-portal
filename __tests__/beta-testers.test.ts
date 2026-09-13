import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBetaTester, type BetaTesterIdentity } from "@/lib/beta-testers";
import { resolveTier } from "@/lib/subscription-admin";

const ORIGINAL_BETA = process.env.BETA_TESTER_EMAILS;
const ORIGINAL_ADMIN = process.env.NULOGDASH_ADMIN_EMAILS;

/** Clerk-shaped identity — mirrors __tests__/subscription-admin.test.ts's fixture. */
function user(email: string, verified = true): BetaTesterIdentity {
  return {
    primaryEmailAddressId: "idn_primary",
    emailAddresses: [
      { id: "idn_primary", emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
    ],
  };
}

describe("isBetaTester", () => {
  beforeEach(() => {
    delete process.env.BETA_TESTER_EMAILS;
    // Keep the admin allowlist out of the picture: these tests are about the
    // beta path granting pro on its own, not about admin doing it.
    delete process.env.NULOGDASH_ADMIN_EMAILS;
  });

  afterEach(() => {
    if (ORIGINAL_BETA === undefined) delete process.env.BETA_TESTER_EMAILS;
    else process.env.BETA_TESTER_EMAILS = ORIGINAL_BETA;
    if (ORIGINAL_ADMIN === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ADMIN;
  });

  it("allows the built-in tester with no env var set — local and cloud alike", () => {
    expect(isBetaTester(user("chillcoders@gmail.com"))).toBe(true);
  });

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(isBetaTester(user("  ChillCoders@Gmail.com  "))).toBe(true);
  });

  it("allows an address added via BETA_TESTER_EMAILS", () => {
    process.env.BETA_TESTER_EMAILS = "tester1@example.com, tester2@example.com";
    expect(isBetaTester(user("tester2@example.com"))).toBe(true);
  });

  it("keeps the built-ins when BETA_TESTER_EMAILS is set", () => {
    process.env.BETA_TESTER_EMAILS = "tester1@example.com";
    expect(isBetaTester(user("chillcoders@gmail.com"))).toBe(true);
  });

  it("rejects an unverified primary address", () => {
    expect(isBetaTester(user("chillcoders@gmail.com", false))).toBe(false);
  });

  it("rejects an allowlisted address that is not the primary one", () => {
    expect(
      isBetaTester({
        primaryEmailAddressId: "idn_other",
        emailAddresses: [
          { id: "idn_other", emailAddress: "someone@example.com", verification: { status: "verified" } },
          { id: "idn_primary", emailAddress: "chillcoders@gmail.com", verification: { status: "verified" } },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a non-allowlisted user, and null/undefined", () => {
    expect(isBetaTester(user("stranger@example.com"))).toBe(false);
    expect(isBetaTester(null)).toBe(false);
    expect(isBetaTester(undefined)).toBe(false);
  });
});

describe("resolveTier with a beta tester", () => {
  beforeEach(() => {
    delete process.env.BETA_TESTER_EMAILS;
    delete process.env.NULOGDASH_ADMIN_EMAILS;
  });

  afterEach(() => {
    if (ORIGINAL_BETA === undefined) delete process.env.BETA_TESTER_EMAILS;
    else process.env.BETA_TESTER_EMAILS = ORIGINAL_BETA;
    if (ORIGINAL_ADMIN === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ADMIN;
  });

  it("resolves pro regardless of Stripe status", () => {
    const tester = user("chillcoders@gmail.com");
    expect(resolveTier("free", tester)).toBe("pro");
    expect(resolveTier("canceled", tester)).toBe("pro");
    expect(resolveTier("past_due", tester)).toBe("pro");
  });

  it("leaves non-testers on their Stripe-derived tier", () => {
    expect(resolveTier("free", user("stranger@example.com"))).toBe("free");
    expect(resolveTier("active", user("stranger@example.com"))).toBe("pro");
  });
});
