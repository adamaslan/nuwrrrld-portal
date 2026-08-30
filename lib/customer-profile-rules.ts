/**
 * customer-profile-rules — the PURE half of the customer profile (Phase 5 of
 * docs/todo-auth-cookies-tracking.md).
 *
 * Two rules shape this file, both from the plan:
 *
 * 1. **Composed from data we already hold**, never newly collected. Every field
 *    below is derived from an existing table or from Clerk metadata. Nothing
 *    here creates a new collection surface.
 * 2. **Every field is classified** (`identifier` | `behavioral` | `financial` |
 *    `derived`), and `financial` fields never leave the primary DB — not into
 *    analytics, not into an ad payload, not into a log line. `FIELD_CLASS`
 *    below is the machine-readable form of that classification, and
 *    `assertNoFinancialFields()` is the guard that makes it enforceable rather
 *    than aspirational.
 *
 * Deliberately NOT here, per plan §5.2: any inference about net worth, income,
 * creditworthiness, employment, or financial distress. Those are
 * special-category-adjacent and out of proportion to what this product needs.
 *
 * No I/O here on purpose: the classification map, the segment rules, and the
 * financial-field guard are the parts a regulator or a test can interrogate,
 * so they must not require a database connection to load. The composition that
 * reads Postgres lives in lib/customer-profile.ts.
 */

export type FieldClass = "identifier" | "behavioral" | "financial" | "derived";

/**
 * The classification of every field this module can emit. Anything absent from
 * this map is unclassified and must not be added to a profile payload.
 */
export const FIELD_CLASS: Record<string, FieldClass> = {
  user_id: "identifier",
  signup_date: "identifier",
  plan_tier: "identifier",
  council_sessions: "behavioral",
  council_deliberations: "behavioral",
  nuai_days_active: "behavioral",
  watchlist_size: "behavioral",
  disclaimer_acks: "behavioral",
  verdicts_requested: "behavioral",
  first_touch: "behavioral",
  last_touch: "behavioral",
  consent: "identifier",
  interest_tags: "derived",
  segments: "derived",
  // Present in the DB but NEVER in a profile payload. Listed so the class is
  // documented and the guard below has something to match on.
  holdings: "financial",
  position_sizes: "financial",
  portfolio_value: "financial",
};

/** Field names that must never appear in any payload leaving this module. */
export const FINANCIAL_FIELDS = Object.entries(FIELD_CLASS)
  .filter(([, c]) => c === "financial")
  .map(([k]) => k);

/**
 * The segments the product may derive, each with the documented rule that
 * produces it. Plan §5.2: under GDPR Art. 15/22 a user can ask how an automated
 * inference about them was produced — an undocumented segment is unanswerable,
 * so the derivation string here IS the answer and ships in the profile.
 */
export const SEGMENT_RULES = {
  power_user: "5+ council sessions AND an active watchlist (3+ tickers)",
  at_risk_churn: "no council session and no NuAI usage in the last 30 days",
  trial_stalled: "on a trial, but zero council sessions since signup",
  signal_only: "views signals but has never started a council session",
  portfolio_active: "watchlist has 3 or more tickers",
  ai_heavy: "10+ council sessions, or NuAI usage on 5+ distinct days",
} as const;

export type SegmentName = keyof typeof SEGMENT_RULES;

export interface CustomerProfile {
  user_id: string;
  plan_tier: string;
  engagement: {
    council_sessions: number;
    council_deliberations: number;
    nuai_days_active: number;
    watchlist_size: number;
    disclaimer_acks: number;
  };
  /** Sector/'interest' tags derived from watchlist tickers only — never holdings. */
  interest_tags: string[];
  segments: SegmentName[];
  /** How each assigned segment was derived, for Art. 15 transparency. */
  segment_derivations: Partial<Record<SegmentName, string>>;
  attribution: { first_touch: unknown; last_touch: unknown } | null;
}

/**
 * Throw if a payload carries any field classified `financial`. Call this before
 * any profile object crosses a boundary — an analytics sink, an API response,
 * a log line. Cheap, and it converts plan §5.1's rule from a comment into a
 * runtime invariant.
 */
export function assertNoFinancialFields(payload: Record<string, unknown>): void {
  for (const key of Object.keys(payload)) {
    if (FIELD_CLASS[key] === "financial") {
      throw new Error(
        `customer-profile: refusing to emit financial field "${key}" — ` +
          "financial data must never leave the primary database (plan §5.1)",
      );
    }
  }
}

/** Assign segments from already-computed counters. Pure — trivially testable. */
export function deriveSegments(input: {
  councilSessions: number;
  nuaiDaysActive: number;
  watchlistSize: number;
  daysSinceLastActivity: number | null;
  isTrial: boolean;
}): { segments: SegmentName[]; derivations: Partial<Record<SegmentName, string>> } {
  const segments: SegmentName[] = [];
  const derivations: Partial<Record<SegmentName, string>> = {};
  const add = (s: SegmentName) => {
    segments.push(s);
    derivations[s] = SEGMENT_RULES[s];
  };

  if (input.councilSessions >= 5 && input.watchlistSize >= 3) add("power_user");
  if (input.daysSinceLastActivity !== null && input.daysSinceLastActivity > 30) {
    add("at_risk_churn");
  }
  if (input.isTrial && input.councilSessions === 0) add("trial_stalled");
  if (input.councilSessions === 0 && input.watchlistSize > 0) add("signal_only");
  if (input.watchlistSize >= 3) add("portfolio_active");
  if (input.councilSessions >= 10 || input.nuaiDaysActive >= 5) add("ai_heavy");

  return { segments, derivations };
}

