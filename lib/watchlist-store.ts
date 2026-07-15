/**
 * Watchlist persistence — Neon-backed (replaces the in-memory Map that wiped
 * every user's watchlist on each deploy/cold start; see lib/db/schema.sql's
 * watchlist_items table, added by the 2026-07-15 audit).
 *
 * Unlike the digest/holdfold caches, this is primary user data, not a cache —
 * so callers propagate errors (503) instead of silently degrading.
 */
import sql from "@/lib/db";
import type { WatchlistItem } from "@/lib/portfolio";

export async function getWatchlist(userId: string): Promise<WatchlistItem[]> {
  const rows = await sql`
    SELECT ticker, added_at
    FROM watchlist_items
    WHERE user_id = ${userId}
    ORDER BY added_at ASC
  `;
  return rows.map((r) => ({
    ticker: r.ticker as string,
    addedAt: new Date(r.added_at as string).toISOString(),
  }));
}

export async function addToWatchlist(
  userId: string,
  ticker: string,
): Promise<WatchlistItem | "exists"> {
  const existing = await sql`
    SELECT 1 FROM watchlist_items WHERE user_id = ${userId} AND ticker = ${ticker}
  `;
  if (existing.length > 0) return "exists";

  const rows = await sql`
    INSERT INTO watchlist_items (user_id, ticker)
    VALUES (${userId}, ${ticker})
    ON CONFLICT (user_id, ticker) DO NOTHING
    RETURNING added_at
  `;
  if (!rows.length) return "exists";
  return { ticker, addedAt: new Date(rows[0].added_at as string).toISOString() };
}

export async function removeFromWatchlist(userId: string, ticker: string): Promise<void> {
  await sql`DELETE FROM watchlist_items WHERE user_id = ${userId} AND ticker = ${ticker}`;
}
