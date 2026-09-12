import { describe, it, expect } from "vitest";
import { buildGroundingBlock, type UpstreamSignal } from "@/lib/signal-chat-local";

/**
 * The grounding block is the whole defence against a confident answer with no
 * basis. gcp3 currently serves rule-based fallback signals for most tickers
 * (`ai_degraded: true`, `prompt_version: "fallback_v1"`), and a model handed
 * "buy @ 55%" with no further qualification will narrate that as a considered
 * AI read. These tests pin the parts of the rendering the prompt depends on.
 */
describe("buildGroundingBlock", () => {
  const base: UpstreamSignal = {
    ticker: "AAPL",
    signals: {
      "1D": {
        direction: "buy",
        confidence: 0.55,
        ai_degraded: true,
        evidence: { items: [{ summary: "Rule-based fallback: change_pct=3.27%" }] },
      },
    },
  };

  it("names a degraded timeframe as a rule-based fallback, not an AI read", () => {
    const out = buildGroundingBlock(base);
    expect(out).toContain("rule-based fallback, not an AI read");
  });

  it("does not claim a fallback when the signal is a real AI read", () => {
    const out = buildGroundingBlock({
      signals: { "1D": { direction: "buy", confidence: 0.8, ai_degraded: false } },
    });
    expect(out).not.toContain("rule-based fallback");
    expect(out).toContain("1D: buy @ 80%");
  });

  it("renders confidence as a percentage and tolerates a missing one", () => {
    expect(buildGroundingBlock(base)).toContain("@ 55%");
    expect(buildGroundingBlock({ signals: { "5D": { direction: "sell" } } })).toContain("5D: sell @ n/a");
  });

  it("carries the evidence summary through so claims can cite it", () => {
    expect(buildGroundingBlock(base)).toContain("change_pct=3.27%");
  });

  it("includes alignment and divergence context when present", () => {
    const out = buildGroundingBlock({
      ...base,
      alignment_score: 0.9,
      divergence_pattern: "none",
      divergence_interpretation: "timeframes agree",
    });
    expect(out).toContain("Alignment across timeframes: 0.9");
    expect(out).toContain("Divergence pattern: none — timeframes agree");
  });

  it("omits alignment entirely rather than printing a placeholder zero", () => {
    // A missing alignment score rendered as "0" would read to the model as
    // "timeframes maximally disagree", which is a fabricated finding.
    expect(buildGroundingBlock(base)).not.toContain("Alignment across timeframes");
  });

  it("survives a payload whose timeframe object is empty", () => {
    expect(buildGroundingBlock({ signals: { "1M": {} } })).toContain("1M: unknown @ n/a");
  });
});
