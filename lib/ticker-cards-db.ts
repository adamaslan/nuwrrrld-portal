/**
 * ticker-cards-db — read/write access to `ticker_universe` and `ticker_cards`,
 * the full-universe signal layer.
 *
 * The point of this table: a token card costs no model quota, so coverage stops
 * competing with AI spend. Every active ticker can carry a dated, source-traced,
 * machine-rankable card, and the model is spent only on the top of the ranking
 * (docs/max-coverage-simplest-path.md).
 *
 * Same defensive contract as precomputed-ai-db.ts: reads degrade to empty
 * rather than throwing, so an un-migrated table means "no cards yet" instead of
 * a 500. Writes are the exception — the ingest route needs to know a batch
 * failed, so `upsertCards` reports per-row outcomes rather than swallowing them.
 *
 * Pure logic lives in lib/shared/card-policy.ts; this module is I/O only.
 */
import sql from "@/lib/db";
import {
  shouldReplaceCard,
  type CardUniverse,
  type TickerCard,
} from "@/lib/shared/card-policy";
import type { Horizon } from "@/lib/grounding/taxonomy";
import type { UniverseScope } from "@/lib/shared/universe-policy";

export interface StoredCard extends TickerCard {
  source: string;
  sourceRunId: string | null;
  barDate: string;
  computedAt: string;
}

export interface UpsertOutcome {
  ticker: string;
  /** `written` — the card is now stored. `skipped` — an existing card was
   *  better (newer bar, or same bar at higher quality) and was preserved.
   *  `failed` — the write itself errored. The three are kept distinct because
   *  a skip is a *correct* outcome and must never be reported as a failure. */
  outcome: "written" | "skipped" | "failed";
  reason?: string;
}

/** Ranked read for the explain batch and any top-N UI. */
export interface RankedCard extends StoredCard {
  /** Tier-0 grounding rule count for this card's state, via the state_key
   *  join. Zero means the pack has no compiled entry for this state yet. */
  groundingHits: number;
}

/**
 * Active tickers, optionally scoped to one universe. Returns [] on any DB
 * failure — a hydration run with no universe to walk should report zero
 * coverage, not crash the scheduler.
 */
export async function listActiveTickers(
  universe?: CardUniverse,
  limit = 10_000,
): Promise<string[]> {
  try {
    const rows = universe
      ? await sql`
          SELECT ticker FROM ticker_universe
          WHERE active AND universe = ${universe}
          ORDER BY ticker LIMIT ${limit}
        `
      : await sql`
          SELECT ticker FROM ticker_universe
          WHERE active ORDER BY ticker LIMIT ${limit}
        `;
    return rows.map((r) => r.ticker as string);
  } catch (err) {
    console.error(`[ticker-cards] listActiveTickers failed: ${errMsg(err)}`);
    return [];
  }
}

/**
 * Register tickers in the universe. Idempotent — re-registering an existing
 * ticker refreshes its name/active flag without disturbing its cards.
 */
export async function upsertUniverse(
  entries: { ticker: string; universe: CardUniverse; name?: string }[],
): Promise<number> {
  if (entries.length === 0) return 0;
  let written = 0;
  for (const entry of entries) {
    try {
      await sql`
        INSERT INTO ticker_universe (ticker, universe, name, active)
        VALUES (${entry.ticker}, ${entry.universe}, ${entry.name ?? null}, true)
        ON CONFLICT (ticker) DO UPDATE
          SET universe = EXCLUDED.universe,
              name     = COALESCE(EXCLUDED.name, ticker_universe.name),
              active   = true
      `;
      written += 1;
    } catch (err) {
      console.error(`[ticker-cards] upsertUniverse ${entry.ticker} failed: ${errMsg(err)}`);
    }
  }
  return written;
}

/**
 * Upsert a batch of cards, one row at a time so a single bad symbol degrades to
 * one `failed` outcome instead of rolling back the whole night's coverage.
 *
 * The replacement rule lives in `shouldReplaceCard` and is enforced here in SQL
 * as well as in code — the WHERE clause on the DO UPDATE makes the guarantee
 * hold even if two hydration runs race. Without it, a slow run carrying stale
 * bars could overwrite a fast run's fresh ones purely on write order.
 */
export async function upsertCards(
  cards: StoredCard[],
): Promise<UpsertOutcome[]> {
  const outcomes: UpsertOutcome[] = [];

  for (const card of cards) {
    try {
      const rows = await sql`
        INSERT INTO ticker_cards (
          ticker, horizon, universe, state_key, taxonomy_version,
          score, score_version, action, tokens, numerics,
          data_quality, missing_fields, source, source_run_id, bar_date
        ) VALUES (
          ${card.ticker}, ${card.horizon}, ${card.universe}, ${card.stateKey},
          ${card.taxonomyVersion}, ${card.score}, ${card.scoreVersion}, ${card.action},
          ${JSON.stringify(card.tokens)}::jsonb, ${JSON.stringify({})}::jsonb,
          ${card.dataQuality}, ${card.missingFields}, ${card.source},
          ${card.sourceRunId}, ${card.barDate}
        )
        ON CONFLICT (ticker, horizon) DO UPDATE SET
          universe         = EXCLUDED.universe,
          state_key        = EXCLUDED.state_key,
          taxonomy_version = EXCLUDED.taxonomy_version,
          score            = EXCLUDED.score,
          score_version    = EXCLUDED.score_version,
          action           = EXCLUDED.action,
          tokens           = EXCLUDED.tokens,
          data_quality     = EXCLUDED.data_quality,
          missing_fields   = EXCLUDED.missing_fields,
          source           = EXCLUDED.source,
          source_run_id    = EXCLUDED.source_run_id,
          bar_date         = EXCLUDED.bar_date,
          computed_at      = now()
        WHERE EXCLUDED.bar_date > ticker_cards.bar_date
           OR (EXCLUDED.bar_date = ticker_cards.bar_date
               AND EXCLUDED.data_quality > ticker_cards.data_quality)
        RETURNING ticker
      `;
      // No returned row means the WHERE guard refused the update — the stored
      // card was as good or better. That is a skip, not a failure.
      outcomes.push({ ticker: card.ticker, outcome: rows.length ? "written" : "skipped" });
    } catch (err) {
      outcomes.push({ ticker: card.ticker, outcome: "failed", reason: errMsg(err) });
    }
  }

  return outcomes;
}

/**
 * Top-N ranked cards for one horizon, with their Tier-0 grounding hit count.
 *
 * This query *is* the ranking API an earlier draft proposed building as an
 * endpoint. The partial index on `data_quality >= 0.8` means the quality gate
 * costs nothing to apply.
 *
 * `universe` defaults to `'stock'`, and that default is load-bearing rather
 * than cosmetic. The card score is a directional read on a price series, and
 * an inverse or leveraged ETF's series is the *negation* of the exposure its
 * name implies: SQQQ rising is the Nasdaq falling. Ranking those beside
 * equities produced a top-100 that was 71% ETFs, recommending a 2x inverse
 * MicroStrategy fund as a BUY next to JNJ — technically a correct reading of
 * the series, and a meaningless recommendation. Pass `'etf'` to rank funds
 * against each other, or `'all'` deliberately when the mix is what you want.
 */
export async function topCards(
  horizon: Horizon,
  limit = 100,
  universe: UniverseScope = "stock",
): Promise<RankedCard[]> {
  try {
    const rows = await sql`
      SELECT c.*, COUNT(g.state_key) AS grounding_hits
        FROM ticker_cards c
        LEFT JOIN grounding_pack g
               ON g.state_key = c.state_key
              -- Matching on version too, not just the key: the pack carries its
              -- own taxonomy_version, and a bump changes what a state *means*.
              -- Joining on the key alone would pair new cards with rules
              -- compiled against the old bucket boundaries — a silent mismatch
              -- that reads as perfectly good grounding.
              AND g.taxonomy_version = c.taxonomy_version
        WHERE c.horizon = ${horizon}
          AND c.data_quality >= 0.8
          AND c.missing_fields = '{}'
          AND (${universe} = 'all' OR c.universe = ${universe})
        GROUP BY c.ticker, c.horizon
        ORDER BY c.score DESC, c.computed_at DESC
        LIMIT ${limit}
    `;
    return rows.map(rowToRanked);
  } catch (err) {
    console.error(`[ticker-cards] topCards failed: ${errMsg(err)}`);
    return [];
  }
}

/**
 * Coverage for one bar date: how many active tickers have a card computed from
 * that date's bars. The number the nightly run is judged on — a run that
 * "succeeded" while covering 12% of the universe should not read as green.
 */
export async function coverageForDate(
  barDate: string,
): Promise<{ covered: number; active: number; ratio: number }> {
  try {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*) FROM ticker_universe WHERE active) AS active,
        (SELECT COUNT(DISTINCT ticker) FROM ticker_cards
          WHERE bar_date = ${barDate}) AS covered
    `;
    const active = Number(rows[0]?.active ?? 0);
    const covered = Number(rows[0]?.covered ?? 0);
    return { covered, active, ratio: active === 0 ? 0 : covered / active };
  } catch (err) {
    console.error(`[ticker-cards] coverageForDate failed: ${errMsg(err)}`);
    return { covered: 0, active: 0, ratio: 0 };
  }
}

/** Stored card for one ticker+horizon, or null. Used to apply
 *  `shouldReplaceCard` in code paths that need the decision before writing. */
export async function getCard(ticker: string, horizon: Horizon): Promise<StoredCard | null> {
  try {
    const rows = await sql`
      SELECT * FROM ticker_cards
       WHERE ticker = ${ticker} AND horizon = ${horizon} LIMIT 1
    `;
    return rows.length ? rowToStored(rows[0]) : null;
  } catch {
    return null;
  }
}

/** Re-exported so callers deciding a write can share the ingest rule. */
export { shouldReplaceCard };

/**
 * A Postgres `date` column as a `YYYY-MM-DD` string.
 *
 * The driver hands back a JS `Date` for `date` columns, and `String(date)`
 * renders it in **local** time — so `String(d).slice(0, 10)` produced
 * `"Tue Aug 18"` for a bar dated 2026-08-19: not merely a formatting slip but
 * an off-by-one day for anyone west of UTC, and a string no date parser
 * accepts. `bar_date` is a calendar date with no time component, so it is read
 * back in UTC, where the driver placed it.
 *
 * Strings pass through untouched — some call paths hand this a value that is
 * already `YYYY-MM-DD`, and re-parsing those through `Date` would reintroduce
 * exactly the timezone shift this exists to avoid.
 */
function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  return String(value ?? "").slice(0, 10);
}

function rowToStored(row: Record<string, unknown>): StoredCard {
  return {
    ticker: row.ticker as string,
    universe: row.universe as CardUniverse,
    horizon: row.horizon as Horizon,
    stateKey: row.state_key as string,
    taxonomyVersion: row.taxonomy_version as string,
    tokens: row.tokens as StoredCard["tokens"],
    score: Number(row.score),
    scoreVersion: row.score_version as string,
    action: row.action as StoredCard["action"],
    dataQuality: Number(row.data_quality),
    missingFields: (row.missing_fields as StoredCard["missingFields"]) ?? [],
    source: row.source as string,
    sourceRunId: (row.source_run_id as string | null) ?? null,
    barDate: toIsoDate(row.bar_date),
    computedAt: String(row.computed_at),
  };
}

function rowToRanked(row: Record<string, unknown>): RankedCard {
  return { ...rowToStored(row), groundingHits: Number(row.grounding_hits ?? 0) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
