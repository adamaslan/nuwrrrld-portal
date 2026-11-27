import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ read: vi.fn(), view: vi.fn((points: unknown[]) => points) }));
vi.mock("@/lib/paper-db", () => ({ getNavSeries: m.read }));
vi.mock("@/lib/shared/paper-view", () => ({ buildNavSeriesView: m.view }));
const request = new Request("https://example.test/api/paper/t1/nav");
function call(GET: typeof import("@/app/api/paper/[account]/nav/route").GET, account = "t1") { return GET(request, { params: Promise.resolve({ account }) }); }
const point = { tradeDate: "2026-11-25", nav: 100, positionsN: 1 };
describe("paper NAV concurrent request sharing", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  it("coalesces simultaneous cold requests into one read and preserves payload", async () => {
    let complete!: (rows: unknown[]) => void;
    m.read.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const { GET } = await import("@/app/api/paper/[account]/nav/route");
    const requests = Array.from({ length: 20 }, () => call(GET)); await Promise.resolve(); await Promise.resolve();
    expect(m.read).toHaveBeenCalledTimes(1);
    complete([point]);
    const responses = await Promise.all(requests);
    for (const response of responses) expect(await response.json()).toEqual({ account: "t1", series: [point] });
    await call(GET); expect(m.read).toHaveBeenCalledTimes(1);
  });
  it("refreshes after the existing five-minute TTL", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      m.read.mockResolvedValue([point]);
      const { GET } = await import("@/app/api/paper/[account]/nav/route");
      await call(GET); clock.mockReturnValue(300999); await call(GET);
      expect(m.read).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(301000); await call(GET);
      expect(m.read).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });
  it("does not mix accounts", async () => {
    m.read.mockImplementation(async (account: string) => [{ ...point, account }]);
    const { GET } = await import("@/app/api/paper/[account]/nav/route");
    const responses = await Promise.all([call(GET), call(GET, "t2")]);
    expect(m.read).toHaveBeenCalledTimes(2);
    expect((await responses[0].json()).series[0].account).toBe("t1");
    expect((await responses[1].json()).series[0].account).toBe("t2");
  });
  it("clears failed work so the next request retries instead of caching errors", async () => {
    m.read.mockRejectedValueOnce(new Error("synthetic unavailable")).mockResolvedValueOnce([point]);
    const { GET } = await import("@/app/api/paper/[account]/nav/route");
    expect((await call(GET)).status).toBe(503);
    expect((await call(GET)).status).toBe(200);
    expect(m.read).toHaveBeenCalledTimes(2);
  });
});
