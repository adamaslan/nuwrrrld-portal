import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ auth: vi.fn(), user: vi.fn(), users: vi.fn(), get: vi.fn(), update: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth, currentUser: m.user, clerkClient: async () => ({ users: { getUserList: m.users, getUser: m.get, updateUserMetadata: m.update } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { grantBeta, revokePendingBeta } from "@/lib/nulogdash-beta-actions";
import { betaEmailId, BETA_EMAIL_KEY } from "@/lib/beta-email-registry";
import { buildBetaGrant } from "@/lib/beta-grant-admin";
import { __resetRateLimitState } from "@/lib/rate-limit";
const input = { email: " New@Example.com ", expiresAt: "", note: "" };
const old = { ...process.env };
const owner = () => ({ primaryEmailAddressId: "email_1", twoFactorEnabled: true, emailAddresses: [{ id: "email_1", emailAddress: "owner@example.com", verification: { status: "verified" } }] });
beforeEach(() => {
 vi.resetAllMocks(); __resetRateLimitState();
 process.env.NULOGDASH_ADMIN_EMAILS = "owner@example.com"; process.env.NULOGDASH_REQUIRE_MFA = "true";
 m.auth.mockResolvedValue({ userId: "user_owner" }); m.user.mockResolvedValue(owner());
 m.users.mockResolvedValue({ data: [] }); m.get.mockResolvedValue({ privateMetadata: {}, publicMetadata: {}, unsafeMetadata: {} });
 vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...old }; vi.restoreAllMocks(); });
describe("verified-email beta enrollment", () => {
 it("stores a private pending email without creating an invitation or auto-verifying an address", async () => {
  expect(await grantBeta(input)).toMatchObject({ ok: true, signupUrl: "/sign-up?redirect_url=/dashboard" });
  expect(m.update).toHaveBeenCalledWith("user_owner", { privateMetadata: { [BETA_EMAIL_KEY]: { [betaEmailId("new@example.com")]: { email: "new@example.com", grant: expect.objectContaining({ tier: "pro", expiresAt: null }) } } } });
  expect(JSON.stringify(m.update.mock.calls)).not.toContain("publicMetadata");
 });
 it("merges only one private key, preserving unrelated metadata and other pending grants", async () => {
  m.get.mockResolvedValue({ privateMetadata: { other: "kept", [BETA_EMAIL_KEY]: { [betaEmailId("old@example.com")]: { email: "old@example.com", grant: buildBetaGrant({email:"old@example.com",expiresAt:null,note:null}) } } } });
  await grantBeta(input);
  expect(Object.keys(m.update.mock.calls[0][1].privateMetadata[BETA_EMAIL_KEY])).toEqual([betaEmailId("new@example.com")]);
 });
 it("fails clearly at the ten-email cap", async () => {
  const entries = Object.fromEntries(Array.from({length:10},(_,i)=>{ const email=`a${i}@example.com`;return [betaEmailId(email),{email,grant:buildBetaGrant({email,expiresAt:null,note:null})}]; }));
  m.get.mockResolvedValue({privateMetadata:{[BETA_EMAIL_KEY]:entries}});
  expect(await grantBeta(input)).toMatchObject({ok:false,error:expect.stringContaining("capacity")});expect(m.update).not.toHaveBeenCalled();
 });
 it("fails before writing when unrelated metadata exhausts the budget", async () => {
  m.get.mockResolvedValue({privateMetadata:{other:"x".repeat(7100)}});
  expect(await grantBeta(input)).toMatchObject({ok:false});expect(m.update).not.toHaveBeenCalled();
 });
 it("grants a verified existing account without changing billing/admin", async () => {
  m.users.mockResolvedValue({ data: [{ id: "user_new", emailAddresses: [{ emailAddress: "new@example.com", verification: { status: "verified" } }] }] });
  expect(await grantBeta(input)).toMatchObject({ ok: true });
  expect(m.update).toHaveBeenCalledWith("user_new", { publicMetadata: { beta: expect.objectContaining({ tier: "pro" }) } });
 });
 it("does not promote an unverified claimant or store a pending grant", async () => {
  m.users.mockResolvedValue({ data: [{ id: "user_bad", emailAddresses: [{ emailAddress: "new@example.com", verification: { status: "unverified" } }] }] });
  expect(await grantBeta(input)).toMatchObject({ ok: false }); expect(m.update).not.toHaveBeenCalled();
 });
 it("rejects invalid email", async () => { expect(await grantBeta({ ...input, email: "invalid" })).toMatchObject({ ok: false }); expect(m.users).not.toHaveBeenCalled(); });
 it("denies unauthenticated requests", async () => { m.auth.mockResolvedValue({ userId: null }); await expect(grantBeta(input)).rejects.toThrow("Not authenticated"); });
 it("requires configured MFA", async () => { m.user.mockResolvedValue({...owner(),twoFactorEnabled:false}); await expect(grantBeta(input)).rejects.toThrow("configured MFA"); expect(m.update).not.toHaveBeenCalled(); });
 it("preserves configured MFA-off policy", async () => { process.env.NULOGDASH_REQUIRE_MFA="false";m.user.mockResolvedValue({...owner(),twoFactorEnabled:false});expect(await grantBeta(input)).toMatchObject({ok:true}); });
 it("revokes only current admin's hashed private key", async () => { const id=betaEmailId("new@example.com");expect(await revokePendingBeta({emailId:id})).toMatchObject({ok:true});expect(m.update).toHaveBeenCalledWith("user_owner",{privateMetadata:{[BETA_EMAIL_KEY]:{[id]:null}}}); });
 it("rejects forged registry keys", async () => {expect(await revokePendingBeta({emailId:"../other"})).toMatchObject({ok:false});expect(m.update).not.toHaveBeenCalled();});
});
