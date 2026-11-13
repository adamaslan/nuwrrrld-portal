/**
 * Honesty helpers for stored signal cards. The cards' computedAt arrives as a
 * weekday-prefixed Date.toString() rendering (e.g. "Fri Nov 13 2026 02:49:03
 * GMT+0000 (...)"), not ISO - so lexical ordering is not chronological
 * ("Sat Oct 24 ..." sorts after "Fri Nov 13 ..."). 2026-11-13: the Hold/Fold
 * aggregate header showed Oct 24 while the newest selected card was computed
 * Nov 13. Select by parsed time instead.
 */

/** Latest computedAt by actual time. Unparseable entries are skipped, never
 *  silently crowned latest; empty input yields "". */
export function latestComputedAt(cards: ReadonlyArray<{ computedAt: string }>): string {
  let best = "";
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const t = Date.parse(card.computedAt);
    if (!Number.isNaN(t) && t > bestTime) {
      best = card.computedAt;
      bestTime = t;
    }
  }
  return best;
}

/** Per-indicator strength from the indicator's own token value. The overall
 *  card direction must not be copied onto every indicator - an "rsi: neutral"
 *  row badged "bullish" mislabels the measurement (found 2026-11-13).
 *  Non-directional values (trending, normal, ...) are neutral. */
export function tokenStrength(value: string): string {
  const v = value.toLowerCase();
  if (v.startsWith("bullish")) return "bullish";
  if (v.startsWith("bearish")) return "bearish";
  return "neutral";
}
