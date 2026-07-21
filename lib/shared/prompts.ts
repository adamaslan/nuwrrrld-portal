/**
 * prompts — shared "Go deeper" / Council prompt builders.
 * Grounds every AI call in the exact fetched data (`=== REAL DATA ===`
 * pattern) rather than letting the model improvise from memory.
 */
import type { SignalPayload } from "@/lib/digest";
import type { HoldFoldVerdict } from "@/app/api/holdfold/route";

export function buildSignalPrompt(sig: SignalPayload): string {
  return [
    `=== REAL DATA: ${sig.ticker} signal ===`,
    `Direction: ${sig.direction} | Confidence: ${sig.confidence} | Timeframe: ${sig.timeframe}`,
    `Title: ${sig.title}`,
    `Explanation: ${sig.explanation}`,
    `Indicators: ${sig.indicators.join(", ") || "none"}`,
    `Generated: ${sig.generatedAt}`,
    ``,
    `Using ONLY the exact data above, provide a 1–5 day trade framing for ${sig.ticker}.`,
    `Cover: entry thesis, key risk, invalidation level, and how the indicators confirm the signal. (~150 words)`,
  ].join("\n");
}

export type CouncilSeat = "T1" | "T2";

export function buildCouncilPrompt(v: HoldFoldVerdict, seat: CouncilSeat): string {
  const fmt = (n: number | null) => (n == null ? "n/a" : n.toFixed(2));
  const topSigs = v.signals.slice(0, 4).map(s => `${s.signal} (${s.strength})`).join("; ");
  const ret = v.returns;

  if (seat === "T1") {
    return [
      `=== REAL DATA: ${v.ticker} ===`,
      `Verdict: ${v.verdict} | Confidence: ${v.confidenceLabel} (${v.confidence}%) | Bias: ${v.bias}`,
      `Industry: ${v.industry}`,
      `Indicators — RSI: ${fmt(v.rsi)}, MACD: ${fmt(v.macd)}, ADX: ${fmt(v.adx)}`,
      `Price: $${v.price > 0 ? v.price.toFixed(2) : "n/a"} | 52W: $${v.low52w.toFixed(2)} – $${v.high52w.toFixed(2)}`,
      `Returns: 1d ${ret["1d"] ?? "n/a"}%, 1w ${ret["1w"] ?? "n/a"}%, 1m ${ret["1m"] ?? "n/a"}%`,
      `Top signals: ${topSigs || "none"}`,
      `AI outlook: ${v.aiOutlook}`,
      ``,
      `Using the EXACT data above, deliver a short-term trading verdict for ${v.ticker}.`,
      `Cover the 1-5 day horizon: outlook, key driver, entry, stop, invalidation. (~150 words)`,
    ].join("\n");
  }

  return [
    `=== REAL DATA: ${v.ticker} ===`,
    `Verdict: ${v.verdict} | Confidence: ${v.confidenceLabel} (${v.confidence}%) | Bias: ${v.bias}`,
    `Industry: ${v.industry}`,
    `Returns: 1m ${ret["1m"] ?? "n/a"}%, 3m ${ret["3m"] ?? "n/a"}%, 1y ${ret["1y"] ?? "n/a"}%`,
    `52W range: $${v.low52w.toFixed(2)} – $${v.high52w.toFixed(2)}`,
    `AI outlook: ${v.aiOutlook}`,
    ``,
    `Using the EXACT data above, deliver a long-term investment thesis for ${v.ticker}.`,
    `Cover the 3–12 month horizon: secular thesis, key catalyst, risk/reward, invalidation. (~150 words)`,
  ].join("\n");
}
