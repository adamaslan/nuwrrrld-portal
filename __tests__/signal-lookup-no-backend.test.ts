import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: mocks.sql }));

describe("fetchTickerEntry without an MCP backend", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns no live entry without calling a hard-coded host", async () => {
    vi.stubEnv("MCP_BACKEND_URL", "");
    vi.stubGlobal("fetch", vi.fn());
    mocks.sql.mockResolvedValue([]);
    const { fetchTickerEntry } = await import("@/lib/shared/signal-lookup");

    expect(await fetchTickerEntry("AAPL")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not use another ticker's payload when the backend misses the requested symbol", async () => {
    vi.stubEnv("MCP_BACKEND_URL", "https://signals.example.test");
    const liveFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      symbols: { AAPL: { symbol: "AAPL", ai_action: "BUY" } },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", liveFetch);
    mocks.sql.mockClear();
    mocks.sql.mockResolvedValue([]);

    const { fetchTickerEntry } = await import("@/lib/shared/signal-lookup");

    expect(await fetchTickerEntry("NVDA")).toBeNull();
    expect(liveFetch).toHaveBeenCalledOnce();
    expect(mocks.sql).toHaveBeenCalledOnce(); // only the cache read; no wrong payload is cached
  });

  it("rejects a mismatched symbol even when the backend uses the requested map key", async () => {
    vi.stubEnv("MCP_BACKEND_URL", "https://signals.example.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      symbols: { NVDA: { symbol: "AAPL", ai_action: "BUY" } },
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    mocks.sql.mockClear();
    mocks.sql.mockResolvedValue([]);

    const { fetchTickerEntry } = await import("@/lib/shared/signal-lookup");

    expect(await fetchTickerEntry("NVDA")).toBeNull();
    expect(mocks.sql).toHaveBeenCalledOnce();
  });
});
