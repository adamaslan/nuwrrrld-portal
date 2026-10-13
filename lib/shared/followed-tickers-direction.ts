/**
 * Pure direction mapping for followed-ticker signals (no DB imports, so it is
 * unit-testable and shareable with gcp3-mobile).
 */

/** Oldest card (in calendar days) that still counts as today's signal. */
export const CARD_MAX_AGE_DAYS = 3;
const MS_PER_DAY = 86_400_000;

export type PickDirection = "bull" | "bear";

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY);
}

/** Direction from a card's tokens, or null when stale, malformed or neutral. */
export function directionFromCard(
  card: { barDate: string; tokens?: { direction?: string } | null } | null,
  today: string,
): PickDirection | null {
  if (!card || !card.barDate) return null;
  const age = daysBetween(card.barDate, today);
  if (Number.isNaN(age) || age < 0 || age > CARD_MAX_AGE_DAYS) return null;
  const direction = card.tokens?.direction;
  if (direction === "bullish") return "bull";
  if (direction === "bearish") return "bear";
  return null;
}

/** Direction from a gcp3 `ai_action` label (BUY / SELL / …), or null. */
export function directionFromAction(action: unknown): PickDirection | null {
  const label = typeof action === "string" ? action.toLowerCase() : "";
  if (label.includes("buy")) return "bull";
  if (label.includes("sell")) return "bear";
  return null;
}
