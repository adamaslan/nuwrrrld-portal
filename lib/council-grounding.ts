/**
 * Council grounding — assembles a factual data brief for a ticker so seats
 * argue over real numbers, not the prompt string. Sources (each degrades to
 * "omitted" independently):
 *   - gcp3 /signals?symbol=X  → confluence score, per-indicator reasons, action
 *   - backtest_hit_rates (WS1) → measured hit-rates by category/strength
 *   - council_verdicts (WS1)   → the council's own prior calls on this ticker
 *
 * When nothing is available the brief is just the user's question — the council
 * still runs, ungrounded, rather than failing.
 */
import sql from "@/lib/db";
import { recentVerdicts } from "@/lib/council-db";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const FETCH_TIMEOUT_MS = 8_000;

async function fetchSignalBrief(ticker: string): Promise<string | null> {
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
    return lines.length ? lines.join("\n") : null;
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

/** Build the grounded brief. `ticker` may be null for a free-form question. */
export async function buildGroundedBrief(question: string, ticker: string | null): Promise<string> {
  const parts: string[] = [`QUESTION: ${question}`];

  if (ticker) {
    const [signal, hitRates, priors] = await Promise.all([
      fetchSignalBrief(ticker),
      fetchHitRates(ticker),
      fetchPriorVerdicts(ticker),
    ]);
    if (signal) parts.push(`=== LIVE SIGNAL DATA (${ticker}) ===\n${signal}`);
    if (hitRates) parts.push(`=== ${hitRates}`);
    if (priors) parts.push(`=== ${priors}`);
    if (!signal && !hitRates && !priors) {
      parts.push(`(No grounding data available for ${ticker} — reason from general knowledge and say so.)`);
    }
  }

  return parts.join("\n\n");
}
