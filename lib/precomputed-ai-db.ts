/**
 * precomputed-ai-db — read/write access to the `precomputed_ai` table.
 *
 * Option D of docs/gha-modal-core-feature-coverage.md: batch AI work is
 * generated off-request by a scheduled job that runs just after OpenRouter's
 * UTC-midnight free-tier reset, when the daily quota is fresh. Routes then
 * serve those rows as ordinary cached reads, costing **zero model quota at
 * request time** — leaving the whole daily allowance for interactive calls
 * (Nu AI chat) that genuinely cannot be precomputed.
 *
 * Same defensive contract as digest-cache-db.ts: every function is
 * try/catch → null/no-op, so an unreachable DB or an un-migrated table
 * degrades to "no precomputed value" (the caller then does its normal live
 * fetch) rather than throwing. Safe to deploy before `npm run db:migrate`.
 */
import sql from "@/lib/db";

// Re-exported so existing importers keep resolving it here; its canonical
// home is the dependency-free policy module (unit-testable without a DB).
export { subjectFromTickers } from "@/lib/shared/precompute-policy";

/** Artifact types the precompute job produces. Extend deliberately — each
 *  new kind needs a producer in the job and a consumer in a route. */
export type PrecomputedKind = "portfolio_health_ai" | "digest_commentary";

export interface PrecomputedRecord<T = unknown> {
  payload: T;
  model: string | null;
  generatedAt: string;
  /** Age in minutes at read time — routes use this to label staleness in the
   *  UI rather than silently presenting old commentary as current, per
   *  docs/wiki-portal/concept-graceful-degradation.md. */
  ageMinutes: number;
}

/**
 * Read one precomputed artifact. Returns null when absent, expired, or the
 * DB is unreachable — all three mean "fall back to the live path."
 */
export async function getPrecomputed<T>(
  kind: PrecomputedKind,
  subject: string,
): Promise<PrecomputedRecord<T> | null> {
  try {
    const rows = await sql`
      SELECT payload, model, generated_at
      FROM precomputed_ai
      WHERE kind = ${kind}
        AND subject = ${subject}
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    if (!rows.length) return null;
    const generatedAt = rows[0].generated_at as string;
    return {
      payload: rows[0].payload as T,
      model: (rows[0].model as string | null) ?? null,
      generatedAt,
      ageMinutes: Math.max(0, Math.round((Date.now() - new Date(generatedAt).getTime()) / 60_000)),
    };
  } catch (err) {
    console.error(
      `[precomputed-ai] read failed kind=${kind} subject=${subject} ` +
      `err=${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Upsert one artifact. Keyed on (kind, subject) so the table holds exactly one
 * row per pair and never grows without bound as the job re-runs nightly.
 */
export async function savePrecomputed(
  kind: PrecomputedKind,
  subject: string,
  payload: unknown,
  model: string | null,
  expiresAt: Date | null = null,
): Promise<boolean> {
  try {
    await sql`
      INSERT INTO precomputed_ai (kind, subject, payload, model, generated_at, expires_at)
      VALUES (${kind}, ${subject}, ${JSON.stringify(payload)}, ${model}, now(), ${expiresAt})
      ON CONFLICT (kind, subject) DO UPDATE
        SET payload = EXCLUDED.payload,
            model = EXCLUDED.model,
            generated_at = EXCLUDED.generated_at,
            expires_at = EXCLUDED.expires_at
    `;
    return true;
  } catch (err) {
    console.error(
      `[precomputed-ai] write failed kind=${kind} subject=${subject} ` +
      `err=${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * The distinct ticker sets worth precomputing: one row per user who has a
 * watchlist, collapsed to distinct sorted ticker strings. Users with identical
 * watchlists share a single artifact — the payload is not user-specific, so
 * generating it per user would multiply quota spend for identical output.
 */
export async function listWatchlistSubjects(limit = 100): Promise<string[]> {
  try {
    const rows = await sql`
      SELECT DISTINCT subject FROM (
        SELECT string_agg(DISTINCT upper(ticker), ',' ORDER BY upper(ticker)) AS subject
        FROM watchlist_items
        GROUP BY user_id
      ) s
      WHERE subject IS NOT NULL
      LIMIT ${limit}
    `;
    return rows.map((r) => r.subject as string).filter(Boolean);
  } catch (err) {
    console.error(
      `[precomputed-ai] subject listing failed err=${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
