/**
 * LIVE: the streaming surfaces — /api/brief, /api/nuai, /api/portfolio/health-ai.
 *
 * All three take a real SSE stream from OpenRouter and re-emit it. The failure
 * mode they share is not "wrong answer" but "no answer": an HTTP 200 whose
 * stream carries zero content tokens, which the user sees as a spinner that
 * never resolves. BUG-4 (tokens arriving only in `delta.reasoning`) and BUG-5
 * (empty completions passing the HTTP-status check) were both this shape, and
 * neither is observable without a real stream.
 */
import { expect, it } from "vitest";
import { fetchWithModelFallback, fetchWithModelFallbackChecked } from "@/lib/openrouter";
import { buildSignalPrompt } from "@/lib/shared/prompts";
import type { SignalPayload } from "@/lib/digest";
import { LIVE_KEY, describeLive, drainSSEText } from "./_harness";

const SIGNAL: SignalPayload = {
  id: "AAPL",
  ticker: "AAPL",
  direction: "bullish",
  confidence: "medium",
  timeframe: "medium",
  title: "MACD crossover with trending ADX",
  explanation: "MACD crossed above signal at 1.22 while ADX holds 27.5, confirming trend strength.",
  indicators: ["MACD", "ADX", "RSI"],
  generatedAt: "2026-07-27T12:00:00.000Z",
} as SignalPayload;

describeLive("LIVE: /api/brief streaming path", () => {
  it("streams actual content tokens, not just an empty 200", async () => {
    const { response, model } = await fetchWithModelFallback(
      LIVE_KEY,
      {
        max_tokens: 350,
        stream: true,
        temperature: 0.3,
        messages: [{ role: "user", content: buildSignalPrompt(SIGNAL) }],
      },
      "NuWrrrld live test",
    );
    const text = await drainSSEText(response.body!);
    console.info(`[brief] ${model} → ${text.length} chars`);
    expect(
      text.trim().length,
      `${model} returned HTTP 200 with an empty stream — the brief UI spins forever`,
    ).toBeGreaterThan(40);
  });

  it("stays grounded in the ticker it was given", async () => {
    // The `=== REAL DATA ===` prompt convention exists to stop the model
    // improvising from memory. Cheapest possible check that it took hold.
    const { response } = await fetchWithModelFallback(
      LIVE_KEY,
      {
        max_tokens: 350,
        stream: true,
        temperature: 0.3,
        messages: [{ role: "user", content: buildSignalPrompt(SIGNAL) }],
      },
      "NuWrrrld live test",
    );
    const text = await drainSSEText(response.body!);
    expect(text.toUpperCase(), `brief never mentioned AAPL:\n${text.slice(0, 300)}`).toContain("AAPL");
  });
});

describeLive("LIVE: /api/portfolio/health-ai path (fetchWithModelFallbackChecked)", () => {
  it("guarantees a non-empty stream — the whole point of the Checked variant", async () => {
    const { response, model } = await fetchWithModelFallbackChecked(
      LIVE_KEY,
      {
        max_tokens: 1024,
        stream: true,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content:
              "=== REAL DATA: portfolio ===\nAAPL 40%, MSFT 35%, NVDA 25%.\n\n" +
              "Using ONLY the data above, assess concentration risk in ~120 words.",
          },
        ],
      },
      "NuWrrrld live test",
    );
    const text = await drainSSEText(response.body!);
    console.info(`[health-ai] ${model} → ${text.length} chars`);
    expect(
      text.trim().length,
      "fetchWithModelFallbackChecked resolved but the stream was empty — its contract is " +
        "that an empty completion advances to the next model instead of reaching the caller",
    ).toBeGreaterThan(40);
  });

  it("does not drop or duplicate the primed bytes when reconstructing the stream", async () => {
    // The Checked variant buffers bytes while probing for the first token, then
    // replays them ahead of the untouched reader. An off-by-one there shows up
    // as a truncated or doubled opening sentence in the UI.
    const { response } = await fetchWithModelFallbackChecked(
      LIVE_KEY,
      {
        max_tokens: 200,
        stream: true,
        temperature: 0,
        messages: [
          { role: "user", content: "Count from 1 to 12, space separated, digits only, no other text." },
        ],
      },
      "NuWrrrld live test",
    );
    const text = await drainSSEText(response.body!);
    const digits = text.match(/\b([1-9]|1[0-2])\b/g) ?? [];
    console.info(`[health-ai:replay] "${text.trim().slice(0, 120)}"`);
    // A duplicated priming buffer shows up as a repeated leading "1".
    expect(digits.length, `expected a 1-12 sequence, got: ${text.slice(0, 200)}`).toBeGreaterThan(6);
    const firstRun = digits.slice(0, 3).join(",");
    expect(firstRun, "opening tokens look duplicated — priming buffer replayed twice").not.toBe("1,1,2");
  });
});

describeLive("LIVE: /api/nuai path", () => {
  it("streams a grounded answer when given portfolio context", async () => {
    const { response, model } = await fetchWithModelFallback(
      LIVE_KEY,
      {
        max_tokens: 400,
        stream: true,
        temperature: 0.3,
        messages: [
          {
            role: "user",
            content:
              "The user holds: AAPL, MSFT, NVDA.\n" +
              "Question: which of my holdings carries the most single-name concentration risk? " +
              "Answer in ~80 words using only the tickers listed.",
          },
        ],
      },
      "NuWrrrld live test",
    );
    const text = await drainSSEText(response.body!);
    console.info(`[nuai] ${model} → ${text.length} chars`);
    expect(text.trim().length).toBeGreaterThan(40);
    // Grounding check: it should talk about the tickers it was handed rather
    // than inventing holdings the user does not have.
    expect(/AAPL|MSFT|NVDA/i.test(text), `nuai ignored the provided holdings:\n${text.slice(0, 300)}`).toBe(true);
  });
});
