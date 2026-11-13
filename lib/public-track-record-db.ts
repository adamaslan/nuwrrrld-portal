import { buildPublicTrackRecord, type PublicTrackRecord } from "@/lib/public-track-record";

/**
 * Reads the scoreboard. Null when nothing is scored, or when the read or the
 * DB module itself failed. The import is lazy on purpose: lib/db throws at
 * import time when DATABASE_URL is unset, and this page is prerendered, so a
 * build without a database must fall back to the empty state, not fail.
 */
export async function getPublicTrackRecord(): Promise<PublicTrackRecord | null> {
  try {
    const { getAllScores } = await import("@/lib/followed-tickers-db");
    const rows = await getAllScores();
    return buildPublicTrackRecord(
      rows.map((r) => ({
        horizon: r.horizon,
        outcome: r.outcome,
        directional: r.directional,
        resolvedOn: r.resolvedOn,
      })),
    );
  } catch {
    return null;
  }
}
