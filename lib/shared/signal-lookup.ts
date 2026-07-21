/**
 * signal-lookup — shared per-ticker fetch against gcp3's `/signals?symbol=X`.
 * Used by council grounding (structured taxonomy fields) and Nu AI chat
 * (plain-text grounding brief) so both hit the same parsing logic.
 */
const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const FETCH_TIMEOUT_MS = 8_000;

export async function fetchTickerEntry(ticker: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${MCP_URL}/signals?symbol=${encodeURIComponent(ticker)}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { symbols?: Record<string, Record<string, unknown>> };
    return data.symbols?.[ticker] ?? Object.values(data.symbols ?? {})[0] ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable REAL DATA brief for one ticker entry — null when there's nothing worth grounding on. */
export function formatTickerBrief(entry: Record<string, unknown>): string | null {
  const lines: string[] = [];
  if (entry.ai_action) lines.push(`Action: ${entry.ai_action}`);
  if (typeof entry.confluence_score === "number") lines.push(`Confluence score: ${entry.confluence_score}`);
  if (entry.ai_summary) lines.push(`Summary: ${entry.ai_summary}`);
  // Guard against non-object/null entries in an externally-supplied array
  // (flagged in PR #37 review) — a malformed element would otherwise throw
  // on `s.detail` and crash the whole signal fetch.
  const signals = Array.isArray(entry.signals) ? (entry.signals as Record<string, unknown>[]) : [];
  const reasons = signals
    .map((s) => (s && typeof s === "object" ? String(s.detail ?? s.signal ?? "") : ""))
    .filter(Boolean)
    .slice(0, 6);
  if (reasons.length) lines.push(`Signals:\n- ${reasons.join("\n- ")}`);
  return lines.length ? lines.join("\n") : null;
}

/** One-shot fetch + format, for callers that only need the text brief (e.g. Nu AI grounding). */
export async function fetchTickerSignalBrief(ticker: string): Promise<string | null> {
  const entry = await fetchTickerEntry(ticker);
  if (!entry) return null;
  return formatTickerBrief(entry);
}
