import { afterEach, describe, expect, it, vi } from "vitest";
import { SIP_DELAY_MINUTES } from "@/lib/shared/hydration-constants";
import { fetchBars, isFinalBar } from "@/deploy/hydration-job/main";

function alpacaResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const bar = { t: "2026-10-16T04:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isFinalBar", () => {
  // 2026-10-20 is a Tuesday in daylight time, so 16:00 New York is 20:00Z.
  const closeUtcMinutes = 20 * 60;
  const at = (minutesAfterClose: number) => {
    const total = closeUtcMinutes + minutesAfterClose;
    return new Date(Date.UTC(2026, 9, 20, Math.floor(total / 60), total % 60));
  };

  it("is not final before the bell", () => {
    expect(isFinalBar(at(-60), "2026-10-20")).toBe(false);
  });

  it("is not final at the bell or while SIP is still catching up", () => {
    expect(isFinalBar(at(0), "2026-10-20")).toBe(false);
    expect(isFinalBar(at(SIP_DELAY_MINUTES - 1), "2026-10-20")).toBe(false);
  });

  it("is final once the SIP delay has elapsed", () => {
    expect(isFinalBar(at(SIP_DELAY_MINUTES), "2026-10-20")).toBe(true);
  });

  it("is final for any earlier bar date, and over the weekend", () => {
    expect(isFinalBar(new Date("2026-10-21T13:00:00Z"), "2026-10-20")).toBe(true);
    expect(isFinalBar(new Date("2026-10-24T15:00:00Z"), "2026-10-23")).toBe(true);
  });
});

describe("fetchBars", () => {
  it("drops the one invalid symbol and still returns bars for the rest", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
      const symbols = new URL(input).searchParams.get("symbols")!;
      requested.push(symbols);
      if (symbols.includes("SCHW-PD")) return alpacaResponse(400, { message: "invalid symbol: SCHW-PD" });
      return alpacaResponse(200, { bars: { AAPL: [bar], MSFT: [bar] }, next_page_token: null });
    }));

    const bars = await fetchBars(["AAPL", "SCHW-PD", "MSFT"], "2026-10-12", "2026-10-16", "key", "secret");

    expect([...bars.keys()].sort()).toEqual(["AAPL", "MSFT"]);
    expect(requested).toEqual(["AAPL,SCHW-PD,MSFT", "AAPL,MSFT"]);
  });

  it("does not retry a failure that is not about one symbol", async () => {
    const fetchMock = vi.fn(async () => alpacaResponse(429, { message: "rate limit exceeded" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBars(["AAPL"], "2026-10-12", "2026-10-16", "key", "secret"))
      .rejects.toThrow("HTTP 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the named symbol was not one it asked for", async () => {
    const fetchMock = vi.fn(async () => alpacaResponse(400, { message: "invalid symbol: ZZZZ" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchBars(["AAPL"], "2026-10-12", "2026-10-16", "key", "secret"))
      .rejects.toThrow("invalid symbol: ZZZZ");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no budget reservation: one request for one clean batch", async () => {
    const fetchMock = vi.fn(async () => alpacaResponse(200, { bars: { AAPL: [bar] }, next_page_token: null }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchBars(["AAPL"], "2026-10-12", "2026-10-16", "key", "secret");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
