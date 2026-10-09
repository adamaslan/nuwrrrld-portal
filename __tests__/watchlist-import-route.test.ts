import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, sqlMock, store, enqueueMany } = vi.hoisted(() => ({
  authMock: vi.fn(),
  sqlMock: vi.fn(),
  store: {
    findExistingWatchlistTickers: vi.fn(),
    countWatchlist: vi.fn(),
    addManyToWatchlist: vi.fn(),
  },
  enqueueMany: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ auth: () => authMock() }));
vi.mock("@/lib/db", () => ({ default: (...a: unknown[]) => sqlMock(...a) }));
vi.mock("@/lib/signal-queue", () => ({ enqueueSignalRefreshMany: (...a: unknown[]) => enqueueMany(...a) }));
vi.mock("@/lib/watchlist-store", async () => {
  class WatchlistCapError extends Error {}
  return { ...store, WatchlistCapError };
});

import { POST } from "@/app/api/portfolio/watchlist/import/route";
import { __resetRateLimitState } from "@/lib/rate-limit";
import { NextRequest } from "next/server";

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost:3000/api/portfolio/watchlist/import", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  __resetRateLimitState();
  authMock.mockResolvedValue({ userId: "user_1" });
  sqlMock.mockResolvedValue([{ ticker: "AAPL" }, { ticker: "MSFT" }]);
  store.findExistingWatchlistTickers.mockResolvedValue(new Set());
  store.countWatchlist.mockResolvedValue(10);
  store.addManyToWatchlist.mockImplementation(async (_u: string, t: string[]) => t);
});

describe("POST /api/portfolio/watchlist/import", () => {
  it("401 without a session", async () => {
    authMock.mockResolvedValue({ userId: null });
    expect((await POST(req({ tickers: ["AAPL"] }))).status).toBe(401);
    expect(store.addManyToWatchlist).not.toHaveBeenCalled();
  });

  it("403 on foreign Origin, 415 on wrong content type", async () => {
    expect((await POST(req({ tickers: ["AAPL"] }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(req("x", { "content-type": "text/plain" }))).status).toBe(415);
  });

  it("413 on a streamed body over 32 KB even with a lying Content-Length", async () => {
    const big = JSON.stringify({ tickers: ["A"], pad: "x".repeat(40_000) });
    expect((await POST(req(big, { "content-length": "10" }))).status).toBe(413);
  });

  it("429 with Retry-After on the 6th call", async () => {
    for (let i = 0; i < 5; i++) expect((await POST(req({ tickers: ["AAPL"], dryRun: true }))).status).toBe(200);
    const res = await POST(req({ tickers: ["AAPL"], dryRun: true }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("422 over the cap with zero inserts", async () => {
    store.countWatchlist.mockResolvedValue(1_499);
    const res = await POST(req({ tickers: ["AAPL", "MSFT"] }));
    expect(res.status).toBe(422);
    expect(store.addManyToWatchlist).not.toHaveBeenCalled();
  });

  it("dryRun neither inserts nor enqueues", async () => {
    const res = await POST(req({ tickers: ["AAPL"], dryRun: true }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.added).toEqual(["AAPL"]);
    expect(store.addManyToWatchlist).not.toHaveBeenCalled();
    expect(enqueueMany).not.toHaveBeenCalled();
  });

  it("inserts and enqueues only newly added tickers; never echoes malformed input", async () => {
    store.findExistingWatchlistTickers.mockResolvedValue(new Set(["MSFT"]));
    const res = await POST(req({ tickers: ["AAPL", "MSFT", "<script>", "ZZZZ"] }));
    const json = await res.json();
    expect(res.status).toBe(201);
    expect(store.addManyToWatchlist).toHaveBeenCalledWith("user_1", ["AAPL"], 1_500);
    expect(enqueueMany).toHaveBeenCalledWith(["AAPL"], "user_1");
    expect(json.skipped).toEqual({ already_present: 1, unknown_symbol: 1, invalid: 1, crypto_unsupported: 0 });
    expect(json.rejectedSample).toEqual(["ZZZZ"]);
    expect(JSON.stringify(json)).not.toContain("script");
  });

  it("400 on malformed shape", async () => {
    expect((await POST(req({ tickers: "AAPL" }))).status).toBe(400);
    expect((await POST(req("{nope"))).status).toBe(400);
  });
});
