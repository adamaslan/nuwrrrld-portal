/**
 * Diff-shaped critique (docs/council-prompting-small-models.md §8): compute
 * who actually disagrees on direction in code, before spending a round-2
 * call on it. "Critique the other seats" produces polite mush from small
 * models — a mechanical disagreement check doesn't need a model at all, and
 * seats that already agree with the majority skip round 2 entirely.
 *
 * Pure functions, no network — kept in their own module so this logic is
 * unit-testable without hitting OpenRouter or Neon.
 */
import { parseStructuredVerdict, directionFromOutlook } from "@/lib/council-verdict";
import type { CouncilSeat } from "@/lib/openrouter";

export type VerdictDirection = "bullish" | "bearish" | "neutral";

const BULLISH_RE = /\bbullish\b|\bbuy\b|\blong\b/gi;
const BEARISH_RE = /\bbearish\b|\bsell\b|\bshort\b/gi;
const NEUTRAL_RE = /\bneutral\b|\bhold\b|\bno[\s-]?edge\b|\bno[\s-]?clear\s+direction\b/gi;

/**
 * Extract a seat's direction from its round-1 answer. T1/T2 use the
 * structured 4-field scaffold (parsed the same way the UI parses it); the
 * free-prose seats (RISK/MACRO/QUANT) get a keyword count — ambiguous or
 * tied text returns null rather than guessing, so it's excluded from the
 * majority/disagreement computation instead of silently miscounted.
 */
export function extractDirection(seat: CouncilSeat, answerText: string): VerdictDirection | null {
  if (seat === "T1" || seat === "T2") {
    const verdict = parseStructuredVerdict(answerText);
    return verdict ? directionFromOutlook(verdict.outlook) : null;
  }
  const bullishHits = (answerText.match(BULLISH_RE) ?? []).length;
  const bearishHits = (answerText.match(BEARISH_RE) ?? []).length;
  const neutralHits = (answerText.match(NEUTRAL_RE) ?? []).length;
  // Explicit "neutral"/"hold"/"no clear direction" conclusions must be
  // recognized as a real vote, not lumped in with genuinely ambiguous text
  // (flagged in PR #37 review) — free-prose seats otherwise have no way to
  // cast a neutral vote.
  if (neutralHits > 0 && neutralHits >= bullishHits && neutralHits >= bearishHits) return "neutral";
  if (bullishHits === 0 && bearishHits === 0) return null;
  if (bullishHits === bearishHits) return null;
  return bullishHits > bearishHits ? "bullish" : "bearish";
}

export interface DisagreementResult {
  majority: VerdictDirection | null;
  directions: Partial<Record<CouncilSeat, VerdictDirection | null>>;
  agreeing: CouncilSeat[];
  disagreeing: CouncilSeat[];
}

/**
 * Given each answered seat's round-1 text, compute the majority direction
 * and split seats into agreeing / disagreeing. Ties, and seats whose
 * direction couldn't be extracted, land in `agreeing` — round 2 is a cost
 * spent only on genuine, detectable conflict, never on ambiguity.
 */
export function computeDisagreements(
  answers: Array<{ seat: CouncilSeat; answer: string }>,
): DisagreementResult {
  const directions: Partial<Record<CouncilSeat, VerdictDirection | null>> = {};
  const counts: Record<VerdictDirection, number> = { bullish: 0, bearish: 0, neutral: 0 };

  for (const { seat, answer } of answers) {
    const dir = extractDirection(seat, answer);
    directions[seat] = dir;
    if (dir) counts[dir] += 1;
  }

  const entries = (Object.entries(counts) as Array<[VerdictDirection, number]>).filter(([, n]) => n > 0);
  entries.sort((a, b) => b[1] - a[1]);
  const topCount = entries[0]?.[1] ?? 0;
  const tiedForTop = entries.filter(([, n]) => n === topCount);
  const majority = topCount > 0 && tiedForTop.length === 1 ? tiedForTop[0][0] : null;

  const agreeing: CouncilSeat[] = [];
  const disagreeing: CouncilSeat[] = [];
  for (const { seat } of answers) {
    const dir = directions[seat];
    if (majority && dir && dir !== majority) {
      disagreeing.push(seat);
    } else {
      agreeing.push(seat);
    }
  }

  return { majority, directions, agreeing, disagreeing };
}
