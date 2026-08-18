/**
 * precompute-policy — pure, dependency-free logic for the precomputed-AI layer
 * (Option D, docs/gha-modal-core-feature-coverage.md).
 *
 * Split from precomputed-ai-db.ts for the same reason signal-policy.ts is split
 * from signal-lookup.ts: that module imports `@/lib/db`, which throws at import
 * time when DATABASE_URL is unset, so anything unit-testable must live outside
 * it. Nothing here does I/O.
 */

/**
 * Stable key for a ticker-set-scoped artifact. Sorted, upper-cased and
 * de-duplicated so the same portfolio yields the same subject regardless of
 * the order the watchlist happens to come back in — otherwise a reordering
 * would miss the cache and silently re-spend the free-tier quota this whole
 * feature exists to conserve.
 */
export function subjectFromTickers(tickers: string[]): string {
  const normalized = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))].sort();
  return normalized.join(",");
}
