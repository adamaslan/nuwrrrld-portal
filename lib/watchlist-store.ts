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

export class WatchlistCapError extends Error {
  constructor() {
    super("watchlist_cap");
  }
}

/** Tickers (of `tickers`) already on the user's list. */
export async function findExistingWatchlistTickers(
  userId: string,
  tickers: readonly string[],
): Promise<Set<string>> {
  if (tickers.length === 0) return new Set();
  const rows = await sql`
    SELECT ticker FROM watchlist_items
    WHERE user_id = ${userId} AND ticker = ANY(${tickers as string[]}::text[])
  `;
  return new Set(rows.map((r) => r.ticker as string));
}

export async function countWatchlist(userId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM watchlist_items WHERE user_id = ${userId}`;
  return rows[0].n as number;
}

/**
 * Bulk insert. A per-user advisory lock statement runs first in the same
 * transaction; the insert is its own READ COMMITTED statement, so its cap
 * subquery sees any import that held the lock before it. The cap guard is
 * all-or-nothing: if it fails, nothing is inserted and WatchlistCapError is
 * thrown. Returns only the tickers actually inserted.
 */
export async function addManyToWatchlist(
  userId: string,
  tickers: readonly string[],
  cap: number,
): Promise<string[]> {
  if (tickers.length === 0) return [];
  const list = tickers as string[];
  const [, inserted] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtext(${"watchlist:" + userId}))`,
    sql`
      INSERT INTO watchlist_items (user_id, ticker)
      SELECT ${userId}, t FROM unnest(${list}::text[]) AS t
      WHERE (SELECT count(*) FROM watchlist_items WHERE user_id = ${userId}) + cardinality(${list}::text[]) <= ${cap}
      ON CONFLICT (user_id, ticker) DO NOTHING
      RETURNING ticker
    `,
  ]);
  if (inserted.length === 0) throw new WatchlistCapError();
  return inserted.map((r) => r.ticker as string);
}
