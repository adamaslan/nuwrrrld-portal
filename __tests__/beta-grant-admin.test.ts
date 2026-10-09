import { describe, expect, it } from "vitest";
import { buildBetaGrant, parseGrantInput, summarizeBetaGrant } from "@/lib/beta-grant-admin";
import { hasActiveBetaGrant } from "@/lib/beta-grant";

const NOW = new Date("2026-10-09T12:00:00Z");

describe("parseGrantInput", () => {
  it("normalizes email and treats empty expiry and note as null", () => {
    expect(parseGrantInput({ email: "  Tester@Example.COM ", expiresAt: "", note: "  " }, NOW)).toEqual({
      ok: true,
      email: "tester@example.com",
      expiresAt: null,
      note: null,
    });
  });

  it.each(["", "nope", "a@b", "a b@c.com"])("rejects invalid email %j", (email) => {
    expect(parseGrantInput({ email, expiresAt: "", note: "" }, NOW).ok).toBe(false);
  });

  it("accepts a future expiry", () => {
    const r = parseGrantInput({ email: "a@b.co", expiresAt: "2027-01-08", note: "fall cohort" }, NOW);
    expect(r).toMatchObject({ ok: true, expiresAt: "2027-01-08", note: "fall cohort" });
  });

  it.each(["2027-02-30", "01/08/2027", "2027-1-8", "tomorrow"])("rejects malformed expiry %j", (expiresAt) => {
    expect(parseGrantInput({ email: "a@b.co", expiresAt, note: "" }, NOW).ok).toBe(false);
  });

  it("rejects an expiry of today or earlier", () => {
    expect(parseGrantInput({ email: "a@b.co", expiresAt: "2026-10-09", note: "" }, NOW).ok).toBe(false);
    expect(parseGrantInput({ email: "a@b.co", expiresAt: "2026-01-01", note: "" }, NOW).ok).toBe(false);
  });

  it("rejects an over-long note", () => {
    expect(parseGrantInput({ email: "a@b.co", expiresAt: "", note: "x".repeat(201) }, NOW).ok).toBe(false);
  });
});

describe("buildBetaGrant", () => {
  it("produces a grant that hasActiveBetaGrant accepts", () => {
    const grant = buildBetaGrant({ email: "a@b.co", expiresAt: "2027-01-08", note: null }, NOW);
    expect(grant).toEqual({ tier: "pro", grantedAt: "2026-10-09", expiresAt: "2027-01-08", grantedBy: "admin" });
    expect(hasActiveBetaGrant({ beta: grant }, NOW)).toBe(true);
  });

  it("omits note when absent and keeps it when present", () => {
    expect("note" in buildBetaGrant({ email: "a@b.co", expiresAt: null, note: null }, NOW)).toBe(false);
    expect(buildBetaGrant({ email: "a@b.co", expiresAt: null, note: "hi" }, NOW).note).toBe("hi");
  });
});

describe("summarizeBetaGrant", () => {
  it("returns null when there is no grant", () => {
    expect(summarizeBetaGrant("user_1", "a@b.co", {}, NOW)).toBeNull();
    expect(summarizeBetaGrant("user_1", "a@b.co", null, NOW)).toBeNull();
    expect(summarizeBetaGrant("user_1", "a@b.co", { beta: "x" }, NOW)).toBeNull();
  });

  it("marks an unexpired grant active and an expired one inactive", () => {
    const live = { beta: { tier: "pro", grantedAt: "2026-10-01", expiresAt: "2027-01-08", note: "n" } };
    const dead = { beta: { tier: "pro", grantedAt: "2026-01-01", expiresAt: "2026-02-01" } };
    expect(summarizeBetaGrant("user_1", "a@b.co", live, NOW)).toMatchObject({ active: true, note: "n" });
    expect(summarizeBetaGrant("user_2", "c@d.co", dead, NOW)).toMatchObject({ active: false, note: null });
  });
});
