/**
 * signal-lookup — shared per-ticker fetch against gcp3's `/signals?symbol=X`.
 * Used by council grounding (structured taxonomy fields) and Nu AI chat
 * (plain-text grounding brief) so both hit the same parsing logic.
 *
 * As of TODO2, `fetchTickerEntry` is a read-through L2 over the `signal_cache`
 * table: a fresh cached entry short-circuits the backend, and — critically —
 * a *stale* cached entry is served when the backend is unreachable, so an
 * upstream outage degrades to "slightly old real data" instead of nothing
 * (see docs/wiki-portal/concept-cache-then-degrade.md).
 */
import sql from "@/lib/db";
import { cacheTtlMinutes, isCacheFresh, normalizeTicker } from "@/lib/shared/signal-policy";

// Re-export the pure guards so existing importers (drain route, watchlist
// route) keep resolving them from here; their canonical home is signal-policy.
export { normalizeTicker, isCacheFresh } from "@/lib/shared/signal-policy";

const MCP_URL = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
const FETCH_TIMEOUT_MS = 8_000;

interface CachedEntry {
  payload: Record<string, unknown>;
  generatedAt: string;
}

/**
 * Discriminated cache read so telemetry can tell the two null-ish cases apart:
 * a cold `miss` (no row — expected) vs. a `broken` read (the DB threw — an
 * outage the flat `null` used to hide, the standing tension on
 * concept-cache-then-degrade). `hit` carries the entry.
 */
type CacheReadResult =
  | { outcome: "hit"; entry: CachedEntry }
  | { outcome: "miss" }
  | { outcome: "broken" };

/** Guarded read of one ticker's cached entry. Never throws — cache is L2. */
async function readCachedEntry(ticker: string): Promise<CacheReadResult> {
  try {
    const rows = await sql`
      SELECT payload, generated_at FROM signal_cache WHERE ticker = ${ticker} LIMIT 1
    `;
    if (!rows.length) return { outcome: "miss" };
    return {
      outcome: "hit",
      entry: { payload: rows[0].payload as Record<string, unknown>, generatedAt: rows[0].generated_at as string },
    };
  } catch (err) {
    // Distinct from a cold miss — the cache is unreachable/un-migrated, which is
    // worth surfacing rather than silently treating as "no cached value."
    console.error(`[signal-cache] cache_broken ticker=${ticker} err=${err instanceof Error ? err.message : String(err)}`);
    return { outcome: "broken" };
  }
}

/** Live gcp3 fetch, no cache. Returns null on any failure. */
async function fetchTickerEntryLive(ticker: string): Promise<Record<string, unknown> | null> {
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

/**
 * Read-through fetch: fresh cache → live (and warm cache) → stale cache on
 * outage → null. Cache freshness is volatility-aware — a hot/actionable signal
 * expires in minutes, a quiet one lingers ([[signal-policy]] cacheTtlMinutes).
 * A malformed ticker short-circuits to null before any I/O.
 */
export async function fetchTickerEntry(ticker: string): Promise<Record<string, unknown> | null> {
  const symbol = normalizeTicker(ticker);
  if (!symbol) return null;

  const cached = await readCachedEntry(symbol);
  if (cached.outcome === "hit" && isCacheFresh(cached.entry.generatedAt, cacheTtlMinutes(cached.entry.payload))) {
    return cached.entry.payload;
  }

  const live = await fetchTickerEntryLive(symbol);
  if (live) {
    // Warm the L2 organically, not only via the drain job. Non-fatal.
    await saveTickerEntry(symbol, live);
    return live;
  }

  // Backend unreachable — serve stale real data rather than nothing.
  return cached.outcome === "hit" ? cached.entry.payload : null;
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

/** Upsert one ticker's raw entry into the signal_cache L2 (drain + organic warm path). */
export async function saveTickerEntry(ticker: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await sql`
      INSERT INTO signal_cache (ticker, payload, generated_at)
      VALUES (${ticker}, ${JSON.stringify(entry)}, now())
      ON CONFLICT (ticker) DO UPDATE SET payload = EXCLUDED.payload, generated_at = EXCLUDED.generated_at
    `;
  } catch {
    // non-fatal — signal_cache is L2; a failed warm just means the next read re-fetches live.
  }
}
