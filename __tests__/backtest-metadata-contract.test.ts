import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const valid = { symbol: "AAPL", period: "2y", horizon_days: 5, bars_scanned: 500, by_category: [], by_strength: [] };
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SIGNALS_ENGINE_URL", "https://backtest.test");
  vi.stubGlobal("fetch", fetchMock.mockReset());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function load(override: object) {
  const data = { ...valid, ...override };
  fetchMock.mockResolvedValue({ ok: true, json: async () => data });
  return (await import("@/lib/backtest")).fetchBacktest("AAPL");
}

describe("backtest result metadata contract", () => {
  it.each([undefined, null, {}, 2, "", "   "])("rejects invalid period %j", async (period) => {
    expect(await load({ period })).toBeNull();
  });
  it.each([undefined, null, "5", 0, -1, 1.5, NaN, Infinity])("rejects invalid horizon_days %j", async (horizon_days) => {
    expect(await load({ horizon_days })).toBeNull();
  });
  it.each([undefined, null, "500", -1, 1.5, NaN, Infinity])("rejects invalid bars_scanned %j", async (bars_scanned) => {
    expect(await load({ bars_scanned })).toBeNull();
  });
  it("preserves valid metadata including zero scanned bars", async () => {
    expect(await load({ bars_scanned: 0 })).toEqual({ ...valid, bars_scanned: 0 });
  });
  it("preserves a non-default nonempty period and positive horizon", async () => {
    expect(await load({ period: "1y", horizon_days: 1 })).toEqual({ ...valid, period: "1y", horizon_days: 1 });
  });
});
