/**
 * signal-policy — pure, dependency-free decision logic for the signal data
 * plane (ticker validation, cache freshness, drain retry). Kept separate from
 * signal-lookup.ts / signal-queue.ts precisely so it can be unit-tested without
 * pulling in `@/lib/db` (which throws at import when DATABASE_URL is unset).
 *
 * Nothing here does I/O. If a function needs the DB, it belongs elsewhere.
 */

export const CACHE_TTL_MINUTES = 15;
export const MAX_ATTEMPTS = 3;

/** Normalize/validate a ticker symbol. Returns null for anything unusable —
 *  the single guard used by enqueue, drain, and the watchlist route so a
 *  garbage symbol never reaches the backend. */
export function normalizeTicker(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().toUpperCase();
  // 1–10 chars, must start with a letter; allows dot/hyphen classes (BRK.B, RDS-A).
  return /^[A-Z][A-Z.\-]{0,9}$/.test(t) ? t : null;
}

/** Is `generatedAt` within `maxAgeMinutes` of `now`? Unparseable → not fresh. */
export function isCacheFresh(generatedAt: string | Date, maxAgeMinutes: number, now: Date = new Date()): boolean {
  const gen = generatedAt instanceof Date ? generatedAt : new Date(generatedAt);
  if (Number.isNaN(gen.getTime())) return false;
  return now.getTime() - gen.getTime() <= maxAgeMinutes * 60_000;
}

/** Has this row's failure count stayed under the cap? */
export function shouldRetry(attempts: number, maxAttempts: number = MAX_ATTEMPTS): boolean {
  return attempts < maxAttempts;
}

/**
 * Seconds a failed row should wait before its next drain attempt — exponential
 * so a struggling backend isn't hammered. `attempts` is the *new* failure count
 * (1-based): 1→base, 2→2×base, 3→4×base, capped at `maxSeconds`. Non-positive
 * attempts collapse to `base`.
 */
export function backoffSeconds(attempts: number, base: number = 30, maxSeconds: number = 3600): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(maxSeconds, base * 2 ** (n - 1));
}

/**
 * Volatility-aware cache TTL (minutes) for one ticker entry — a hot, actionable
 * signal should expire fast; a quiet neutral one can sit longer. Pure over the
 * fields gcp3 already returns (`ai_action`, `confluence_score`).
 */
export function cacheTtlMinutes(entry: Record<string, unknown>): number {
  const action = typeof entry.ai_action === "string" ? entry.ai_action.toUpperCase() : "";
  const conf = typeof entry.confluence_score === "number" ? entry.confluence_score : null;
  const actionable = /BUY|SELL|STRONG/.test(action);
  const extreme = conf != null && (conf >= 70 || conf <= 30);
  if (actionable || extreme) return 5; // hot — refresh often
  if (conf != null && conf >= 45 && conf <= 55) return 30; // quiet middle — let it sit
  return CACHE_TTL_MINUTES; // default 15
}
