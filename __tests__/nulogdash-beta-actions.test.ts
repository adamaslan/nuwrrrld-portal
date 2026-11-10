import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), users: vi.fn(), update: vi.fn(), list: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth, currentUser: m.user, clerkClient: async () => ({ users: { getUserList: m.users, updateUserMetadata: m.update }, invitations: { getInvitationList: m.list, createInvitation: m.create, revokeInvitation: m.revoke } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { grantBeta, revokeBetaInvitation } from "@/lib/nulogdash-beta-actions";
import { __resetRateLimitState } from "@/lib/rate-limit";
const input = { email: " New@Example.com ", expiresAt: "", note: "" };
const old = { ...process.env };
beforeEach(() => {
 vi.resetAllMocks(); __resetRateLimitState();
 process.env.NULOGDASH_ADMIN_EMAILS = "owner@example.com";
 process.env.NULOGDASH_REQUIRE_MFA = "true";
 m.auth.mockResolvedValue({ userId: "user_owner" });
 m.user.mockResolvedValue({ primaryEmailAddressId: "email_1", twoFactorEnabled: true, emailAddresses: [{ id: "email_1", emailAddress: "owner@example.com", verification: { status: "verified" } }] });
 m.users.mockResolvedValue({ data: [] }); m.list.mockResolvedValue({ data: [] });
 m.create.mockResolvedValue({ id: "inv_new", url: "https://example.com/private-invite" });
 vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...old }; vi.restoreAllMocks(); });
describe("beta email-first enrollment", () => {
 it("creates a private seven-day invitation with beta only and no email", async () => {
  const r = await grantBeta(input);
  expect(r).toMatchObject({ ok: true, inviteUrl: "https://example.com/private-invite" });
  expect(m.create).toHaveBeenCalledWith({ emailAddress: "new@example.com", notify: false, expiresInDays: 7, redirectUrl: "/sign-up", publicMetadata: { beta: { tier: "pro", grantedAt: expect.any(String), expiresAt: null, grantedBy: "admin", note: null } } });
  expect(m.update).not.toHaveBeenCalled();
  expect(console.info).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ email: expect.anything() }));
 });
 it("grants a verified existing account without inviting or changing billing/admin", async () => {
  m.users.mockResolvedValue({ data: [{ id: "user_new", emailAddresses: [{ emailAddress: "new@example.com", verification: { status: "verified" } }] }] });
  expect(await grantBeta(input)).toMatchObject({ ok: true });
  expect(m.update).toHaveBeenCalledWith("user_new", { publicMetadata: { beta: expect.objectContaining({ tier: "pro" }) } });
  expect(m.create).not.toHaveBeenCalled();
 });
 it("does not promote an unverified claimant or create a competing invite", async () => {
  m.users.mockResolvedValue({ data: [{ id: "user_bad", emailAddresses: [{ emailAddress: "new@example.com", verification: { status: "unverified" } }] }] });
  expect(await grantBeta(input)).toMatchObject({ ok: false }); expect(m.update).not.toHaveBeenCalled(); expect(m.create).not.toHaveBeenCalled();
 });
 it("does not duplicate an existing pending invite", async () => {
  m.list.mockResolvedValue({ data: [{ id: "inv_existing", emailAddress: "new@example.com" }] });
  expect(await grantBeta(input)).toMatchObject({ ok: false }); expect(m.create).not.toHaveBeenCalled();
 });
 it("rejects invalid email before provider calls", async () => {
  expect(await grantBeta({ ...input, email: "invalid" })).toMatchObject({ ok: false }); expect(m.users).not.toHaveBeenCalled();
 });
 it("denies unauthenticated requests", async () => {
  m.auth.mockResolvedValue({ userId: null }); await expect(grantBeta(input)).rejects.toThrow("Not authenticated"); expect(m.users).not.toHaveBeenCalled();
 });
 it("requires the original admin MFA gate", async () => {
  m.user.mockResolvedValue({ primaryEmailAddressId: "email_1", twoFactorEnabled: false, emailAddresses: [{ id: "email_1", emailAddress: "owner@example.com", verification: { status: "verified" } }] });
  await expect(grantBeta(input)).rejects.toThrow("two-factor"); expect(m.create).not.toHaveBeenCalled();
 });
 it("preserves the owner's configured MFA-off policy", async () => {
  process.env.NULOGDASH_REQUIRE_MFA = "false";
  m.user.mockResolvedValue({ primaryEmailAddressId: "email_1", twoFactorEnabled: false, emailAddresses: [{ id: "email_1", emailAddress: "owner@example.com", verification: { status: "verified" } }] });
  expect(await grantBeta(input)).toMatchObject({ ok: true });
 });
 it("revokes only pending beta invites", async () => {
  m.list.mockResolvedValue({ data: [{ id: "inv_beta", publicMetadata: { beta: { tier: "pro" } } }] });
  expect(await revokeBetaInvitation({ invitationId: "inv_beta" })).toMatchObject({ ok: true }); expect(m.revoke).toHaveBeenCalledWith("inv_beta");
 });
 it("refuses to revoke an unrelated invitation", async () => {
  m.list.mockResolvedValue({ data: [{ id: "inv_other", publicMetadata: {} }] });
  expect(await revokeBetaInvitation({ invitationId: "inv_other" })).toMatchObject({ ok: false }); expect(m.revoke).not.toHaveBeenCalled();
 });
 it("rejects forged invitation IDs", async () => {
  expect(await revokeBetaInvitation({ invitationId: "../other" })).toMatchObject({ ok: false }); expect(m.list).not.toHaveBeenCalled();
 });
});
