import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn().mockResolvedValue({ userId: "test-user" }),
  currentUser: vi.fn().mockResolvedValue({ publicMetadata: {} }),
}));
vi.mock("@/lib/subscription", () => ({ hasEntitlement: vi.fn().mockReturnValue(true) }));
vi.mock("@/lib/subscription-admin", () => ({ resolveTier: vi.fn().mockReturnValue("free") }));
vi.mock("@/lib/db", () => ({ default: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/council-db", () => ({
  recentVerdicts: vi.fn().mockResolvedValue([]),
  checkAndBumpQuota: vi.fn().mockResolvedValue({ allowed: true, used: 1, limit: 5 }),
  createSession: vi.fn().mockResolvedValue(null),
  saveMessage: vi.fn(),
  saveVerdict: vi.fn(),
}));
vi.mock("@/lib/grounding/resolve", () => ({
  resolveGrounding: vi.fn().mockResolvedValue({ tier: null, rules: [] }),
}));
vi.mock("@/lib/shared/signal-lookup", () => ({
  fetchTickerEntry: vi.fn().mockResolvedValue(null),
  formatTickerBrief: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/ticker-cards-db", () => ({ getCard: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/openrouter", () => ({
  DEBATE_SEATS: ["T1", "T2", "RISK", "MACRO", "QUANT"],
  runSeat: vi.fn(),
  seatSystemPrompt: vi.fn().mockReturnValue("Seat prompt"),
  CHAIR_VERDICT_SYSTEM: "Verdict prompt",
  SMALLEST_MODEL: "test-model",
}));

import { POST } from "@/app/api/council/deliberate/route";
import * as grounding from "@/lib/council-grounding";
import { runSeat } from "@/lib/openrouter";

function request() {
  return new NextRequest("http://localhost/api/council/deliberate", {
    method: "POST",
    body: JSON.stringify({ question: "Outlook?", ticker: "zzzz" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  vi.mocked(runSeat).mockResolvedValue({
    answer: "Neutral outlook.", model: "test-model", seat: "T1", latencyMs: 1,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("POST /api/council/deliberate grounding", () => {
  it("returns 422 without any model calls when all grounding is empty", async () => {
    const res = await POST(request());
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "no_grounding", ticker: "ZZZZ", message: "No grounding data available for ZZZZ.",
    });
    expect(runSeat).not.toHaveBeenCalled();
  });

  it("records ungrounded seats in degradedSeats when another seat answers", async () => {
    vi.spyOn(grounding, "buildGroundedBrief").mockImplementation(async (_question, ticker, seat) => {
      if (seat !== "MACRO" && seat !== "CHAIR") throw new grounding.NoGroundingError(ticker!);
      return "Grounded brief";
    });
    const res = await POST(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degradedSeats).toEqual(["T1", "T2", "RISK", "QUANT"]);
    expect(body.seats.map((seat: { seat: string }) => seat.seat)).toEqual(["MACRO"]);
    expect(vi.mocked(runSeat).mock.calls.every(([seat]) => seat === "MACRO" || seat === "CHAIR")).toBe(true);
  });

  it("keeps paid-for seat answers when only the chair slice has no grounding", async () => {
    vi.spyOn(grounding, "buildGroundedBrief").mockImplementation(async (_question, ticker, seat) => {
      if (seat !== "MACRO") throw new grounding.NoGroundingError(ticker!);
      return "Grounded brief";
    });
    const res = await POST(request());
    expect(res.status).not.toBe(422);
    const chairCall = vi.mocked(runSeat).mock.calls.find(([seat]) => seat === "CHAIR");
    expect(chairCall).toBeDefined();
    const userMessage = chairCall![1].find((m: { role: string }) => m.role === "user")!.content as string;
    expect(userMessage).toContain("QUESTION: Outlook?");
    expect(userMessage).not.toMatch(/reason from general knowledge/i);
  });

  it("does not report no_grounding when a grounded seat failed for another reason", async () => {
    vi.spyOn(grounding, "buildGroundedBrief").mockImplementation(async (_question, ticker, seat) => {
      if (seat !== "MACRO") throw new grounding.NoGroundingError(ticker!);
      return "Grounded brief";
    });
    vi.mocked(runSeat).mockRejectedValue(new Error("upstream down"));
    const res = await POST(request());
    // Same outcome as any all-seats-failed run: the pre-existing synthesis 503.
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Council synthesis unavailable" });
  });

  it("preserves propagation of other chair grounding errors", async () => {
    const error = new Error("Unexpected failure");
    vi.spyOn(grounding, "buildGroundedBrief").mockImplementation(async (_question, _ticker, seat) => {
      if (seat === "CHAIR") throw error;
      return "Grounded brief";
    });
    await expect(POST(request())).rejects.toBe(error);
  });
});
