import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sql: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: mocks.sql }));
import { fetchTickerEntry } from "@/lib/shared/signal-lookup";

describe("fetchTickerEntry symbol binding", () => {
  beforeEach(() => {
    mocks.sql.mockReset().mockResolvedValue([]);
    mocks.fetch.mockReset();
    vi.stubEnv("MCP_BACKEND_URL", "https://signals.test");
    vi.stubGlobal("fetch", mocks.fetch);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("does not return or cache a different symbol when the requested key is absent", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ symbols: { MSFT: { ai_action: "BUY", confluence_score: 91 } } }) });
    expect(await fetchTickerEntry("AAPL")).toBeNull();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("retains the requested symbol's stale cache when the live payload has only another symbol", async () => {
    const stale = { ai_action: "HOLD", confluence_score: 35 };
    mocks.sql.mockResolvedValue([{ payload: stale, generated_at: "2020-01-01T00:00:00Z" }]);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ symbols: { MSFT: { ai_action: "BUY", confluence_score: 91 } } }) });
    expect(await fetchTickerEntry("AAPL")).toEqual(stale);
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "bad-cache", 42])("recovers from invalid cached payload %j through the live backend", async (payload) => {
    const expected = { ai_action: "BUY", confluence_score: 72 };
    mocks.sql.mockResolvedValue([{ payload, generated_at: new Date().toISOString() }]);
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ symbols: { AAPL: expected } }) });
    expect(await fetchTickerEntry("AAPL")).toEqual(expected);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([null, [], "bad-cache", 42])("does not serve invalid stale cache %j during an outage", async (payload) => {
    mocks.sql.mockResolvedValue([{ payload, generated_at: "2020-01-01T00:00:00Z" }]);
    mocks.fetch.mockRejectedValue(new Error("offline fixture"));
    expect(await fetchTickerEntry("AAPL")).toBeNull();
    expect(mocks.sql).toHaveBeenCalledTimes(1);
  });

  it("keeps a valid fresh cache entry without a live fetch", async () => {
    const payload = { ai_action: "HOLD", confluence_score: 50 };
    mocks.sql.mockResolvedValue([{ payload, generated_at: new Date().toISOString() }]);
    expect(await fetchTickerEntry("AAPL")).toEqual(payload);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("returns and caches the exact requested key even when another key appears first", async () => {
    const expected = { ai_action: "HOLD", confluence_score: 35 };
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ symbols: { MSFT: { ai_action: "BUY" }, AAPL: expected } }) });
    expect(await fetchTickerEntry(" aapl ")).toEqual(expected);
    expect(mocks.sql).toHaveBeenCalledTimes(2);
    expect(mocks.sql.mock.calls[1][1]).toBe("AAPL");
  });
});
