import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  hasEntitlement: vi.fn(),
  withheld: vi.fn(),
  getViewData: vi.fn(),
  listAccounts: vi.fn(),
  loadArena: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: m.auth, currentUser: m.currentUser }));
vi.mock("next/navigation", () => ({ redirect: m.redirect }));
vi.mock("@/lib/subscription", () => ({ hasEntitlement: m.hasEntitlement }));
vi.mock("@/lib/subscription-admin-server", () => ({
  resolveTierWithPendingBeta: vi.fn(async () => "pro"),
}));
vi.mock("@/lib/followed-tickers-db", () => ({ getViewData: m.getViewData }));
vi.mock("@/lib/paper-db", () => ({
  listAccounts: m.listAccounts,
  getLatestRun: vi.fn(async () => null),
  getLatestRunAnySlot: vi.fn(async () => null),
  getNavSeries: vi.fn(async () => []),
}));
vi.mock("@/lib/paper-arena", () => ({ loadArena: m.loadArena }));
vi.mock("@/lib/nwf2", async (orig) => ({
  ...(await orig<typeof import("@/lib/nwf2")>()),
  nwf2Withheld: m.withheld,
}));

import Nwf2Placeholder from "@/components/Nwf2Placeholder";
import FollowedTickersPage from "@/app/dashboard/followed-tickers/page";
import PaperPortfoliosPage from "@/app/dashboard/council/portfolios/page";
import PaperArenaPage from "@/app/dashboard/council/portfolios/arena/page";

const pages = [
  { name: "followed tickers", page: FollowedTickersPage, title: "Followed Tickers", data: m.getViewData },
  { name: "paper portfolios", page: PaperPortfoliosPage, title: "Council Paper Portfolios", data: m.listAccounts },
  { name: "paper arena", page: PaperArenaPage, title: "Paper Account Arena", data: m.loadArena },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  m.auth.mockResolvedValue({ userId: "user_1" });
  m.currentUser.mockResolvedValue({ publicMetadata: { subscription_status: "active" } });
  m.hasEntitlement.mockReturnValue(true);
  m.withheld.mockReturnValue(true);
  m.getViewData.mockResolvedValue({ picks: [], observationsByPick: {}, scores: [] });
  m.listAccounts.mockResolvedValue([]);
  m.loadArena.mockResolvedValue(null);
});

describe.each(pages)("$name page", ({ page, title, data }) => {
  it("shows the NWF 2.0 placeholder and reads no data when withheld", async () => {
    const el = (await page()) as { type: unknown; props: { title?: string } };
    expect(el.type).toBe(Nwf2Placeholder);
    expect(el.props.title).toBe(title);
    expect(data).not.toHaveBeenCalled();
  });

  it("still sends a signed-out visitor to sign in first", async () => {
    m.auth.mockResolvedValue({ userId: null });
    await expect(page()).rejects.toThrow("REDIRECT:/sign-in");
    expect(data).not.toHaveBeenCalled();
  });

  it("still sends a user without the entitlement to pricing, not the placeholder", async () => {
    m.hasEntitlement.mockReturnValue(false);
    await expect(page()).rejects.toThrow("REDIRECT:/pricing");
    expect(data).not.toHaveBeenCalled();
  });

  it("loads the real page data once the surface is no longer withheld", async () => {
    m.withheld.mockReturnValue(false);
    await Promise.resolve(page()).catch(() => undefined);
    expect(data).toHaveBeenCalled();
  });
});
