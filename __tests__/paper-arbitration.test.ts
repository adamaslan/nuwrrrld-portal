import { describe, expect, it, vi } from "vitest";
import { arbitrateOne, parseArbitrationResponse, tryParseArbitrationResponse } from "@/lib/paper-arbitration";
import { runSeat } from "@/lib/openrouter";

vi.mock("@/lib/openrouter", () => ({ runSeat: vi.fn(), seatSystemPrompt: () => "sys" }));

describe("parseArbitrationResponse", () => {
  it("parses a valid confirm", () => {
    expect(parseArbitrationResponse('{"action":"confirm"}')).toEqual({ action: "confirm" });
  });

  it("parses a valid veto", () => {
    expect(parseArbitrationResponse('{"action":"veto"}')).toEqual({ action: "veto" });
  });

  it("parses a valid downsize", () => {
    expect(parseArbitrationResponse('{"action":"downsize","downsize_pct":0.5}')).toEqual({
      action: "downsize",
      downsizePct: 0.5,
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseArbitrationResponse('  {"action":"veto"}  \n')).toEqual({ action: "veto" });
  });

  it.each([
    ["not json at all", "sure, I'll veto that one"],
    ["a downsize_pct of 0", '{"action":"downsize","downsize_pct":0}'],
    ["a downsize_pct of 1", '{"action":"downsize","downsize_pct":1}'],
    ["a downsize_pct that isn't a number", '{"action":"downsize","downsize_pct":"a lot"}'],
    ["an unrecognized action", '{"action":"invent_a_ticker"}'],
    ["an empty string", ""],
    ["valid JSON that isn't an object", "42"],
  ])("degrades to CONFIRM-none for %s", (_label, raw) => {
    expect(parseArbitrationResponse(raw)).toEqual({ action: "confirm" });
  });
});

describe("parseArbitrationResponse — why (docs/paper-trading-v3.md §4.2/F8)", () => {
  it("extracts why alongside the action", () => {
    const raw = '{"action":"veto","why":"correlated with two names already held"}';
    expect(parseArbitrationResponse(raw)).toEqual({
      action: "veto",
      why: "correlated with two names already held",
    });
  });

  it("extracts why on a downsize too", () => {
    const raw = '{"action":"downsize","downsize_pct":0.5,"why":"toss-up, size cut for safety"}';
    expect(parseArbitrationResponse(raw)).toEqual({
      action: "downsize",
      downsizePct: 0.5,
      why: "toss-up, size cut for safety",
    });
  });

  it("omits why when absent, rather than inventing a placeholder", () => {
    const result = parseArbitrationResponse('{"action":"confirm"}');
    expect(result.why).toBeUndefined();
  });

  it("truncates a why that ignores the length instruction rather than trusting it", () => {
    const longWhy = "x".repeat(500);
    const result = parseArbitrationResponse(`{"action":"confirm","why":"${longWhy}"}`);
    expect(result.why?.length).toBeLessThanOrEqual(240);
  });

  it("ignores a non-string why", () => {
    const result = parseArbitrationResponse('{"action":"confirm","why":12345}');
    expect(result.why).toBeUndefined();
  });
});

describe("parseArbitrationResponse — tolerant extraction (2026-10-13)", () => {
  it("takes trailing JSON after leaked reasoning prose", () => {
    const raw = 'The user wants me to judge this. Thinking... {"action":"veto","why":"toss-up"}';
    expect(parseArbitrationResponse(raw)).toEqual({ action: "veto", why: "toss-up" });
  });

  it("strips ```json fences", () => {
    expect(parseArbitrationResponse('```json\n{"action":"downsize","downsize_pct":0.4}\n```')).toEqual({
      action: "downsize",
      downsizePct: 0.4,
    });
  });

  it("uses the last object when several are present", () => {
    const raw = '{"action":"veto"} on reflection {"action":"confirm","why":"fine"}';
    expect(parseArbitrationResponse(raw)).toEqual({ action: "confirm", why: "fine" });
  });

  it("degrades to confirm and reports unparsed for truncated prose", () => {
    const raw = "The user wants me to decide whether to";
    expect(parseArbitrationResponse(raw)).toEqual({ action: "confirm" });
    expect(tryParseArbitrationResponse(raw)).toBeNull();
  });
});

describe("arbitrateOne", () => {
  const candidate = {
    order: { ticker: "AAPL", side: "buy", quantity: 10, refPrice: 100, reason: "score_buy" },
    flagReason: "score_tie",
  } as never;

  it("passes the 1200-token budget and flags parsed=true on a real answer", async () => {
    vi.mocked(runSeat).mockResolvedValueOnce({ answer: '{"action":"veto","why":"x"}', model: "m", seat: "RISK", latencyMs: 1 });
    const result = await arbitrateOne("RISK", candidate, 1000, "k");
    expect(vi.mocked(runSeat).mock.calls.at(-1)?.[3]).toBe(1200);
    expect(result).toMatchObject({ action: "veto", parsed: true, model: "m" });
  });

  it("flags parsed=false when the output is unusable", async () => {
    vi.mocked(runSeat).mockResolvedValueOnce({ answer: "The user wants", model: "m", seat: "RISK", latencyMs: 1 });
    const result = await arbitrateOne("RISK", candidate, 1000, "k");
    expect(result).toMatchObject({ action: "confirm", parsed: false });
  });
});

describe("tryParseArbitrationResponse extraction", () => {
  it("finds the JSON after a stray unbalanced brace in prose", () => {
    expect(tryParseArbitrationResponse('Consider set {a, b. Final: {"action":"veto","why":"x"}')).toEqual({
      action: "veto",
      why: "x",
    });
  });

  it("parses fenced JSON with nested objects", () => {
    const raw = 'Thinking...\n```json\n{"action":"confirm","meta":{"k":1},"why":"ok"}\n```';
    expect(tryParseArbitrationResponse(raw)).toEqual({ action: "confirm", why: "ok" });
  });

  it("returns null when no object has a valid action", () => {
    expect(tryParseArbitrationResponse('I think {"action":"maybe"} and {"foo":1}')).toBeNull();
  });

  it("KNOWN LIMITATION: a veto cut off mid-object falls back to the earlier valid confirm", () => {
    const raw = '{"action":"confirm"} then on reflection {"action":"veto","why":"cut of';
    expect(tryParseArbitrationResponse(raw)).toEqual({ action: "confirm" });
  });
});
