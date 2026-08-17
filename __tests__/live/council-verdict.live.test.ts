/**
 * LIVE: the prompt → completion → parse → validate pipeline, end to end.
 *
 * The stubbed tests in __tests__/council-verdict.test.ts feed the parser
 * strings *we* wrote. That proves the parser handles the failures we already
 * know about. It cannot prove the current models still honour the format
 * contract in STRUCTURED_VERDICT_INSTRUCTIONS — which is the single assumption
 * every rendered verdict in the product rests on.
 *
 * That contract has broken before in exactly this way (2026-07-15 audit: the
 * T1 card rendered raw chain-of-thought). It broke silently because nothing
 * ran the real model against the real parser.
 */
import { expect, it } from "vitest";
import { callCouncilSeat, runSeat, seatSystemPrompt, CHAIR_VERDICT_SYSTEM } from "@/lib/openrouter";
import { parseStructuredVerdict, stripReasoning, directionFromOutlook } from "@/lib/council-verdict";
import { validateStructuredVerdict } from "@/lib/council-validate";
import { extractDirection } from "@/lib/council-critique";
import { buildCouncilPrompt } from "@/lib/shared/prompts";
import type { HoldFoldVerdict } from "@/app/api/holdfold/route";
import { FIXTURE_VERDICT, LIVE_KEY, describeLive } from "./_harness";

const verdictFixture = FIXTURE_VERDICT as unknown as HoldFoldVerdict;

describeLive("LIVE: structured verdict format contract (T1/T2)", () => {
  it.each(["T1", "T2"] as const)(
    "%s output survives stripReasoning and parses into all four fields",
    async (seat) => {
      const prompt = buildCouncilPrompt(verdictFixture, seat);
      const result = await callCouncilSeat(seat, prompt, LIVE_KEY, 400);
      console.info(`[verdict] ${seat} via ${result.model}:\n${result.answer.slice(0, 400)}`);

      const parsed = parseStructuredVerdict(result.answer);
      expect(
        parsed,
        `${seat} (${result.model}) did not emit the 4-field scaffold. The product renders ` +
          `an error state for this. Raw:\n${result.answer}`,
      ).not.toBeNull();

      expect(parsed!.outlook.toLowerCase()).toMatch(/^(bullish|bearish|neutral)$/);
      for (const field of ["because", "invalidation", "execution"] as const) {
        expect(parsed![field].trim().length, `${field} came back empty`).toBeGreaterThan(0);
      }
    },
  );

  it("never leaks chain-of-thought into the rendered field values", async () => {
    // The exact 2026-07-15 regression, checked against a live model rather
    // than a captured fixture. Reasoning-capable models in the current chain
    // (nemotron-3-*) emit "The user asks: ..." preamble by default, so this
    // is a live risk, not a historical one.
    const result = await callCouncilSeat("T1", buildCouncilPrompt(verdictFixture, "T1"), LIVE_KEY, 400);
    const parsed = parseStructuredVerdict(result.answer);
    if (!parsed) return; // covered by the test above; don't double-fail

    const leakage = /\b(the user (wants|asks|is asking)|I need to|let me|we should extract|as an AI)\b/i;
    for (const [field, value] of Object.entries(parsed)) {
      expect(leakage.test(value), `${field} leaked reasoning: "${value.slice(0, 160)}"`).toBe(false);
    }
    expect(stripReasoning(result.answer)).not.toMatch(/<think>/i);
  });

  it("grounds its numbers in the prompt data (the repair loop stays quiet)", async () => {
    const prompt = buildCouncilPrompt(verdictFixture, "T1");
    const result = await callCouncilSeat("T1", prompt, LIVE_KEY, 400);
    const parsed = parseStructuredVerdict(result.answer);
    if (!parsed) return;

    const flags = validateStructuredVerdict(parsed, prompt);
    // Not asserted as zero: hallucinated numbers are exactly what the repair
    // loop exists to absorb, and a hard assert here would be flaky by design.
    // What IS asserted: the validator runs clean over live output and the
    // model isn't so unmoored that repair could never converge.
    console.info(`[validate] ${flags.length} flag(s): ${flags.map((f) => f.message).join(" | ")}`);
    expect(flags.length, `live output produced ${flags.length} repair flags — the model is ` +
      `inventing most of its numbers, so the single repair retry cannot converge`).toBeLessThan(5);
  });
});

describeLive("LIVE: CHAIR verdict JSON contract", () => {
  it("emits a single JSON object that JSON.parse accepts directly", async () => {
    // CHAIR_VERDICT_SYSTEM promises the caller it can JSON.parse the output
    // with no regex fishing. That promise is a prompt, i.e. unenforced.
    const result = await runSeat(
      "CHAIR",
      [
        { role: "system", content: CHAIR_VERDICT_SYSTEM },
        {
          role: "user",
          content:
            "AAPL at $214.36, RSI 58.4, ADX 27.5, MACD 1.22. Council is split. Issue the verdict.",
        },
      ],
      LIVE_KEY,
      120,
      0.2,
    );
    console.info(`[chair-json] via ${result.model}: ${result.answer}`);

    const trimmed = result.answer.trim();
    let parsed: Record<string, unknown> | null = null;
    expect(() => {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    }, `CHAIR verdict was not parseable JSON — the route would throw. Raw: ${trimmed}`).not.toThrow();

    expect(Object.keys(parsed!).sort()).toEqual(
      ["confidence", "direction", "horizon", "invalidation"].sort(),
    );
    expect(parsed!.direction).toMatch(/^(bullish|bearish|neutral)$/);
    expect(parsed!.confidence).toMatch(/^(low|medium|high)$/);
  });
});

describeLive("LIVE: free-prose seats stay classifiable", () => {
  // RISK/MACRO/QUANT emit prose, and computeDisagreements depends on
  // extractDirection keyword-scanning that prose into a direction. If a model
  // starts hedging every sentence, disagreement detection degrades to "no
  // majority" and the council silently stops flagging dissent.
  it.each(["RISK", "MACRO", "QUANT"] as const)("%s prose yields a usable direction", async (seat) => {
    const result = await runSeat(
      seat,
      [
        { role: "system", content: seatSystemPrompt(seat) },
        { role: "user", content: buildCouncilPrompt(verdictFixture, "T1") },
      ],
      LIVE_KEY,
      320,
    );
    const direction = extractDirection(seat, result.answer);
    console.info(`[prose] ${seat} via ${result.model} → ${direction ?? "UNCLASSIFIABLE"}`);
    expect(result.answer.trim().length).toBeGreaterThan(0);
    // null is tolerated (computeDisagreements buckets it as "agreeing" rather
    // than guessing) but is logged so a drift toward unclassifiable is visible.
    if (direction) expect(["bullish", "bearish", "neutral"]).toContain(direction);
  });
});

describeLive("LIVE: directionFromOutlook agrees with the model's own wording", () => {
  it("maps a real OUTLOOK field to a ledger direction", async () => {
    const result = await callCouncilSeat("T2", buildCouncilPrompt(verdictFixture, "T2"), LIVE_KEY, 400);
    const parsed = parseStructuredVerdict(result.answer);
    if (!parsed) return;
    expect(["bullish", "bearish", "neutral"]).toContain(directionFromOutlook(parsed.outlook));
  });
});
