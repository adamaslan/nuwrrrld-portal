/**
 * customer_profile — the DB composition (Phase 5 of
 * docs/todo-auth-cookies-tracking.md). The pure rules, classification map and
 * financial-field guard live in lib/customer-profile-rules.ts; this file only
 * reads them and the database.
 *
 * Read-time composition over the existing Postgres — not a new table and not a
 * third-party CDP, since routing financial behavioral data through another
 * processor is exactly what plan §5.1 rules out.
 */
import sql from "@/lib/db";
import {
  assertNoFinancialFields,
  deriveSegments,
  type CustomerProfile,
} from "@/lib/customer-profile-rules";

export * from "@/lib/customer-profile-rules";

async function count(query: string, userId: string): Promise<number> {
  try {
    const rows = await sql.query(query, [userId]);
    return (rows[0] as { n: number } | undefined)?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Compose the profile for one user. Read-only; degrades to zeros rather than
 * throwing, matching the posture of app/api/privacy/profile.
 */
export async function buildCustomerProfile(
  userId: string,
  opts: { planTier?: string; isTrial?: boolean } = {},
): Promise<CustomerProfile> {
  const [councilSessions, councilDeliberations, nuaiDaysActive, watchlistSize, disclaimerAcks] =
    await Promise.all([
      count("SELECT count(*)::int AS n FROM council_sessions WHERE user_id = $1", userId),
      count(
        "SELECT COALESCE(sum(deliberations),0)::int AS n FROM council_usage WHERE user_id = $1",
        userId,
      ),
      count("SELECT count(*)::int AS n FROM nuai_usage WHERE user_id = $1", userId),
      count("SELECT count(*)::int AS n FROM watchlist_items WHERE user_id = $1", userId),
      count("SELECT count(*)::int AS n FROM disclaimer_acks WHERE user_id = $1", userId),
    ]);

  let daysSinceLastActivity: number | null = null;
  try {
    const rows = await sql.query(
      `SELECT EXTRACT(DAY FROM now() - max(created_at))::int AS n
       FROM council_sessions WHERE user_id = $1`,
      [userId],
    );
    const n = (rows[0] as { n: number | null } | undefined)?.n;
    daysSinceLastActivity = typeof n === "number" ? n : null;
  } catch {
    /* leave null */
  }

  let interestTags: string[] = [];
  try {
    const rows = await sql.query(
      "SELECT DISTINCT ticker FROM watchlist_items WHERE user_id = $1 ORDER BY ticker",
      [userId],
    );
    // Tickers the user chose to watch — an interest signal, not a holding. We
    // never learn or store how much of any of these they own.
    interestTags = (rows as Array<{ ticker: string }>).map((r) => r.ticker);
  } catch {
    /* leave empty */
  }

  let attribution: { first_touch: unknown; last_touch: unknown } | null = null;
  try {
    const rows = await sql.query(
      "SELECT first_touch, last_touch FROM user_attribution WHERE user_id = $1",
      [userId],
    );
    attribution = (rows[0] as { first_touch: unknown; last_touch: unknown } | undefined) ?? null;
  } catch {
    /* leave null */
  }

  const { segments, derivations } = deriveSegments({
    councilSessions,
    nuaiDaysActive,
    watchlistSize,
    daysSinceLastActivity,
    isTrial: opts.isTrial ?? false,
  });

  const profile: CustomerProfile = {
    user_id: userId,
    plan_tier: opts.planTier ?? "free",
    engagement: {
      council_sessions: councilSessions,
      council_deliberations: councilDeliberations,
      nuai_days_active: nuaiDaysActive,
      watchlist_size: watchlistSize,
      disclaimer_acks: disclaimerAcks,
    },
    interest_tags: interestTags,
    segments,
    segment_derivations: derivations,
    attribution,
  };

  assertNoFinancialFields(profile as unknown as Record<string, unknown>);
  return profile;
}
