/**
 * Council grounding — assembles a factual data brief for a ticker so seats
 * argue over real numbers, not the prompt string. Sources (each degrades to
 * "omitted" independently):
 *   - gcp3 /signals?symbol=X  → confluence score, per-indicator reasons, action
 *   - backtest_hit_rates (WS1) → measured hit-rates by category/strength
 *   - council_verdicts (WS1)   → the council's own prior calls on this ticker
 *   - grounding_pack (PR 3)    → compiled tier-ladder corpus lookups (zero model cost)
 *
 * When nothing is available the brief is just the user's question — the council
 * still runs, ungrounded, rather than failing.
 *
 * Per-seat slicing (docs/ai-council-timeline.html, "Seat wiring"): each seat
 * gets a different slice of the same compiled pack instead of one shared
 * brief, so the horizon wall and RISK's counter-argument are enforced at the
 * data layer rather than left to the model to remember.
 */
import sql from "@/lib/db";
import { recentVerdicts } from "@/lib/council-db";
import { resolveGrounding, type GroundingRule } from "@/lib/grounding/resolve";
import type { Horizon, SignalStateInput } from "@/lib/grounding/taxonomy";
import type { CouncilSeat } from "@/lib/openrouter";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const FETCH_TIMEOUT_MS = 8_000;

type VerdictDirection = "bullish" | "bearish" | "neutral";

function directionFromAction(action: unknown): VerdictDirection | null {
  const a = typeof action === "string" ? action.toLowerCase() : "";
  if (a.includes("buy") || a.includes("bull")) return "bullish";
  if (a.includes("sell") || a.includes("bear")) return "bearish";
  if (a.includes("hold") || a.includes("neutral")) return "neutral";
  return null;
}

function opposite(direction: VerdictDirection | null): VerdictDirection | null {
  if (direction === "bullish") return "bearish";
  if (direction === "bearish") return "bullish";
  return null; // no opposite of neutral — RISK falls back to no direction filter
}

interface SignalData {
  text: string;
  structured: SignalStateInput;
}

/**
 * Single fetch of the live signal payload, returning both the human-readable
 * brief text and the structured fields the taxonomy needs for a Tier 0
 * lookup — avoids a second network round-trip for the same data.
 */
async function fetchSignalData(ticker: string): Promise<SignalData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals?symbol=${encodeURIComponent(ticker)}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { symbols?: Record<string, Record<string, unknown>> };
    const entry = data.symbols?.[ticker] ?? Object.values(data.symbols ?? {})[0];
    if (!entry) return null;

    const lines: string[] = [];
    if (entry.ai_action) lines.push(`Action: ${entry.ai_action}`);
    if (typeof entry.confluence_score === "number") lines.push(`Confluence score: ${entry.confluence_score}`);
    if (entry.ai_summary) lines.push(`Summary: ${entry.ai_summary}`);
    const signals = Array.isArray(entry.signals) ? (entry.signals as Record<string, unknown>[]) : [];
    const reasons = signals.map((s) => String(s.detail ?? s.signal ?? "")).filter(Boolean).slice(0, 6);
    if (reasons.length) lines.push(`Signals:\n- ${reasons.join("\n- ")}`);
    if (!lines.length) return null;

    // Best-effort structured fields — gcp3's payload doesn't expose raw
    // RSI/MACD/ADX/volatility today, so those buckets default to their
    // taxonomy-neutral value (see taxonomy.ts bucketRsi/bucketAdx/bucketVol).
    // Tier 0 still keys correctly on confluence + direction and degrades
    // gracefully to Tier 1/2 when that's not enough to match a pack row.
    const structured: SignalStateInput = {
      confluenceScore: typeof entry.confluence_score === "number" ? entry.confluence_score : null,
      direction: directionFromAction(entry.ai_action),
    };

    return { text: lines.join("\n"), structured };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHitRates(ticker: string): Promise<string | null> {
  try {
    const rows = await sql`
      SELECT bucket_kind, bucket_key, hits, total, hit_rate
      FROM backtest_hit_rates
      WHERE ticker = ${ticker}
      ORDER BY total DESC
      LIMIT 8
    `;
    if (!rows.length) return null;
    const lines = rows.map(
      (r) => `- ${r.bucket_kind}/${r.bucket_key}: ${Math.round(Number(r.hit_rate) * 100)}% (n=${r.total})`,
    );
    return `Historical hit-rates (signals-app backtest):\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}

async function fetchPriorVerdicts(ticker: string): Promise<string | null> {
  const verdicts = await recentVerdicts(ticker, 3);
  if (!verdicts.length) return null;
  const lines = verdicts.map((v) => {
    const when = v.createdAt.slice(0, 10);
    return `- ${when}: ${v.direction ?? "?"} (${v.confidence ?? "?"} conf, ${v.horizon ?? "?"}); invalidation: ${v.invalidation ?? "n/a"}`;
  });
  return `The council's own prior verdicts on ${ticker}:\n${lines.join("\n")}`;
}

/** Selection-not-generation (docs/council-prompting-small-models.md §4): format
 * pack rows as a numbered list the seat can only choose from, never invent. */
function formatRules(rules: GroundingRule[], tier: number): string {
  const lines: string[] = [`[Grounding via Tier ${tier}]`, "RULES (choose from these only):"];
  rules.slice(0, 4).forEach((rule, i) => {
    const dirTag = rule.direction ? `, ${rule.direction}` : "";
    lines.push(`[C${i + 1}]${dirTag} "${rule.quote}" — ${rule.sourceFile}`);
  });
  lines.push("Pick the rules that apply. Your BECAUSE line may only use ids from this list.");
  return lines.join("\n");
}

/**
 * Seat-specific horizon + trader filter + direction filter for the tier-ladder
 * resolver. QUANT is intentionally excluded upstream (numbers only, no pack
 * rules); CHAIR reads the round transcript rather than calling this directly.
 */
function slicingForSeat(
  seat: CouncilSeat,
  signalDirection: VerdictDirection | null,
): { horizon: Horizon; traderFilter: string | null; directionFilter: VerdictDirection | null; useTier0: boolean } {
  switch (seat) {
    case "T1":
      return { horizon: "t1", traderFilter: "T1", directionFilter: null, useTier0: true };
    case "T2":
      return { horizon: "t2", traderFilter: "T2", directionFilter: null, useTier0: true };
    case "RISK":
      // Counter-slice: pack rows whose direction opposes the live signal —
      // indexed dissent a similarity search could never retrieve.
      return { horizon: "t1", traderFilter: null, directionFilter: opposite(signalDirection), useTier0: true };
    case "MACRO":
      // Macro isn't in the signal-state taxonomy — skip the Tier 0 state-key
      // lookup and rely on Tier 1/2 full-text search only.
      return { horizon: "t1", traderFilter: null, directionFilter: null, useTier0: false };
    default:
      return { horizon: "t1", traderFilter: null, directionFilter: null, useTier0: true };
  }
}

/**
 * Build the grounded brief for one seat. `ticker` may be null for a
 * free-form question; `seat` controls which slice of the compiled pack (if
 * any) is attached. QUANT deliberately never sees pack rules — numbers only.
 */
export async function buildGroundedBrief(
  question: string,
  ticker: string | null,
  seat: CouncilSeat,
): Promise<string> {
  const parts: string[] = [`QUESTION: ${question}`];

  if (!ticker) return parts.join("\n\n");

  const [signalData, hitRates, priors] = await Promise.all([
    fetchSignalData(ticker),
    fetchHitRates(ticker),
    fetchPriorVerdicts(ticker),
  ]);

  let compiled: string | null = null;
  if (seat !== "QUANT") {
    const { horizon, traderFilter, directionFilter, useTier0 } = slicingForSeat(
      seat,
      signalData?.structured.direction ?? null,
    );
    try {
      const result = await resolveGrounding(
        question,
        useTier0 ? signalData?.structured ?? null : null,
        horizon,
        ticker,
        traderFilter,
        directionFilter,
      );
      if (result.tier !== null && result.rules.length > 0) {
        compiled = formatRules(result.rules, result.tier);
      }
    } catch {
      compiled = null;
    }
  }

  if (signalData?.text) parts.push(`=== LIVE SIGNAL DATA (${ticker}) ===\n${signalData.text}`);
  if (hitRates) parts.push(`=== ${hitRates}`);
  if (priors) parts.push(`=== ${priors}`);
  if (compiled) parts.push(compiled);
  if (!signalData?.text && !hitRates && !priors && !compiled) {
    parts.push(`(No grounding data available for ${ticker} — reason from general knowledge and say so.)`);
  }

  return parts.join("\n\n");
}
