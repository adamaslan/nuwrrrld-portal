import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const m = vi.hoisted(() => ({ picks: vi.fn(), observed: vi.fn(), resolved: vi.fn(), observations: vi.fn(), upsert: vi.fn(), price: vi.fn(), council: vi.fn(), horizons: vi.fn(), ticker: vi.fn(), backtest: vi.fn(), log: vi.fn(), close: vi.fn(), enrich: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => { throw new Error("No live DB permitted"); } }));
vi.mock("@/lib/followed-tickers-db", () => ({ getLivePicks: m.picks, getPickIdsObservedOn: m.observed, getResolvedHorizons: m.resolved, getObservations: m.observations, upsertObservationEnrichment: m.enrich, insertObservationClose: m.close }));
vi.mock("@/lib/followed-tickers-price", () => ({ resolveFollowedPrice: m.price, nyDateOf: () => "2026-11-13" }));
vi.mock("@/lib/followed-tickers-run", () => ({ councilVerdictFor: m.council, resolveDueHorizons: m.horizons }));
vi.mock("@/lib/shared/signal-lookup", () => ({ fetchTickerEntry: m.ticker }));
vi.mock("@/lib/backtest", () => ({ fetchBacktest: m.backtest }));
vi.mock("@/lib/pipeline-run-log-db", () => ({ logPipelineRun: m.log }));
const { POST } = await import("@/app/api/pipeline/followed-tickers/route");
const now = new Date("2026-11-13T22:00:00Z");
const picks = Array.from({ length: 40 }, (_, i) => ({ id: `pick-${i}`, ticker: `TEST${i}`, direction: "bull", signalCategory: null }));
const request = (dryRun = false) => new NextRequest("https://example.test/api/pipeline/followed-tickers", { method: "POST", headers: { authorization: "Bearer test-only", "content-type": "application/json" }, body: JSON.stringify({ dry_run: dryRun }) });
describe("mandatory observation phase before optional enrichment", () => {
  const events: string[] = [];
  beforeEach(() => {
    vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); events.length = 0;
    process.env.CRON_SECRET = "test-only"; process.env.OPENROUTER_API_KEY = "injected-test-only";
    m.picks.mockResolvedValue(picks); m.observed.mockResolvedValue(new Set()); m.resolved.mockResolvedValue(new Set());
    m.observations.mockResolvedValue([]); m.horizons.mockResolvedValue([]); m.log.mockResolvedValue(true);
    m.price.mockImplementation(async () => ({ price: 100, source: "daily_bars", asOf: "2026-11-13" }));
    m.close.mockImplementation(async (row) => { events.push(`write:${row.pickId}`); });
    m.enrich.mockResolvedValue(undefined);
    m.ticker.mockImplementation(async () => { events.push("optional"); return null; });
    m.backtest.mockResolvedValue(null);
    m.council.mockImplementation(async () => { events.push("council"); return { ok: false, empty: true, model: "injected" }; });
  });
  afterEach(() => vi.useRealTimers());
  it("records all40 closes before first optional call even when council consumes the remaining budget", async () => {
    m.council.mockImplementation(async () => { events.push("council"); vi.setSystemTime(new Date(now.getTime() + 271_000)); return { ok: false, empty: true, model: "injected" }; });
    const res = await POST(request()); const body = await res.json();
    expect(events.slice(0, 40).every(e => e.startsWith("write:"))).toBe(true);
    expect(m.price).toHaveBeenCalledTimes(40); expect(body.readings).toHaveLength(40);
    expect(body.meta.observationDeferred).toBe(0); expect(body.meta.observationFailed).toBe(0);
    expect(body.meta.mandatoryComplete).toBe(true); expect(body.meta.deferred).toBeGreaterThan(0); expect(body.meta.status).toBe("partial");
    expect(m.horizons).toHaveBeenCalledTimes(40);
  });
  it("reports a failed mandatory write without abandoning the other39 picks or claiming full coverage", async () => {
    m.close.mockImplementation(async row => { if (row.pickId === "pick-0") throw new Error("fixture write failed"); events.push(`write:${row.pickId}`); });
    const body = await (await POST(request())).json();
    expect(m.price).toHaveBeenCalledTimes(40); expect(body.meta.observationFailed).toBe(1);
    expect(body.readings).toHaveLength(39); expect(body.meta.status).toBe("partial");
  });
  it("does no duplicate observation or council work for already-observed picks", async () => {
    m.observed.mockResolvedValue(new Set(picks.map(p => p.id)));
    const body = await (await POST(request())).json();
    expect(m.price).not.toHaveBeenCalled(); expect(m.council).not.toHaveBeenCalled();
    expect(body.meta.alreadyObserved).toBe(40); expect(body.meta.status).toBe("ok");
  });
  it("dry-run computes observations but never writes prices, verdicts or horizon scores", async () => {
    const body = await (await POST(request(true))).json();
    expect(body.dryRun).toBe(true); expect(m.price).toHaveBeenCalledTimes(40);
    expect(m.enrich).not.toHaveBeenCalled(); expect(m.close).not.toHaveBeenCalled(); expect(m.horizons).not.toHaveBeenCalled();
  });
  it("enrichment failure preserves all saved closes and remaining optional work continues", async () => {
    m.ticker.mockRejectedValueOnce(new Error("optional unavailable"));
    const body = await (await POST(request())).json();
    expect(m.price).toHaveBeenCalledTimes(40); expect(body.readings).toHaveLength(40);
    expect(body.meta.enrichmentFailed).toBe(1); expect(body.meta.status).toBe("partial");
    expect(m.ticker).toHaveBeenCalledTimes(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries deterministic horizons for an already-observed pick without overwriting context or model calls", async () => {
    m.observed.mockResolvedValue(new Set(picks.map(p => p.id)));
    m.horizons.mockResolvedValueOnce(["d1"]);
    const body = await (await POST(request())).json();
    expect(m.observations).toHaveBeenCalledTimes(40); expect(m.horizons).toHaveBeenCalledTimes(40);
    expect(body.meta.horizonsRetried).toBe(40); expect(body.meta.horizonsResolved).toBe(1);
    expect(m.price).not.toHaveBeenCalled(); expect(m.enrich).not.toHaveBeenCalled(); expect(m.close).not.toHaveBeenCalled(); expect(m.council).not.toHaveBeenCalled();
  });
  it("same-day horizon retry failure is partial and cannot trigger a false recovery", async () => {
    m.observed.mockResolvedValue(new Set(picks.map(p => p.id)));
    m.horizons.mockRejectedValueOnce(new Error("fixture horizon failure"));
    const body = await (await POST(request())).json();
    expect(body.meta.mandatoryComplete).toBe(false); expect(body.meta.horizonRetryFailed).toBe(1); expect(body.meta.status).toBe("partial");
    expect(m.log.mock.calls[0][0].status).toBe("partial");
    expect(m.council).not.toHaveBeenCalled();
  });

  it("a failed dedup read fails the run loudly instead of re-observing over same-day context", async () => {
    m.observed.mockRejectedValueOnce(new Error("fixture dedup read failed"));
    await expect(POST(request())).rejects.toThrow("fixture dedup read failed");
    expect(m.price).not.toHaveBeenCalled(); expect(m.close).not.toHaveBeenCalled();
  });
  it("a failed observation read counts as failed horizon retry, not as silent no-work success", async () => {
    m.observed.mockResolvedValue(new Set(picks.map(p => p.id)));
    m.observations.mockRejectedValueOnce(new Error("fixture read failed"));
    const body = await (await POST(request())).json();
    expect(body.meta.horizonRetryFailed).toBe(1); expect(body.meta.mandatoryComplete).toBe(false);
    expect(body.meta.status).toBe("partial"); expect(body.meta.horizonsRetried).toBe(39);
  });
  it("a horizon failure keeps the saved close in the response while staying mandatory-incomplete", async () => {
    m.horizons.mockRejectedValueOnce(new Error("fixture horizon failure"));
    const body = await (await POST(request())).json();
    expect(body.meta.observationFailed).toBe(1); expect(body.meta.mandatoryComplete).toBe(false);
    expect(body.readings).toHaveLength(40); expect(m.close).toHaveBeenCalledTimes(40);
  });
  it("dry-run with already-observed picks cannot retry horizons or write score rows", async () => {
    m.observed.mockResolvedValue(new Set(picks.map(p => p.id)));
    const body = await (await POST(request(true))).json();
    expect(body.dryRun).toBe(true); expect(m.horizons).not.toHaveBeenCalled();
    expect(m.enrich).not.toHaveBeenCalled(); expect(m.close).not.toHaveBeenCalled(); expect(m.observations).not.toHaveBeenCalled();
    expect(m.council).not.toHaveBeenCalled(); expect(body.meta.horizonsRetried).toBe(0);
  });
  it("a quiet priced pick still saves its signal and backtest without a council verdict", async () => {
    m.ticker.mockResolvedValue({ ai_action: "Strong Buy" });
    m.backtest.mockResolvedValue({ by_category: [{ key: "momentum", hit_rate: 0.61 }] });
    const body = await (await POST(request())).json();
    expect(body.meta.mandatoryComplete).toBe(true); expect(body.meta.enriched).toBe(40);
    expect(m.enrich).toHaveBeenCalledTimes(40);
    for (const call of m.enrich.mock.calls) {
      expect(call[0].signalDir).toBe("bull"); expect(call[0].backtestRate).toBe(0.61);
      expect(call[0].councilJson).toBeNull(); // preserving upsert keeps any existing verdict
      expect(call[0].closePrice).toBe(100);
    }
  });
  it("a failed enrichment keeps every saved close durable", async () => {
    m.ticker.mockRejectedValueOnce(new Error("fixture enrichment failure"));
    const body = await (await POST(request())).json();
    expect(body.meta.enrichmentFailed).toBe(1); expect(body.meta.mandatoryComplete).toBe(true);
    expect(m.close).toHaveBeenCalledTimes(40); expect(m.enrich).toHaveBeenCalledTimes(39);
    expect(body.readings).toHaveLength(40);
  });

});
