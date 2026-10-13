import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  seed: vi.fn(), fetch: vi.fn(), save: vi.fn(), claim: vi.fn(), done: vi.fn(),
  failure: vi.fn(), count: vi.fn(), purge: vi.fn(),
}));
vi.mock("@/lib/shared/signal-lookup", async () => {
  const policy = await import("@/lib/shared/signal-policy");
  return { normalizeTicker: policy.normalizeTicker, enqueueUncachedActiveSignals: mocks.seed,
    fetchTickerEntry: mocks.fetch, saveTickerEntry: mocks.save };
});
vi.mock("@/lib/signal-queue", async () => {
  const policy = await import("@/lib/shared/signal-policy");
  return { claimPendingSignals: mocks.claim, markSignalDone: mocks.done,
    recordSignalFailure: mocks.failure, countPendingSignals: mocks.count,
    purgePendingSignals: mocks.purge, getQueueStats: vi.fn(), shouldRetry: policy.shouldRetry };
});
import { POST } from "@/app/api/signals/drain/route";

const request = () => new NextRequest("https://example.test/api/signals/drain", {
  method: "POST", headers: { authorization: "Bearer test-secret" },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("PORTAL_PUSH_SECRET", "test-secret");
  mocks.seed.mockResolvedValue(8);
  mocks.claim.mockResolvedValue([{ id: 1, ticker: "AAPL", attempts: 0 }]);
  mocks.fetch.mockResolvedValue({ ai_action: "HOLD" });
  mocks.count.mockResolvedValue(7);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("drain cold-cache warming", () => {
  it("seeds before the bounded claim and does not re-date returned cache entries", async () => {
    const result = await POST(request());
    expect(await result.json()).toMatchObject({ enqueued: 8, claimed: 1, done: 1 });
    expect(mocks.seed.mock.invocationCallOrder[0]).toBeLessThan(mocks.claim.mock.invocationCallOrder[0]);
    expect(mocks.claim).toHaveBeenCalledWith(8);
    expect(mocks.done).toHaveBeenCalledWith(1);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("retains failure retry accounting for seeded work", async () => {
    mocks.fetch.mockResolvedValue(null);
    expect(await (await POST(request())).json()).toMatchObject({ done: 0, retried: 1, failed: 0 });
    expect(mocks.failure).toHaveBeenCalledWith(1, 0, "no entry returned from backend");
    expect(mocks.done).not.toHaveBeenCalled();
  });

  it("stops further upstream requests when the existing time budget expires", async () => {
    mocks.claim.mockResolvedValue(Array.from({ length: 8 }, (_, id) => ({ id, ticker: "AAPL", attempts: 0 })));
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    mocks.fetch.mockImplementation(async () => { now += 26_000; return { ai_action: "HOLD" }; });
    expect(await (await POST(request())).json()).toMatchObject({ claimed: 8, done: 1 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });
});
