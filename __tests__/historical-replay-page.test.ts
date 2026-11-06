import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminIdentity } from "@/lib/nulogdash";

/**
 * SSR auth-gate tests for the historical-replay PAGE. The API route's gate
 * has its own coverage; these tests exist because the page server-renders
 * artifact data and its deny paths were previously guaranteed only by code
 * order. The real isNulogdashReplayOwner runs (not mocked): these tests prove
 * the page wiring, not just the predicate.
 *
 * Zero-read guarantee: on every deny path loadHistoricalReplay must never be
 * called, and on the allow path it must be called exactly once.
 */
const mocks = vi.hoisted(() => ({
  flagLive: vi.fn<() => boolean>(),
  auth: vi.fn(),
  currentUser: vi.fn(),
  loadHistoricalReplay: vi.fn(),
  notFound: vi.fn((): never => { throw new Error("NEXT_NOT_FOUND"); }),
  redirect: vi.fn((url: string): never => { throw new Error(`NEXT_REDIRECT:${url}`); }),
}));

vi.mock("@/lib/flags", () => ({ flagLive: mocks.flagLive }));
vi.mock("@clerk/nextjs/server", () => ({ auth: mocks.auth, currentUser: mocks.currentUser }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/historical-replay-store", () => ({ loadHistoricalReplay: mocks.loadHistoricalReplay }));

import HistoricalReplayPage from "@/app/dashboard/research/historical-replay/page";
import { HistoricalReplaySection } from "@/components/research/HistoricalReplaySection";

const ORIGINAL_ADMIN = process.env.NULOGDASH_ADMIN_EMAILS;
const ORIGINAL_OWNER = process.env.NULOGDASH_REPLAY_OWNER_EMAILS;

/** Same Clerk-shaped builder as __tests__/nulogdash-admin.test.ts. */
function user(overrides: {
  email?: string;
  verified?: boolean;
  extra?: AdminIdentity["emailAddresses"];
} = {}): AdminIdentity {
  const { email = "owner@example.com", verified = true, extra = [] } = overrides;
  return {
    primaryEmailAddressId: "idn_primary",
    twoFactorEnabled: true,
    emailAddresses: [
      ...extra,
      { id: "idn_primary", emailAddress: email, verification: { status: verified ? "verified" : "unverified" } },
    ],
  };
}

describe("historical replay page SSR gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flagLive.mockReturnValue(true);
    mocks.auth.mockResolvedValue({ userId: "user_1" });
    process.env.NULOGDASH_ADMIN_EMAILS = "owner@example.com,other-admin@example.com";
    process.env.NULOGDASH_REPLAY_OWNER_EMAILS = "owner@example.com";
  });
  afterEach(() => {
    if (ORIGINAL_ADMIN === undefined) delete process.env.NULOGDASH_ADMIN_EMAILS;
    else process.env.NULOGDASH_ADMIN_EMAILS = ORIGINAL_ADMIN;
    if (ORIGINAL_OWNER === undefined) delete process.env.NULOGDASH_REPLAY_OWNER_EMAILS;
    else process.env.NULOGDASH_REPLAY_OWNER_EMAILS = ORIGINAL_OWNER;
  });

  it("flag off: 404 before auth, user lookup, or any store read", async () => {
    mocks.flagLive.mockReturnValue(false);
    await expect(HistoricalReplayPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.currentUser).not.toHaveBeenCalled();
    expect(mocks.loadHistoricalReplay).not.toHaveBeenCalled();
  });

  it("signed out: redirects to sign-in, no user lookup or store read", async () => {
    mocks.auth.mockResolvedValue({ userId: null });
    await expect(HistoricalReplayPage()).rejects.toThrow(
      "NEXT_REDIRECT:/sign-in?redirect_url=/dashboard/research/historical-replay",
    );
    expect(mocks.currentUser).not.toHaveBeenCalled();
    expect(mocks.loadHistoricalReplay).not.toHaveBeenCalled();
  });

  it("shared-allowlist admin who is not the replay owner: 404 with zero store reads", async () => {
    mocks.currentUser.mockResolvedValue(user({ email: "other-admin@example.com" }));
    await expect(HistoricalReplayPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.loadHistoricalReplay).not.toHaveBeenCalled();
  });

  it("owner list unset: fails closed even for the would-be owner", async () => {
    delete process.env.NULOGDASH_REPLAY_OWNER_EMAILS;
    mocks.currentUser.mockResolvedValue(user({ email: "owner@example.com" }));
    await expect(HistoricalReplayPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.loadHistoricalReplay).not.toHaveBeenCalled();
  });

  it("matching address on a NON-primary email does not pass", async () => {
    mocks.currentUser.mockResolvedValue(user({
      email: "other-admin@example.com",
      extra: [{ id: "idn_alt", emailAddress: "owner@example.com", verification: { status: "verified" } }],
    }));
    await expect(HistoricalReplayPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.loadHistoricalReplay).not.toHaveBeenCalled();
  });

  it("unverified primary address does not pass", async () => {
    mocks.currentUser.mockResolvedValue(user({ email: "owner@example.com", verified: false }));
    await expect(HistoricalReplayPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.loadHistoricalReplay).not.toHaveBeenCalled();
  });

  it("verified-primary replay owner: renders the section with exactly one store read", async () => {
    const result = { status: "ok", view: { requested: 954 } };
    mocks.currentUser.mockResolvedValue(user({ email: "owner@example.com" }));
    mocks.loadHistoricalReplay.mockResolvedValue(result);
    const el = await HistoricalReplayPage();
    expect(mocks.loadHistoricalReplay).toHaveBeenCalledTimes(1);
    expect(el.type).toBe(HistoricalReplaySection);
    expect(el.props.result).toBe(result);
  });
});
