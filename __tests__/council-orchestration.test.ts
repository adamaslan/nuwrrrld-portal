// Validation harness for Adam's question: does the deliberate API actually
// call all the judges plus the Chair? Fully mocked - no network, no models.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn().mockResolvedValue({ userId: "test-user" }),
  currentUser: vi.fn().mockResolvedValue({ publicMetadata: {} }),
}));
vi.mock("@/lib/subscription", () => ({ hasEntitlement: vi.fn().mockReturnValue(true) }));
vi.mock("@/lib/subscription-admin", () => ({ resolveTier: vi.fn().mockReturnValue("free") }));
vi.mock("@/lib/council-grounding", () => {
  class NoGroundingError extends Error { ticker: string | null;
    constructor(t: string | null) { super("no grounding"); this.ticker = t; } }
  return {
    NoGroundingError,
    buildGroundedBrief: vi.fn().mockResolvedValue(
      'QUESTION: q DATA: price 100 stop 95 target 110 [C1] trend up RULES: [C1] "trend up"'),
  };
});
vi.mock("@/lib/council-db", () => ({
  checkAndBumpQuota: vi.fn().mockResolvedValue({ allowed: true, used: 1, limit: 5, bumped: true }),
  refundQuota: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn().mockResolvedValue("session-1"),
  saveMessage: vi.fn(),
  saveVerdict: vi.fn(),
}));
vi.mock("@/lib/openrouter", () => ({
  DEBATE_SEATS: ["T1", "T2", "RISK", "MACRO", "QUANT"],
  runSeat: vi.fn(),
  seatSystemPrompt: vi.fn().mockReturnValue("Seat prompt"),
  CHAIR_VERDICT_SYSTEM: "Verdict prompt",
  SMALLEST_MODEL: "smallest-model",
}));

import { POST } from "@/app/api/council/deliberate/route";
import { runSeat } from "@/lib/openrouter";
import { buildGroundedBrief } from "@/lib/council-grounding";
import { createSession, refundQuota, saveMessage, saveVerdict } from "@/lib/council-db";

const STRUCTURED = (o: string) =>
  `OUTLOOK: ${o}\nBECAUSE: [C1] says "trend up"\nINVALIDATION: below 100\nEXECUTION: entry 100 / stop 95 / target 110`;
const VERDICT_JSON = JSON.stringify({ direction: "bullish", confidence: "medium", horizon: "1-5d", invalidation: "below 100" });

function req() {
  return new NextRequest("http://localhost/api/council/deliberate", {
    method: "POST", body: JSON.stringify({ question: "Outlook?", ticker: "AAPL" }),
  });
}
const callsFor = (seat: string) =>
  vi.mocked(runSeat).mock.calls.filter((c) => c[0] === seat);

function mockSeats(proseDir: Record<string, string>) {
  vi.mocked(runSeat).mockImplementation(async (seat: any, messages: any[]) => {
    const sys = messages[0]?.content;
    if (sys === "Verdict prompt") return { answer: VERDICT_JSON, model: "smallest-model", seat, latencyMs: 1 };
    if (seat === "CHAIR") return { answer: "Chair synthesis.", model: "chair-model", seat, latencyMs: 1 };
    if (seat === "T1" || seat === "T2") return { answer: STRUCTURED("bullish"), model: "m", seat, latencyMs: 1 };
    return { answer: proseDir[seat] ?? "Momentum looks bullish.", model: "m", seat, latencyMs: 1 };
  });
}

beforeEach(() => { vi.clearAllMocks(); vi.mocked(buildGroundedBrief).mockResolvedValue('QUESTION: q DATA: price 100 stop 95 target 110 [C1] trend up RULES: [C1] "trend up"'); vi.stubEnv("OPENROUTER_API_KEY", "k"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("deliberate orchestration (mocked)", () => {
  it("calls all five judges in round 1, skips round 2 on unanimity, chair synthesizes, verdict 3x on smallest model, persists", async () => {
    mockSeats({});
    const res = await POST(req());
    expect(res.status).toBe(200);
    for (const s of ["T1", "T2", "RISK", "MACRO", "QUANT"]) expect(callsFor(s).length).toBe(1);
    // CHAIR: 1 synthesis + 3 verdict samples, verdict on smallest model
    expect(callsFor("CHAIR").length).toBe(4);
    const verdictCalls = callsFor("CHAIR").filter((c) => (c[1] as any[])[0].content === "Verdict prompt");
    expect(verdictCalls.length).toBe(3);
    for (const c of verdictCalls) expect(c[5]).toBe("smallest-model");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveMessage).mock.calls.length).toBe(6); // 5 round-1 + chair synthesis
    expect(saveVerdict).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.seats.length).toBe(5);
    expect(body.degradedSeats).toEqual([]);
    expect(body.verdict).toEqual({ direction: "bullish", confidence: "medium", horizon: "1-5d", invalidation: "below 100" });
  });

  it("round 2 goes only to the disagreeing judge", async () => {
    mockSeats({ QUANT: "This setup is bearish, clearly bearish." });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(callsFor("QUANT").length).toBe(2); // round 1 + critique
    expect(callsFor("RISK").length).toBe(1);
    expect(callsFor("MACRO").length).toBe(1);
    const body = await res.json();
    const quant = body.seats.find((s: any) => s.seat === "QUANT");
    expect(quant.critique).toBeTruthy();
    const t1 = body.seats.find((s: any) => s.seat === "T1");
    expect(t1.critique).toBeNull();
  });

  it("one judge failing degrades the run instead of killing it", async () => {
    mockSeats({});
    vi.mocked(runSeat).mockImplementation(async (seat: any, messages: any[]) => {
      if (seat === "MACRO") throw new Error("model down");
      const sys = messages[0]?.content;
      if (sys === "Verdict prompt") return { answer: VERDICT_JSON, model: "smallest-model", seat, latencyMs: 1 };
      if (seat === "CHAIR") return { answer: "Chair synthesis.", model: "chair-model", seat, latencyMs: 1 };
      if (seat === "T1" || seat === "T2") return { answer: STRUCTURED("bullish"), model: "m", seat, latencyMs: 1 };
      return { answer: "Momentum looks bullish.", model: "m", seat, latencyMs: 1 };
    });
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.degradedSeats).toEqual(["MACRO"]);
    expect(body.seats.length).toBe(4);
    expect(body.verdict.direction).toBe("bullish");
    expect(saveVerdict).toHaveBeenCalledTimes(1);
  });

  it("zero grounding anywhere: 422, no judge called, quota refunded", async () => {
    const { NoGroundingError } = await import("@/lib/council-grounding");
    vi.mocked(buildGroundedBrief).mockRejectedValue(new NoGroundingError("AAPL"));
    const res = await POST(req());
    expect(res.status).toBe(422);
    expect(vi.mocked(runSeat).mock.calls.length).toBe(0);
    expect(refundQuota).toHaveBeenCalledWith("test-user");
    expect(createSession).not.toHaveBeenCalled();
  });
});
