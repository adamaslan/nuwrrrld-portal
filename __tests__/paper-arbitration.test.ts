import { describe, expect, it } from "vitest";
import { parseArbitrationResponse } from "@/lib/paper-arbitration";

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
