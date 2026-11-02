import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ sql: vi.fn(), log: vi.fn(), latest: vi.fn(), cards: vi.fn(), universe: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: mocks.sql }));
vi.mock("@/lib/pipeline-run-log-db", () => ({ logPipelineRun: mocks.log }));
vi.mock("@/lib/ticker-cards-db", () => ({
  latestCardBarDate: mocks.latest, upsertCards: mocks.cards, upsertUniverse: mocks.universe,
  listActiveTickers: vi.fn(), coverageForDate: vi.fn().mockResolvedValue({ covered: 1, active: 1 }),
  coverageForUniverseAndDate: vi.fn().mockResolvedValue({ expected: 1, filled: 1 }),
}));
import { GET, POST } from "@/app/api/pipeline/hydrate-universe/route";
import { chunk, SYMBOLS_PER_REQUEST } from "@/scripts/lib/alpaca-live-prices.mjs";

function request(query = "", body?: unknown) {
  return new NextRequest(`https://example.test/api/pipeline/hydrate-universe${query}`, {
    method: body ? "POST" : "GET", headers: { authorization: "Bearer test-only-push-secret", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PORTAL_PUSH_SECRET", "test-only-push-secret");
  mocks.log.mockResolvedValue(true);
  mocks.sql.mockResolvedValue([]);
  mocks.cards.mockImplementation(async (cards) => cards.map((card: { ticker: string; horizon: string }) => ({ ticker: card.ticker, horizon: card.horizon, outcome: "written" })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("hydration final run protocol", () => {
  it.each([["ok", ["ok", "skip"]], ["fail", ["ok", "fail"]], ["partial", [...Array(19).fill("ok"), "fail"]]])("derives %s once from final items", async (status, outcomes) => {
    const items = outcomes.map((outcome, index) => ({ subject: `A${index}:t1`, model: null, outcome }));
    const response = await POST(request("", { source: "alpaca", barDate: "2026-10-12", runId: "run-test", complete: true, items, summary: { status: "ok" } }));
    expect(await response.json()).toMatchObject({ ok: true, status });
    expect(mocks.log).toHaveBeenCalledTimes(1);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ status, items, session: "run-test", upsertSession: true, itemsTotal: items.length }));
    expect(mocks.cards).not.toHaveBeenCalled();
  });
  it("rejects final items that used a model", async () => {
    const response = await POST(request("", { source: "alpaca", barDate: "2026-10-12", runId: "run-test", complete: true, items: [{ subject: "AAPL:t1", model: "paid", outcome: "ok" }] }));
    expect(response.status).toBe(400);
    expect(mocks.log).not.toHaveBeenCalled();
  });
  it.each([[1000, "ok"], [100, "fail"]])("grades clustered vendor misses across all %s run symbols", async (total, status) => {
    const items = [{ subject: "AAPL:t1", model: null, outcome: "ok" },
      ...Array.from({ length: 30 }, (_, index) => ({ subject: `DEAD${index}`, model: null, outcome: "skip" }))];
    const response = await POST(request("", { source: "alpaca", barDate: "2026-10-12", runId: "clustered-run", complete: true, items, summary: { unservable: 30, total } }));
    expect(await response.json()).toMatchObject({ status });
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ status, upsertSession: true }));
  });
  it("defers chunk logging and returns horizon-qualified outcomes", async () => {
    const response = await POST(request("", { source: "alpaca", barDate: "2026-10-12", runId: "run-test", deferRunLog: true, rows: [{ ticker: "AAPL", rsi: 50 }] }));
    expect(await response.json()).toMatchObject({ runItems: [{ subject: "AAPL:t1", model: null, outcome: "ok" }, { subject: "AAPL:t2", model: null, outcome: "ok" }] });
    expect(mocks.log).not.toHaveBeenCalled();
  });
});

describe("hydration metadata", () => {
  it("returns split-adjusted SIP history and bounds requests at 150 symbols", async () => {
    mocks.sql.mockResolvedValue([{ ticker: "AAPL", bar_date: "2026-10-12", open: 1, high: 2, low: 1, close: 2, volume: 10 }]);
    const response = await GET(request("?meta=bars&symbols=AAPL"));
    expect(await response.json()).toMatchObject({ feed: "sip", bars: { AAPL: [{ t: "2026-10-12T12:00:00Z", c: 2 }] } });
    const [parts, symbols, feed] = mocks.sql.mock.calls[0];
    expect(parts.join(" ")).toContain("adjustment = 'split'");
    expect(symbols).toEqual(["AAPL"]);
    expect(feed).toBe("sip");
    expect((await GET(request(`?meta=bars&symbols=${Array(150).fill("AAPL").join(",")}`))).status).toBe(200);
    mocks.sql.mockClear();
    expect((await GET(request(`?meta=bars&symbols=${Array(151).fill("AAPL").join(",")}`))).status).toBe(400);
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("uses the New York calendar date before UTC midnight rolls into Tuesday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T01:00:00Z"));
    mocks.latest.mockResolvedValue("2026-10-12");
    expect(await (await GET(request("?meta=freshness"))).json()).toMatchObject({ staleTradingDays: 0 });
  });
});

describe("live trade batching", () => {
  it("batches live trades in groups of 150 with a short tail", () => {
    expect(SYMBOLS_PER_REQUEST).toBe(150);
    expect(chunk(Array.from({ length: 301 }, (_, index) => index), SYMBOLS_PER_REQUEST).map((batch: number[]) => batch.length)).toEqual([150, 150, 1]);
  });
});
