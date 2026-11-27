import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAlpacaCloseOn, fetchAlpacaDailyBars } from "@/lib/alpaca-daily-bars";

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubEnv("ALPACA_API_KEY", "offline-test");
  vi.stubEnv("ALPACA_API_SECRET", "offline-test");
  vi.stubGlobal("fetch", fetchMock.mockReset());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Alpaca daily bar invalid-window fallback", () => {
  it("returns an empty map rather than throwing for an unparseable end date", async () => {
    await expect(fetchAlpacaDailyBars(["AAPL"], "2026-06-01", "not-a-date")).resolves.toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("returns null rather than throwing for an invalid single close date", async () => {
    await expect(fetchAlpacaCloseOn("AAPL", "not-a-date")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("preserves valid completed bar results", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ bars: { AAPL: [{ t: "2026-06-01T04:00:00Z", c: 200 }] } }) });
    await expect(fetchAlpacaDailyBars(["AAPL"], "2026-06-01", "2026-06-01")).resolves.toEqual(new Map([["AAPL", [{ date: "2026-06-01", close: 200 }]]]));
  });
});
