/**
 * Tier-ladder resolver — the four-tier search hierarchy that makes grounding
 * deterministic and zero-cost at request time.
 *
 * Tiers are tried in order; the first one that succeeds is used:
 *   - Tier 0: SQL join on state_key (compiled pack lookup) — ~5 ms
 *   - Tier 1: Full-text search over corpus_chunks body — ~15 ms
 *   - Tier 2: FTS over doc2query search_terms expansion — ~15 ms
 *   - miss: No tier answered → honest ungrounded status, log to grounding_misses
 *
 * Zero model calls, zero embedding roundtrips. Everything runs on the same
 * Neon connection that already fetches hit-rates and prior verdicts.
 */

import sql from "@/lib/db";
import { toStateKey, type SignalStateInput, type Horizon } from "./taxonomy";

export interface GroundingRule {
  ruleText: string;
  quote: string;
  chunkId: string;
  sourceFile: string;
  tags: string[];
  confidence: number;
  direction: "bullish" | "bearish" | "neutral" | null;
}

export interface GroundingResult {
  tier: 0 | 1 | 2 | null; // null = miss
  coverage: number; // 0-1, percentage of rules with citations
  rules: GroundingRule[];
  corpusVersion: string;
  taxonomyVersion: string;
  degraded?: boolean; // true if corpus_version lags current
}

const TIER0_MIN_RULES = 3;
const TIER0_MIN_SOURCE_FILES = 2;
const FTS_RANK_THRESHOLD = 0.1;

/**
 * Tier 0 — compiled pack lookup by state_key.
 * Fast, deterministic, zero model calls — but only works if the signal state
 * exists in the pre-compiled pack. Returns null if no match.
 */
async function resolveTier0(
  stateKey: string,
  horizon: Horizon,
  traderFilter: string | null,
  directionFilter: "bullish" | "bearish" | "neutral" | null = null,
): Promise<GroundingResult | null> {
  try {
    // Joins corpus_chunks in the same query so trader_filter is available
    // for the in-memory filter below without a per-row follow-up query.
    const rows = directionFilter
      ? await sql`
          SELECT
            gp.rule_text, gp.quote, gp.chunk_id, gp.source_file, gp.tags,
            gp.confidence, gp.direction, gp.corpus_version, gp.taxonomy_version,
            cc.trader_filter
          FROM grounding_pack gp
          LEFT JOIN corpus_chunks cc ON cc.chunk_id = gp.chunk_id
          WHERE gp.state_key = ${stateKey}
            AND gp.horizon = ${horizon}
            AND gp.direction = ${directionFilter}
        `
      : await sql`
          SELECT
            gp.rule_text, gp.quote, gp.chunk_id, gp.source_file, gp.tags,
            gp.confidence, gp.direction, gp.corpus_version, gp.taxonomy_version,
            cc.trader_filter
          FROM grounding_pack gp
          LEFT JOIN corpus_chunks cc ON cc.chunk_id = gp.chunk_id
          WHERE gp.state_key = ${stateKey}
            AND gp.horizon = ${horizon}
        `;

    if (!rows.length) return null;

    // Filter by trader_filter if specified (T1 or T2) — trader_filter came
    // back on the same joined row above, so this is an in-memory filter, not
    // a second query per row (that N+1 pattern was flagged in PR #37 review).
    const validRows = rows.filter((row) => {
      const chunkTraderFilter = row.trader_filter as string | null;
      return !(traderFilter && chunkTraderFilter && chunkTraderFilter !== traderFilter);
    });
    if (validRows.length < TIER0_MIN_RULES) return null;

    // Check source file diversity
    const sourceFiles = new Set(validRows.map((r) => r.source_file));
    if (sourceFiles.size < TIER0_MIN_SOURCE_FILES) return null;

    const rules: GroundingRule[] = validRows.map((row) => ({
      ruleText: row.rule_text as string,
      quote: row.quote as string,
      chunkId: row.chunk_id as string,
      sourceFile: row.source_file as string,
      tags: (row.tags as string[]) ?? [],
      confidence: row.confidence as number,
      direction: (row.direction as "bullish" | "bearish" | "neutral" | null) ?? null,
    }));

    return {
      tier: 0,
      coverage: 1.0,
      rules,
      corpusVersion: validRows[0].corpus_version as string,
      taxonomyVersion: validRows[0].taxonomy_version as string,
    };
  } catch {
    return null;
  }
}

/**
 * Tier 1 — full-text search over corpus_chunks.body.
 * Uses Postgres tsvector with English stemming. Covers free-form questions
 * that don't map to a pre-compiled state_key.
 */
async function resolveTier1(
  question: string,
  horizon: Horizon,
  traderFilter: string | null,
): Promise<GroundingResult | null> {
  try {
    // websearch_to_tsquery requires PG 11+ and allows OR/AND/NOT syntax.
    // `question` and `traderFilter` come from user input — use the
    // parameterized `sql` tag (not sql.unsafe with string interpolation,
    // which was a SQL injection vector flagged in PR #37 review).
    const rows = (await sql`
      SELECT
        chunk_id,
        source_file,
        tags,
        body,
        ts_rank(tsv, websearch_to_tsquery('english', ${question})) as rank
      FROM corpus_chunks
      WHERE tsv @@ websearch_to_tsquery('english', ${question})
        AND (trader_filter IS NULL OR trader_filter = ${traderFilter} OR trader_filter = 'ALL')
      ORDER BY rank DESC
      LIMIT 6
    `) as unknown as Array<{
      chunk_id: string;
      source_file: string;
      tags: string[];
      body: string;
      rank: number;
    }>;

    if (!rows.length || rows[0].rank < FTS_RANK_THRESHOLD) return null;

    const rules: GroundingRule[] = rows.map((row) => ({
      ruleText: row.body.slice(0, 300),
      quote: row.body.slice(0, 150),
      chunkId: row.chunk_id,
      sourceFile: row.source_file,
      tags: row.tags ?? [],
      confidence: row.rank,
      direction: null,
    }));

    return {
      tier: 1,
      coverage: rules.length / Math.max(rules.length, 1),
      rules,
      corpusVersion: "tier-1-fts",
      taxonomyVersion: "tier-1-fts",
    };
  } catch {
    return null;
  }
}

/**
 * Tier 2 — FTS over doc2query search_terms expansion.
 * Same as Tier 1 but queries the doc2query-synthesized search_terms field,
 * catching paraphrases that Tier 1 might miss. Still zero model calls,
 * all at compile time (doc2query happens during the weekly compile job).
 */
async function resolveTier2(
  question: string,
  horizon: Horizon,
  traderFilter: string | null,
): Promise<GroundingResult | null> {
  try {
    // Same injection fix as Tier 1 — parameterized `sql` tag, not sql.unsafe.
    const rows = (await sql`
      SELECT
        chunk_id,
        source_file,
        tags,
        body,
        ts_rank(tsv, websearch_to_tsquery('english', ${question})) as rank
      FROM corpus_chunks
      WHERE (websearch_to_tsquery('english', ${question}) @@ to_tsvector('english', array_to_string(search_terms, ' ')))
        AND (trader_filter IS NULL OR trader_filter = ${traderFilter} OR trader_filter = 'ALL')
      ORDER BY rank DESC
      LIMIT 6
    `) as unknown as Array<{
      chunk_id: string;
      source_file: string;
      tags: string[];
      body: string;
      rank: number;
    }>;

    if (!rows.length || rows[0].rank < FTS_RANK_THRESHOLD) return null;

    const rules: GroundingRule[] = rows.map((row) => ({
      ruleText: row.body.slice(0, 300),
      quote: row.body.slice(0, 150),
      chunkId: row.chunk_id,
      sourceFile: row.source_file,
      tags: row.tags ?? [],
      confidence: row.rank,
      direction: null,
    }));

    return {
      tier: 2,
      coverage: rules.length / Math.max(rules.length, 1),
      rules,
      corpusVersion: "tier-2-fts-expanded",
      taxonomyVersion: "tier-2-fts-expanded",
    };
  } catch {
    return null;
  }
}

/**
 * Log a grounding miss to the curation queue.
 * These logs tell us what the corpus should contain next.
 */
async function logMiss(
  question: string,
  ticker: string | null,
  stateKeys: string[],
): Promise<void> {
  try {
    await sql`
      INSERT INTO grounding_misses (question, ticker, state_keys)
      VALUES (${question}, ${ticker}, ${stateKeys})
    `;
  } catch {
    // Failures here are non-fatal — the session succeeds but we lose the curation signal.
  }
}

/**
 * Resolve grounding through all four tiers.
 * Returns the first tier that succeeds, or a null-tier result if all miss.
 */
export async function resolveGrounding(
  question: string,
  signals: SignalStateInput | null,
  horizon: Horizon,
  ticker: string | null,
  traderFilter: string | null = null,
  directionFilter: "bullish" | "bearish" | "neutral" | null = null,
): Promise<GroundingResult> {
  // Tier 0: compiled pack lookup (if signals available)
  if (signals) {
    const stateKey = toStateKey(signals, horizon);
    const tier0 = await resolveTier0(stateKey, horizon, traderFilter, directionFilter);
    if (tier0) return tier0;
  }

  // Tier 1: full-text search over body
  const tier1 = await resolveTier1(question, horizon, traderFilter);
  if (tier1) return tier1;

  // Tier 2: FTS over doc2query search_terms
  const tier2 = await resolveTier2(question, horizon, traderFilter);
  if (tier2) return tier2;

  // All miss — log to curation queue
  const stateKeys = signals ? [toStateKey(signals, horizon)] : [];
  await logMiss(question, ticker, stateKeys);

  return {
    tier: null,
    coverage: 0,
    rules: [],
    corpusVersion: "none",
    taxonomyVersion: "none",
  };
}
