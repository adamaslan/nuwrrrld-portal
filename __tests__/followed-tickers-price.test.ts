/**
 * followed-tickers price chain (plan F4). Order is live_prices → Alpaca →
 * daily_bars, and a rung counts only if its price is dated on or after the
 * freshness bound. Each source is mocked, so no DB or network is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/live-price-db", () => ({ getLivePrice: vi.fn() }));
vi.mock("@/lib/alpaca-latest-price", () => ({ fetchAlpacaLatestTrade: vi.fn() }));
vi.mock("@/lib/alpaca-daily-bars", () => ({ fetchAlpacaDailyBars: vi.fn() }));
vi.mock("@/lib/followed-tickers-db", () => ({ getLatestDailyBar: vi.fn() }));

import { getLivePrice } from "@/lib/live-price-db";
import { fetchAlpacaLatestTrade } from "@/lib/alpaca-latest-price";
import { fetchAlpacaDailyBars } from "@/lib/alpaca-daily-bars";
import { getLatestDailyBar } from "@/lib/followed-tickers-db";
import { nyDateDaysAgo, nyDateOf, resolveFollowedPrice } from "@/lib/followed-tickers-price";

const mockLive = vi.mocked(getLivePrice);
const mockAlpaca = vi.mocked(fetchAlpacaLatestTrade);
const mockBar = vi.mocked(getLatestDailyBar);
const mockSip = vi.mocked(fetchAlpacaDailyBars);

const FRESH_SINCE = "2026-06-01";
/** 2026-06-03 15:00 ET. */
const TRADED_THU = "2026-06-03T19:00:00Z";
const TRADED_LAST_MONTH = "2026-05-10T19:00:00Z";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mockLive.mockResolvedValue(null);
  mockAlpaca.mockResolvedValue(null);
  mockBar.mockResolvedValue(null);
  mockSip.mockResolvedValue(new Map());
});

describe("nyDateOf", () => {
  it("uses the New York calendar date, not UTC", () => {
    // 02:00 UTC on Jun 2 is 22:00 on Jun 1 in New York (EDT).
    expect(nyDateOf(new Date("2026-06-02T02:00:00Z"))).toBe("2026-06-01");
  });
});

describe("nyDateDaysAgo", () => {
  it("returns the NY date N days before now", () => {
    expect(nyDateDaysAgo(new Date("2026-06-08T15:00:00Z"), 7)).toBe("2026-06-01");
  });
});

describe("resolveFollowedPrice", () => {
  it("takes a fresh live_prices row first", async () => {
    mockLive.mockResolvedValue({
      ticker: "AAPL",
      price: 210,
      volume: null,
      tradedAt: TRADED_THU,
      updatedAt: TRADED_THU,
    });
    const out = await resolveFollowedPrice("AAPL", { freshSince: FRESH_SINCE });
    expect(out).toEqual({ price: 210, source: "live_prices", asOf: "2026-06-03" });
    expect(mockAlpaca).not.toHaveBeenCalled();
    expect(mockBar).not.toHaveBeenCalled();
  });

  it("never records a stale live_prices row, and falls through to Alpaca", async () => {
    mockLive.mockResolvedValue({
      ticker: "AAPL",
      price: 150,
      volume: null,
      tradedAt: TRADED_LAST_MONTH,
      updatedAt: TRADED_LAST_MONTH,
    });
    mockAlpaca.mockResolvedValue({ price: 211, tradedAt: TRADED_THU });
    const out = await resolveFollowedPrice("AAPL", { freshSince: FRESH_SINCE });
    expect(out).toEqual({ price: 211, source: "alpaca_iex", asOf: "2026-06-03" });
  });

  it("falls through to the latest daily_bars close when both live sources are empty", async () => {
    mockBar.mockResolvedValue({ barDate: "2026-06-02", close: 208.5 });
    const out = await resolveFollowedPrice("AAPL", { freshSince: FRESH_SINCE });
    expect(out).toEqual({ price: 208.5, source: "daily_bars", asOf: "2026-06-02" });
  });

  it("rejects a daily_bars close older than the freshness bound", async () => {
    mockBar.mockResolvedValue({ barDate: "2026-05-29", close: 200 });
    expect(await resolveFollowedPrice("AAPL", { freshSince: FRESH_SINCE })).toBeNull();
  });

  it("returns null only when every source is empty or stale", async () => {
    expect(await resolveFollowedPrice("ZZZZ", { freshSince: FRESH_SINCE })).toBeNull();
  });
});

describe("resolveFollowedPrice with closedOn (track runs)", () => {
  const CLOSED_ON = "2026-06-03";
  /** 2026-06-03 17:00 ET, after the 16:00 close. */
  const TRADED_AFTER_CLOSE = "2026-06-03T21:00:00Z";

  it("rejects a pre-close live print from the same day", async () => {
    // TRADED_THU is 15:00 ET, before the close, so it must not become the close.
    mockLive.mockResolvedValue({
      ticker: "AAPL",
      price: 210,
      volume: null,
      tradedAt: TRADED_THU,
      updatedAt: TRADED_THU,
    });
    expect(await resolveFollowedPrice("AAPL", { freshSince: CLOSED_ON, closedOn: CLOSED_ON })).toBeNull();
  });

  it("accepts a live print traded after the close", async () => {
    mockLive.mockResolvedValue({
      ticker: "AAPL",
      price: 212,
      volume: null,
      tradedAt: TRADED_AFTER_CLOSE,
      updatedAt: TRADED_AFTER_CLOSE,
    });
    const out = await resolveFollowedPrice("AAPL", { freshSince: CLOSED_ON, closedOn: CLOSED_ON });
    expect(out).toEqual({ price: 212, source: "live_prices", asOf: CLOSED_ON });
  });

  it("uses only the closed day's own daily bar", async () => {
    mockBar.mockResolvedValue({ barDate: "2026-06-02", close: 208.5 });
    expect(await resolveFollowedPrice("AAPL", { freshSince: CLOSED_ON, closedOn: CLOSED_ON })).toBeNull();

    mockBar.mockResolvedValue({ barDate: CLOSED_ON, close: 209.1 });
    const out = await resolveFollowedPrice("AAPL", { freshSince: CLOSED_ON, closedOn: CLOSED_ON });
    expect(out).toEqual({ price: 209.1, source: "daily_bars", asOf: CLOSED_ON });
  });
});

describe("Alpaca SIP daily bar rung", () => {
  const CLOSED_ON = "2026-06-03";
  it("supplies the closed day's close when nothing else has it (evening run)", async () => {
    mockSip.mockResolvedValue(
      new Map([["AAPL", [{ date: CLOSED_ON, close: 212.4 }]]]),
    );
    const out = await resolveFollowedPrice("AAPL", { freshSince: CLOSED_ON, closedOn: CLOSED_ON });
    expect(out).toEqual({ price: 212.4, source: "alpaca_daily_bar", asOf: CLOSED_ON });
    expect(mockBar).not.toHaveBeenCalled();
  });

  it("ignores a SIP bar from a different session than closedOn", async () => {
    mockSip.mockResolvedValue(
      new Map([["AAPL", [{ date: "2026-06-01", close: 200 }]]]),
    );
    const out = await resolveFollowedPrice("AAPL", { freshSince: CLOSED_ON, closedOn: CLOSED_ON });
    expect(out).toBeNull();
  });
});
