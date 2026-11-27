import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAlpacaDailyBars } from "@/lib/alpaca-daily-bars";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv("ALPACA_API_KEY", "offline-test");
  vi.stubEnv("ALPACA_API_SECRET", "offline-test");
  vi.stubGlobal("fetch", fetchMock.mockReset());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Alpaca daily bar requested range", () => {
  it("drops returned bars before and after the inclusive requested dates", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ bars: { AAPL: [
      { t: "2026-05-29T04:00:00Z", c: 199 },
      { t: "2026-06-01T04:00:00Z", c: 200 },
      { t: "2026-06-02T04:00:00Z", c: 201 },
      { t: "2026-06-03T04:00:00Z", c: 202 },
    ] } }) });
    expect(await fetchAlpacaDailyBars(["AAPL"], "2026-06-01", "2026-06-02")).toEqual(new Map([["AAPL", [
      { date: "2026-06-01", close: 200 }, { date: "2026-06-02", close: 201 },
    ]]]));
  });
});
