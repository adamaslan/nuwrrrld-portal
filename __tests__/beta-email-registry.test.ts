import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const m=vi.hoisted(()=>({list:vi.fn()}));
vi.mock("@clerk/nextjs/server",()=>({clerkClient:async()=>({users:{getUserList:m.list}})}));
import { hasPendingEmailBeta, betaEmailId, BETA_EMAIL_KEY, readBetaEmails } from "@/lib/beta-email-registry";
import { resolveTierWithPendingBeta, parseSubscriptionWithPendingBeta } from "@/lib/subscription-admin-server";
const env={...process.env};
function user(email="new@example.com",status="verified") {return {primaryEmailAddressId:"e1",emailAddresses:[{id:"e1",emailAddress:email,verification:{status}}]};}
const grant={tier:"pro",expiresAt:null};
function admin(entry:unknown=grant){return {...user("owner@example.com"),privateMetadata:{[BETA_EMAIL_KEY]:{[betaEmailId("new@example.com")]:{email:"new@example.com",grant:entry}}}};}
beforeEach(()=>{vi.resetAllMocks();process.env.NULOGDASH_ADMIN_EMAILS="owner@example.com";m.list.mockResolvedValue({data:[admin()],totalCount:1});});
afterEach(()=>{process.env={...env};vi.restoreAllMocks();});
describe("authoritative private beta registry",()=>{
 it("allows only ordinary verified primary email and selects admins by current allowlist",async()=>{expect(await hasPendingEmailBeta(user())).toBe(true);expect(m.list).toHaveBeenCalledWith({emailAddress:["owner@example.com"],limit:500});});
 it("does not allow another claimant with an unverified email",async()=>{expect(await hasPendingEmailBeta(user("new@example.com","unverified"))).toBe(false);expect(m.list).not.toHaveBeenCalled();});
 it("does not allow a verified different email",async()=>{expect(await hasPendingEmailBeta(user("other@example.com"))).toBe(false);});
 it("does not match a secondary address",async()=>{const u=user("other@example.com");u.emailAddresses.push({id:"e2",emailAddress:"new@example.com",verification:{status:"verified"}});expect(await hasPendingEmailBeta(u)).toBe(false);});
 it("does not trust registry on a nonadmin or unverified admin",async()=>{m.list.mockResolvedValue({data:[{...admin(),...user("owner@example.com","unverified")}],totalCount:1});expect(await hasPendingEmailBeta(user())).toBe(false);});
 it("fails closed on provider errors",async()=>{vi.spyOn(console,"warn").mockImplementation(()=>{});m.list.mockRejectedValue(new Error("offline"));expect(await hasPendingEmailBeta(user())).toBe(false);});
 it("fails closed on partial admin scan",async()=>{m.list.mockResolvedValue({data:[admin()],totalCount:501});expect(await hasPendingEmailBeta(user())).toBe(false);});
 it("revoked entries stop qualifying on next read without materialized metadata",async()=>{expect(await hasPendingEmailBeta(user())).toBe(true);m.list.mockResolvedValue({data:[{...admin(),privateMetadata:{[BETA_EMAIL_KEY]:{}}}],totalCount:1});expect(await hasPendingEmailBeta(user())).toBe(false);});
 it("expired and malformed grants fail closed",async()=>{for(const expiresAt of ["2020-01-01","invalid","2027-02-30"]){m.list.mockResolvedValue({data:[admin({tier:"pro",expiresAt})],totalCount:1});expect(await hasPendingEmailBeta(user())).toBe(false);}});
 it("rejects mismatched hash and malformed registry values",()=>{expect(readBetaEmails({[BETA_EMAIL_KEY]:{forged:{email:"new@example.com",grant}}})).toEqual({});expect(readBetaEmails({[BETA_EMAIL_KEY]:[]})).toEqual({});});
 it("server wrapper includes registry entitlement and preserves billing status",async()=>{expect(await resolveTierWithPendingBeta("free",user())).toBe("pro");expect(await parseSubscriptionWithPendingBeta({subscription_status:"free"},user())).toMatchObject({status:"free",tier:"pro"});});
 it("existing paid or user-metadata grants need no registry request",async()=>{expect(await resolveTierWithPendingBeta("active",user())).toBe("pro");expect(await resolveTierWithPendingBeta("free",{...user(),publicMetadata:{beta:grant}})).toBe("pro");expect(m.list).not.toHaveBeenCalled();});
 it("anonymous users cannot qualify",async()=>{expect(await hasPendingEmailBeta(null)).toBe(false);expect(m.list).not.toHaveBeenCalled();});
});
