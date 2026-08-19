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

/** How many tickers share one batched `ticker_thesis` prompt. */
export const THESIS_BATCH_SIZE = 10;

/**
 * Where a precompute run gets its subjects.
 *
 * `watchlist` — what users actually hold. Demand-side, and the original
 * behavior: it spends quota on tickers someone has already asked about.
 * `ranking`  — the strongest cards in the universe. Supply-side: it spends
 * quota on what the data says is interesting, whether or not anyone has
 * asked yet, which is the point of having a ranked universe at all.
 */
export type PrecomputeSource = "watchlist" | "ranking";

/** Anything unrecognized is the pre-existing behavior. A new mode must be
 *  opted into explicitly — a typo should not silently change what a
 *  scheduled job spends the day's quota on. */
export function resolvePrecomputeSource(raw: unknown): PrecomputeSource {
  return raw === "ranking" ? "ranking" : "watchlist";
}

/**
 * Split ranked tickers into batched thesis subjects.
 *
 * This is the quota arithmetic the universe design rests on: ten tickers in
 * one prompt is one request against a 50/day ceiling, where ten separate
 * narratives would be ten. At `THESIS_BATCH_SIZE` = 10 a 100-ticker sweep
 * costs 10 calls rather than 100 — the difference between "a scheduled job
 * that fits in the free tier" and one that cannot run at all.
 *
 * Order is preserved so batch 0 holds the highest-scoring tickers: if the run
 * stops early on quota exhaustion, the batches that did complete are the ones
 * that mattered most. Within a batch, `subjectFromTickers` sorts for cache
 * stability — so a batch's *membership* follows the ranking while its *key*
 * does not depend on ranking order.
 */
export function batchThesisSubjects(
  tickers: readonly string[],
  batchSize: number = THESIS_BATCH_SIZE,
): string[] {
  const size = Math.max(1, Math.trunc(batchSize));
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of tickers) {
    const t = raw.trim().toUpperCase();
    // De-duplicate across the whole ranking, not per batch: the same ticker
    // appearing twice would otherwise buy a second narrative for one symbol.
    if (!t || seen.has(t)) continue;
    seen.add(t);
    ordered.push(t);
  }

  const subjects: string[] = [];
  for (let i = 0; i < ordered.length; i += size) {
    subjects.push(subjectFromTickers(ordered.slice(i, i + size)));
  }
  return subjects;
}
