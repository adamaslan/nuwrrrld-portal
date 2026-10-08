import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestPayload } from "@/lib/digest";

const getLatestDigest = vi.fn();
const getLatestDigestAnyAge = vi.fn();

vi.mock("@/lib/digest-cache-db", () => ({
  getLatestDigest: (...a: unknown[]) => getLatestDigest(...a),
  getLatestDigestAnyAge: (...a: unknown[]) => getLatestDigestAnyAge(...a),
  getUserDigest: vi.fn().mockResolvedValue(null),
  saveDigest: vi.fn(),
  saveUserDigest: vi.fn(),
}));

function digest(label: string): DigestPayload {
  return {
    schemaVersion: 1,
    periodLabel: label,
    signals: [],
    generatedAt: "2026-10-07T23:27:13.959Z",
    sources: ["alpaca-sip-local"],
  };
}

describe("getOrFetchDigest — durable stale fallback", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    getLatestDigest.mockResolvedValue(null); // past the 15 min TTL
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("backend down")));
    const { globalDigestCache } = await import("@/lib/digest-cache");
    globalDigestCache.digest = null; // simulate a cold serverless instance
    globalDigestCache.pushedAt = 0;
  });

  it("serves the newest Neon row, marked degraded, when the live backend is down on a cold start", async () => {
    getLatestDigestAnyAge.mockResolvedValue(digest("Signals for 2026-10-07 (Alpaca SIP)"));
    const { getOrFetchDigest } = await import("@/lib/digest-cache");
    const result = await getOrFetchDigest(null);
    expect(result?.periodLabel).toBe("Signals for 2026-10-07 (Alpaca SIP)");
    expect(result?.degraded).toBe(true);
  });

  it("returns null only when there is no durable row either", async () => {
    getLatestDigestAnyAge.mockResolvedValue(null);
    const { getOrFetchDigest } = await import("@/lib/digest-cache");
    expect(await getOrFetchDigest(null)).toBeNull();
  });
});
