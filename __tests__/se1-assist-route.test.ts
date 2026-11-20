import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { SEED_CARDS } from "@/lib/shared/se1-catalog";

vi.mock("@/lib/flags", () => ({ flagLive: vi.fn() }));
vi.mock("@/lib/openrouter", () => ({ callCouncilSeat: vi.fn() }));
vi.mock("@/lib/public-demo", () => ({
  hashIp: vi.fn(() => "hash"),
  clientIpFromHeaders: vi.fn(() => "203.0.113.7"),
  checkAndIncrementDemoQuota: vi.fn(),
  releaseDemoQuota: vi.fn(),
}));

import { flagLive } from "@/lib/flags";
import { callCouncilSeat } from "@/lib/openrouter";
import { checkAndIncrementDemoQuota, releaseDemoQuota } from "@/lib/public-demo";
import { POST } from "@/app/api/scans/assist/route";

const card = SEED_CARDS[0];
const req = (body: unknown) =>
  new Request("http://localhost/api/scans/assist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENROUTER_API_KEY = "test-key";
  process.env.IP_HASH_SECRET = "test-secret";
  vi.mocked(flagLive).mockReturnValue(true);
  vi.mocked(checkAndIncrementDemoQuota).mockResolvedValue(true);
});

describe("POST /api/scans/assist (X26-04)", () => {
  it("is a 404 while the scan_ai_assist flag is off", async () => {
    vi.mocked(flagLive).mockReturnValue(false);
    const res = await POST(req({ card: card.id }));
    expect(res.status).toBe(404);
    expect(callCouncilSeat).not.toHaveBeenCalled();
  });

  it("rejects an unknown card id before any model call", async () => {
    const res = await POST(req({ card: "se1.not.a.card" }));
    expect(res.status).toBe(400);
    expect(callCouncilSeat).not.toHaveBeenCalled();
  });

  it("returns the deterministic text and makes no model call when quota is spent", async () => {
    vi.mocked(checkAndIncrementDemoQuota).mockResolvedValue(false);
    const res = await POST(req({ card: card.id }));
    const json = await res.json();
    expect(json).toMatchObject({ source: "deterministic", reason: "quota", state: "absent_run" });
    expect(callCouncilSeat).not.toHaveBeenCalled();
  });

  it("shows a grounded model answer and names the model that produced it", async () => {
    vi.mocked(callCouncilSeat).mockResolvedValue({
      answer: `${card.title} has no run yet. It is a ${card.evidence_level} spec.`,
      model: "any-free-model:free",
    } as never);
    const res = await POST(req({ card: card.id }));
    expect(await res.json()).toMatchObject({ source: "model", model: "any-free-model:free", state: "absent_run" });
  });

  it("falls back to the deterministic text when the model answer invents a number", async () => {
    vi.mocked(callCouncilSeat).mockResolvedValue({ answer: "It needs 987654 bars.", model: "m:free" } as never);
    const res = await POST(req({ card: card.id }));
    expect(await res.json()).toMatchObject({ source: "deterministic", reason: "number not in facts: 987654" });
    // The call happened, so the quota slot is not released.
    expect(releaseDemoQuota).not.toHaveBeenCalled();
  });

  it("returns 503 with the deterministic text and releases the quota slot when the model call fails", async () => {
    vi.mocked(callCouncilSeat).mockRejectedValue(new Error("upstream down"));
    const res = await POST(req({ card: card.id }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ source: "deterministic", reason: "model_unavailable" });
    expect(releaseDemoQuota).toHaveBeenCalledWith("hash");
  });
});
