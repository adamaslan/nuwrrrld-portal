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
});
