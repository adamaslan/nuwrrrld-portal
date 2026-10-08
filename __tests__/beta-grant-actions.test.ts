import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const currentUserMock = vi.fn();
const getUserList = vi.fn();
const updateUserMetadata = vi.fn();
vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
  currentUser: () => currentUserMock(),
  clerkClient: async () => ({ users: { getUserList, updateUserMetadata } }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { grantBeta, revokeBeta, listBetaGrants } from "@/lib/beta-grant-actions";
import { buildBetaGrant } from "@/lib/beta-grant";

function asAdmin(mfa = true) {
  authMock.mockResolvedValue({ userId: "user_admin" });
  currentUserMock.mockResolvedValue({
    primaryEmailAddressId: "idn_1",
    twoFactorEnabled: mfa,
    emailAddresses: [{ id: "idn_1", emailAddress: "admin@example.com", verification: { status: "verified" } }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NULOGDASH_ADMIN_EMAILS = "admin@example.com";
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("buildBetaGrant", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  it("defaults to a 90-day expiry", () => {
    expect(buildBetaGrant({ now }).expiresAt).toBe("2027-01-06");
  });
  it("supports no expiry and trims the note", () => {
    const g = buildBetaGrant({ now, expiresInDays: null, note: "  cohort  " });
    expect(g.expiresAt).toBeNull();
    expect(g.note).toBe("cohort");
  });
});

describe("beta grant actions", () => {
  it("rejects unauthenticated, non-MFA and non-admin callers", async () => {
    authMock.mockResolvedValue({ userId: null });
    await expect(grantBeta({ email: "a@b.co" })).rejects.toThrow("Not authenticated");
    asAdmin(false);
    await expect(grantBeta({ email: "a@b.co" })).rejects.toThrow("two-factor");
    await expect(listBetaGrants()).rejects.toThrow("two-factor");
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("grants by primary email and writes only the beta key", async () => {
    asAdmin();
    getUserList.mockResolvedValue({ data: [{ id: "user_t1" }] });
    const r = await grantBeta({ email: " Tester@Example.com ", expiresInDays: 30 });
    expect(r.ok).toBe(true);
    expect(getUserList).toHaveBeenCalledWith({ emailAddress: ["tester@example.com"], limit: 2 });
    const [id, body] = updateUserMetadata.mock.calls[0];
    expect(id).toBe("user_t1");
    expect(Object.keys(body.publicMetadata)).toEqual(["beta"]);
    expect(body.publicMetadata.beta.tier).toBe("pro");
  });

  it("tells the admin when no account exists, and validates input", async () => {
    asAdmin();
    getUserList.mockResolvedValue({ data: [] });
    expect(await grantBeta({ email: "nobody@example.com" })).toMatchObject({ ok: false });
    expect(await grantBeta({ email: "not-an-email" })).toMatchObject({ ok: false });
    expect(await grantBeta({ email: "a@b.co", expiresInDays: -5 })).toMatchObject({ ok: false });
    expect(updateUserMetadata).not.toHaveBeenCalled();
  });

  it("revokes by nulling beta, rejecting non-user ids", async () => {
    asAdmin();
    expect(await revokeBeta({ userId: "evil" })).toMatchObject({ ok: false });
    await revokeBeta({ userId: "user_t1" });
    expect(updateUserMetadata).toHaveBeenCalledWith("user_t1", { publicMetadata: { beta: null } });
  });

  it("lists only users with a beta object", async () => {
    asAdmin();
    getUserList.mockResolvedValue({
      data: [
        { id: "user_a", primaryEmailAddressId: "e1", emailAddresses: [{ id: "e1", emailAddress: "a@x.co" }],
          publicMetadata: { beta: { tier: "pro", grantedAt: "2026-10-08", expiresAt: null, note: "n" } } },
        { id: "user_b", primaryEmailAddressId: "e2", emailAddresses: [], publicMetadata: {} },
      ],
    });
    const rows = await listBetaGrants();
    expect(rows).toEqual([{ userId: "user_a", email: "a@x.co", grantedAt: "2026-10-08", expiresAt: null, note: "n" }]);
  });
});
