import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const result = (symbol: string) => ({ symbol, period: "2y", horizon_days: 5, bars_scanned: 500, by_category: [{ key: "MACD", hits: 20, total: 40, hit_rate: 0.5 }], by_strength: [] });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SIGNALS_ENGINE_URL", "https://backtest.test");
  vi.stubGlobal("fetch", fetchMock.mockReset());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("fetchBacktest symbol binding", () => {
  it.each(["MSFT", "", undefined])("does not return results attributed to %s for AAPL", async (symbol) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => result(symbol as string) });
    const { fetchBacktest } = await import("@/lib/backtest");
    expect(await fetchBacktest("AAPL")).toBeNull();
  });

  it("preserves results for the exact requested symbol", async () => {
    const expected = result("AAPL");
    fetchMock.mockResolvedValue({ ok: true, json: async () => expected });
    const { fetchBacktest } = await import("@/lib/backtest");
    expect(await fetchBacktest("AAPL")).toEqual(expected);
    expect(fetchMock.mock.calls[0][0]).toBe("https://backtest.test/backtest/AAPL?period=2y");
  });
});
