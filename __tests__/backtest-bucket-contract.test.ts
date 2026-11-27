import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const validBucket = { key: "MACD", hits: 20, total: 40, hit_rate: 0.5 };
const fetchMock = vi.fn();
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SIGNALS_ENGINE_URL", "https://backtest.test");
  vi.stubGlobal("fetch", fetchMock.mockReset());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function load(bucket: object, field = "by_category") {
  const data = { symbol: "AAPL", period: "2y", horizon_days: 5, bars_scanned: 500, by_category: [validBucket], by_strength: [], [field]: [bucket] };
  fetchMock.mockResolvedValue({ ok: true, json: async () => data });
  return (await import("@/lib/backtest")).fetchBacktest("AAPL");
}

describe("backtest bucket probability and sample contract", () => {
  it.each([-0.1, 1.1, NaN, Infinity])("rejects invalid hit_rate %s", async (hit_rate) => {
    expect(await load({ ...validBucket, hit_rate })).toBeNull();
  });
  it.each([
    { hits: -1 }, { total: -1 }, { hits: 41 }, { hits: 1.5 },
    { total: 40.5 }, { hits: Infinity }, { total: NaN },
  ])("rejects impossible sample counts %j", async (override) => {
    expect(await load({ ...validBucket, ...override })).toBeNull();
  });
  it("validates strength buckets too", async () => {
    expect(await load({ ...validBucket, hit_rate: 2 }, "by_strength")).toBeNull();
  });
  it.each([
    { key: "none", hits: 0, total: 0, hit_rate: 0 },
    { key: "all", hits: 40, total: 40, hit_rate: 1 },
    { key: "rounded", hits: 97, total: 142, hit_rate: 0.6831 },
  ])("preserves legitimate boundary/rounded bucket %j", async (bucket) => {
    expect((await load(bucket))?.by_category).toEqual([bucket]);
  });
});
