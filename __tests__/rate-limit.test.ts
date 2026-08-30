import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit, __resetRateLimitState } from "@/lib/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => __resetRateLimitState());

  it("allows up to the limit, then rejects", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = rateLimit("k", 3, 60_000, t0 + i);
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    const over = rateLimit("k", 3, 60_000, t0 + 3);
    expect(over.ok).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("a rejected request does not consume a future slot", () => {
    const t0 = 2_000_000;
    rateLimit("k", 1, 60_000, t0);
    expect(rateLimit("k", 1, 60_000, t0 + 1).ok).toBe(false);
    expect(rateLimit("k", 1, 60_000, t0 + 2).ok).toBe(false);
    // window passes; the single original hit expires
    expect(rateLimit("k", 1, 60_000, t0 + 60_001).ok).toBe(true);
  });

  it("slides: old hits outside the window free up slots", () => {
    const t0 = 3_000_000;
    rateLimit("k", 2, 10_000, t0);
    rateLimit("k", 2, 10_000, t0 + 5_000);
    expect(rateLimit("k", 2, 10_000, t0 + 9_000).ok).toBe(false);
    // t0 hit is now >10s old
    expect(rateLimit("k", 2, 10_000, t0 + 10_001).ok).toBe(true);
  });

  it("keys are independent", () => {
    const t0 = 4_000_000;
    expect(rateLimit("a", 1, 60_000, t0).ok).toBe(true);
    expect(rateLimit("b", 1, 60_000, t0).ok).toBe(true);
    expect(rateLimit("a", 1, 60_000, t0 + 1).ok).toBe(false);
  });

  it("reports resetAt as the oldest in-window hit + window", () => {
    const t0 = 5_000_000;
    const r = rateLimit("k", 5, 60_000, t0);
    expect(r.resetAt).toBe(t0 + 60_000);
  });
});
