import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAlpacaDailyBars } from "@/lib/alpaca-daily-bars";

const fetchMock = vi.fn();
const validBar = { t: "2026-06-01T04:00:00Z", c: 200 };
beforeEach(() => {
  vi.stubEnv("ALPACA_API_KEY", "offline-test");
  vi.stubEnv("ALPACA_API_SECRET", "offline-test");
  vi.stubGlobal("fetch", fetchMock.mockReset());
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Alpaca daily bar row validation", () => {
  it.each([null, { t: 42, c: 199 }, { t: "not-a-date", c: 199 }, { t: validBar.t, c: "199" }, { t: validBar.t, c: Infinity }])("skips malformed row %j without losing the next valid close", async (bad) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ bars: { AAPL: [bad, validBar] } }) });
    expect(await fetchAlpacaDailyBars(["AAPL"], "2026-06-01", "2026-06-01")).toEqual(new Map([["AAPL", [{ date: "2026-06-01", close: 200 }]]]));
  });
  it("skips a malformed symbol collection without losing another symbol", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ bars: { AAPL: {}, MSFT: [validBar] } }) });
    expect(await fetchAlpacaDailyBars(["AAPL", "MSFT"], "2026-06-01", "2026-06-01")).toEqual(new Map([["MSFT", [{ date: "2026-06-01", close: 200 }]]]));
  });
});
