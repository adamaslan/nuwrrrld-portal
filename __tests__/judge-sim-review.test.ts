import { describe, it, expect } from "vitest";
import { simulateJudge } from "@/lib/judge-sim";
const brief = 'DATA\nEntry 100; stop 90; target 110.\n\nRULES\n[C1] test: "RSI is 72.0"';
const verdict = { outlook: "bullish", because: '[C1] says "RSI is 72.0"', invalidation: "below $90", execution: "entry 100 / stop 90 / target 110" };
describe("explicit declared direction", () => {
  it.each(["my outlook is bearish", "our thesis remains bear", "the view is bearish"])("rejects opposite %s", (because) => {
    expect(simulateJudge({ ...verdict, because }, brief).scores.consistency).toBe(0);
  });
  it.each(["my outlook is bullish", "our thesis remains bull", "the view is bullish"])("keeps aligned %s", (because) => {
    expect(simulateJudge({ ...verdict, because }, brief).scores.consistency).toBe(2);
  });
  it.each(['[C1] says "my outlook is bearish"', "my outlook is not bearish", "not the view is bearish", "never my outlook is bearish"])("does not assert quoted or negated %s", (because) => {
    expect(simulateJudge({ ...verdict, because }, brief).scores.consistency).toBe(2);
  });
  it("keeps mixed explicit stances partial", () => {
    expect(simulateJudge({ ...verdict, because: "my outlook is bearish; bullish case exists" }, brief).scores.consistency).toBe(1);
  });
  it("checks bearish outlook symmetrically", () => {
    expect(simulateJudge({ ...verdict, outlook: "bearish", execution: "entry 100 / stop 110 / target 90", because: "my outlook is bullish" }, brief).scores.consistency).toBe(0);
  });
});

describe("price delimiters and indefinite negation", () => {
  it("accepts punctuation comma after a grounded invalidation level", () => {
    expect(simulateJudge({ ...verdict, invalidation: "below $90, exit" }, brief).scores.falsifiability).toBe(2);
  });
  it("accepts punctuation comma after a grounded execution target", () => {
    expect(simulateJudge({ ...verdict, execution: "entry 100 / stop 90 / target 110, take profit" }, brief).scores.consistency).toBe(2);
  });
  it.each(["not a bearish case", "never a bearish outlook", "not an bearish outlook"])("does not assert %s", (because) => {
    expect(simulateJudge({ ...verdict, because }, brief).scores.consistency).toBe(2);
  });
  it.each(["110,23", "110,0000", "110%", "110x"])("still rejects malformed execution target %s", (target) => {
    expect(simulateJudge({ ...verdict, execution: `entry 100 / stop 90 / target ${target}` }, brief).scores.consistency).not.toBe(2);
  });
});
