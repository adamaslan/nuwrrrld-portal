import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/shared/signal-policy", () => ({ normalizeTicker: (value: unknown) => typeof value === "string" ? value.trim().toUpperCase() : null }));
vi.mock("@/lib/public-demo", () => ({
  hashIp: vi.fn(() => "hashed-ip"),
  clientIpFromHeaders: vi.fn(() => "203.0.113.1"),
  checkAndIncrementDemoQuota: vi.fn().mockResolvedValue(true),
  releaseDemoQuota: vi.fn().mockResolvedValue(undefined),
  getCachedDemoAnswer: vi.fn().mockResolvedValue(null),
  saveDemoAnswer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/openrouter", () => ({
  callCouncilSeat: vi.fn().mockResolvedValue({ answer: "Risk view", model: "test-model" }),
}));
vi.mock("@/lib/shared/signal-lookup", () => ({
  fetchTickerEntry: vi.fn().mockResolvedValue(null),
  formatTickerBrief: vi.fn().mockReturnValue(null),
}));

import { POST } from "@/app/api/council/public/route";
import { checkAndIncrementDemoQuota, getCachedDemoAnswer, releaseDemoQuota, saveDemoAnswer } from "@/lib/public-demo";
import { callCouncilSeat } from "@/lib/openrouter";
import { fetchTickerEntry, formatTickerBrief } from "@/lib/shared/signal-lookup";

function request() {
  return new NextRequest("http://localhost/api/council/public", {
    method: "POST",
    headers: { "x-real-ip": "203.0.113.1" },
    body: JSON.stringify({ ticker: "nvda" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.stubEnv("IP_HASH_SECRET", "test-secret");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/council/public grounding", () => {
  it("refuses to call the model without live signal data and keeps the daily attempt charged", async () => {
    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "No live signal data for this ticker. Your daily demo attempt was used; please try again tomorrow.",
    });
    expect(checkAndIncrementDemoQuota).toHaveBeenCalledOnce();
    expect(releaseDemoQuota).not.toHaveBeenCalled();
    expect(callCouncilSeat).not.toHaveBeenCalled();
    expect(saveDemoAnswer).not.toHaveBeenCalled();
  });

  it("continues to serve and cache a grounded model response", async () => {
    vi.mocked(fetchTickerEntry).mockResolvedValueOnce({ symbol: "NVDA" } as never);
    vi.mocked(formatTickerBrief).mockReturnValueOnce("signal score: 0.7");

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ticker: "NVDA", answer: "Risk view", cached: false });
    expect(callCouncilSeat).toHaveBeenCalledOnce();
    expect(saveDemoAnswer).toHaveBeenCalledWith("NVDA", "RISK", "Risk view", "test-model");
    expect(releaseDemoQuota).not.toHaveBeenCalled();
  });

  it("serves cache hits without checking quota or fetching current data", async () => {
    vi.mocked(getCachedDemoAnswer).mockResolvedValueOnce({ answer: "Cached risk view", model: "cache-model" });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ answer: "Cached risk view", cached: true });
    expect(checkAndIncrementDemoQuota).not.toHaveBeenCalled();
    expect(fetchTickerEntry).not.toHaveBeenCalled();
    expect(callCouncilSeat).not.toHaveBeenCalled();
  });

  it("returns 429 without fetching data when the daily quota is exhausted", async () => {
    vi.mocked(checkAndIncrementDemoQuota).mockResolvedValueOnce(false);

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(fetchTickerEntry).not.toHaveBeenCalled();
    expect(callCouncilSeat).not.toHaveBeenCalled();
    expect(releaseDemoQuota).not.toHaveBeenCalled();
  });

  it("refunds a charged attempt when the model call fails", async () => {
    vi.mocked(fetchTickerEntry).mockResolvedValueOnce({ symbol: "NVDA" } as never);
    vi.mocked(formatTickerBrief).mockReturnValueOnce("signal score: 0.7");
    vi.mocked(callCouncilSeat).mockRejectedValueOnce(new Error("upstream unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(releaseDemoQuota).toHaveBeenCalledWith("hashed-ip");
    expect(saveDemoAnswer).not.toHaveBeenCalled();
  });
});
