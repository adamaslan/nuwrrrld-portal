import { expect, it } from "vitest";
import { describeLive, LIVE_KEY, SEAT_LATENCY_BUDGET_MS } from "./_harness";
import { callCouncilSeat } from "@/lib/openrouter";
import { SEED_CARDS } from "@/lib/shared/se1-catalog";
import { assistFactsFor, buildAssistPrompt, validateAssistAnswer } from "@/lib/shared/se1/assist-explainer";

// Model-agnostic on purpose: the chain is rotated in lib/openrouter.ts. Asserts invariants only, never wording.
describeLive("X26-04 scan assist (live, free chain)", () => {
  it("returns a non-empty answer inside the latency budget, and reports the grounding verdict", async () => {
    const facts = assistFactsFor(SEED_CARDS[0]);
    const started = Date.now();
    const result = await callCouncilSeat("QUANT", buildAssistPrompt(facts), LIVE_KEY, 1200, { answerOnly: true });
    const elapsed = Date.now() - started;

    expect(result.answer.trim().length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(SEAT_LATENCY_BUDGET_MS);
    expect(typeof result.model).toBe("string");

    // A free model may fail the grounding check. The route then shows the standard text, so this is data, not a failure.
    const verdict = validateAssistAnswer(result.answer, facts);
    console.info(`[scan-assist live] model=${result.model} elapsed_ms=${elapsed} grounded=${verdict.ok}${verdict.ok ? "" : ` reason=${verdict.reason}`}`);
  });
});
