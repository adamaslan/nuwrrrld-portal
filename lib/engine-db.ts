/**
 * engine-db — the only lib/engine* module that touches Neon. Bars and engine_*
 * rows move in bulk (unnest arrays, one statement per batch), because a nightly
 * run writes ~4,000 tickers and a per-row round trip would not fit in a function.
 */
import sql from "@/lib/db";
import type { Bar } from "@/lib/engine";
import type { BarAdjustment, BarFeed, BarRow } from "@/lib/shared/engine-bars";
import type { SnapshotHit, TickerSnapshot } from "@/lib/engine/snapshot";
import { DIRECTIONAL_STRENGTHS, sideForStrength, type HitLabel } from "@/lib/engine/labels";

export interface StoredSeries {
  ticker: string;
  dates: string[];
  bars: Bar[];
}

/**
 * Inserts new bars and rewrites a stored bar only when its values changed, so
 * `fetched_at` is the time the row's content last changed. engine-bars refetches
 * a trailing overlap every run; an unchanged refetch must not look like new data
 * to coveringRun(). Returns the number of rows accepted, changed or not.
 */
export async function upsertBars(
  rows: readonly BarRow[],
  meta: { feed: BarFeed; adjustment: BarAdjustment; source: string },
): Promise<number> {
  if (rows.length === 0) return 0;
  // SET LOCAL caps this one statement (observed runs take seconds) and ends with
  // the transaction; a timeout rolls the whole batch back and the caller fails.
  await sql.transaction([
    sql`SET LOCAL statement_timeout = '5min'`,
    sql`
    INSERT INTO daily_bars (ticker, bar_date, open, high, low, close, volume, feed, adjustment, source)
    SELECT t, d::date, o, h, l, c, v, ${meta.feed}::text, ${meta.adjustment}::text, ${meta.source}::text
    FROM unnest(
      ${rows.map((r) => r.ticker)}::text[], ${rows.map((r) => r.barDate)}::text[],
      ${rows.map((r) => r.open)}::float8[], ${rows.map((r) => r.high)}::float8[],
      ${rows.map((r) => r.low)}::float8[], ${rows.map((r) => r.close)}::float8[],
      ${rows.map((r) => r.volume)}::float8[]
    ) AS x(t, d, o, h, l, c, v)
    ON CONFLICT (ticker, feed, bar_date) DO UPDATE SET
      open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close,
      volume = EXCLUDED.volume, adjustment = EXCLUDED.adjustment, source = EXCLUDED.source,
      fetched_at = now()
    WHERE (daily_bars.open, daily_bars.high, daily_bars.low, daily_bars.close, daily_bars.volume,
           daily_bars.adjustment, daily_bars.source)
      IS DISTINCT FROM (EXCLUDED.open, EXCLUDED.high, EXCLUDED.low, EXCLUDED.close, EXCLUDED.volume,
                        EXCLUDED.adjustment, EXCLUDED.source)
  `,
  ]);
  return rows.length;
}

export async function latestBarDates(): Promise<Record<string, string | null>> {
  const rows = await sql`SELECT feed, max(bar_date)::text AS latest FROM daily_bars GROUP BY feed`;
  return Object.fromEntries(rows.map((r) => [r.feed as string, (r.latest as string) ?? null]));
}

export async function listEngineTickers(offset: number, limit: number): Promise<string[]> {
  const rows = await sql`
    SELECT ticker FROM ticker_universe WHERE active ORDER BY ticker OFFSET ${offset} LIMIT ${limit}
  `;
  return rows.map((r) => r.ticker as string);
}

export async function countEngineTickers(): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS n FROM ticker_universe WHERE active`;
  return (rows[0]?.n as number) ?? 0;
}

/** The last `maxBars` bars per ticker, oldest first. */
export async function loadSeries(
  tickers: readonly string[],
  feed: BarFeed,
  maxBars: number,
): Promise<StoredSeries[]> {
  if (tickers.length === 0) return [];
  const rows = await sql`
    SELECT ticker, bar_date::text AS d, open, high, low, close, volume FROM (
      SELECT *, row_number() OVER (PARTITION BY ticker ORDER BY bar_date DESC) AS rn
      FROM daily_bars WHERE ticker = ANY(${tickers as string[]}) AND feed = ${feed}
    ) s WHERE rn <= ${maxBars} ORDER BY ticker, bar_date
  `;
  const byTicker = new Map<string, StoredSeries>();
  for (const r of rows) {
    const t = r.ticker as string;
    const series = byTicker.get(t) ?? { ticker: t, dates: [], bars: [] };
    series.dates.push(r.d as string);
    series.bars.push({ open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume } as Bar);
    byTicker.set(t, series);
  }
  return [...byTicker.values()];
}

export async function startRun(
  id: string,
  meta: { codeVersion: string; mode: "shadow" | "live"; feed: BarFeed },
): Promise<void> {
  // detail.universe fingerprints the active set the run's offsets page over;
  // markRunComplete and coveringRun compare against it.
  await sql`
    INSERT INTO engine_runs (id, code_version, mode, feed, detail)
    VALUES (${id}::text, ${meta.codeVersion}::text, ${meta.mode}::text, ${meta.feed}::text,
      jsonb_build_object('universe',
        (SELECT md5(coalesce(string_agg(ticker, ',' ORDER BY ticker), '')) FROM ticker_universe WHERE active)))
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Called after the last chunk. Marks the run complete only if the active set is
 * still the one it started paging over; a mid-run universe change can shift
 * offsets and skip or repeat tickers, so such a run never becomes complete.
 */
export async function markRunComplete(id: string): Promise<void> {
  await sql`
    UPDATE engine_runs SET detail = detail || '{"complete": true}'::jsonb, updated_at = now()
    WHERE id = ${id} AND detail->>'universe' =
      (SELECT md5(coalesce(string_agg(ticker, ',' ORDER BY ticker), '')) FROM ticker_universe WHERE active)
  `;
}

export interface CoveringRun {
  id: string;
  barDate: string;
}

/**
 * The newest finished shadow run that already computed from the bars stored now,
 * or null when a recompute is needed. Fails open: a run only counts when it has
 * the same code version and feed, was marked complete over the same active set
 * as now, reported every active ticker with no failures, and started after the
 * newest bar change.
 * Assumes daily_bars writes are not concurrent with the run (engine-nightly's
 * concurrency group runs the bar fetch, then the engine, one workflow at a time).
 */
export async function coveringRun(feed: BarFeed, codeVersion: string): Promise<CoveringRun | null> {
  const rows = await sql`
    SELECT r.id, r.bar_date::text AS bar_date FROM engine_runs r
    WHERE r.mode = 'shadow' AND r.feed = ${feed} AND r.code_version = ${codeVersion}
      AND r.bar_date IS NOT NULL AND r.tickers_failed = 0
      AND r.tickers_ok + r.tickers_skipped + r.tickers_failed =
          (SELECT count(*) FROM ticker_universe WHERE active)
      AND r.started_at > (SELECT max(fetched_at) FROM daily_bars WHERE feed = ${feed})
      AND r.detail->>'complete' = 'true'
      AND r.detail->>'universe' =
          (SELECT md5(coalesce(string_agg(ticker, ',' ORDER BY ticker), '')) FROM ticker_universe WHERE active)
    ORDER BY r.started_at DESC LIMIT 1
  `;
  const r = rows[0];
  return r ? { id: r.id as string, barDate: r.bar_date as string } : null;
}

export interface RunDelta {
  ok: number;
  skipped: number;
  failed: number;
  degraded: number;
  hits: number;
  barDate: string | null;
}

export async function bumpRun(id: string, d: RunDelta): Promise<void> {
  await sql`
    UPDATE engine_runs SET
      tickers_ok = tickers_ok + ${d.ok}, tickers_skipped = tickers_skipped + ${d.skipped},
      tickers_failed = tickers_failed + ${d.failed}, degraded_n = degraded_n + ${d.degraded},
      hits_n = hits_n + ${d.hits},
      bar_date = GREATEST(bar_date, ${d.barDate}::date), updated_at = now()
    WHERE id = ${id}
  `;
}

export interface SnapshotWrite {
  ticker: string;
  barDate: string;
  snapshot: TickerSnapshot;
}

export async function writeSnapshots(
  writes: readonly SnapshotWrite[],
  meta: { codeVersion: string; runId: string },
): Promise<void> {
  if (writes.length === 0) return;
  await sql`
    INSERT INTO engine_structure (ticker, bar_date, code_version, close, atr, legs, levels, zones,
      nearest_support, nearest_resistance, swing_anchor, swing_direction, run_id)
    SELECT t, d::date, ${meta.codeVersion}::text, c, a, lg::jsonb, lv::jsonb, z::jsonb, ns, nr, sa, sd, ${meta.runId}::text
    FROM unnest(
      ${writes.map((w) => w.ticker)}::text[], ${writes.map((w) => w.barDate)}::text[],
      ${writes.map((w) => w.snapshot.close)}::float8[], ${writes.map((w) => w.snapshot.atr)}::float8[],
      ${writes.map((w) => JSON.stringify(w.snapshot.legs))}::text[],
      ${writes.map((w) => JSON.stringify(w.snapshot.levels))}::text[],
      ${writes.map((w) => JSON.stringify(w.snapshot.zones))}::text[],
      ${writes.map((w) => w.snapshot.nearestSupport)}::float8[],
      ${writes.map((w) => w.snapshot.nearestResistance)}::float8[],
      ${writes.map((w) => w.snapshot.swingAnchor)}::text[], ${writes.map((w) => w.snapshot.swingDirection)}::text[]
    ) AS x(t, d, c, a, lg, lv, z, ns, nr, sa, sd)
    ON CONFLICT (ticker, bar_date, code_version) DO UPDATE SET
      close = EXCLUDED.close, atr = EXCLUDED.atr, legs = EXCLUDED.legs, levels = EXCLUDED.levels,
      zones = EXCLUDED.zones, nearest_support = EXCLUDED.nearest_support,
      nearest_resistance = EXCLUDED.nearest_resistance, swing_anchor = EXCLUDED.swing_anchor,
      swing_direction = EXCLUDED.swing_direction, run_id = EXCLUDED.run_id, computed_at = now()
  `;
}

export interface HitWrite extends SnapshotHit {
  ticker: string;
  barDate: string;
}

/** Existing (ticker, bar_date, detector, signal, version) rows keep their id so labels and paper orders stay attached. */
export async function writeHits(
  hits: readonly HitWrite[],
  meta: { codeVersion: string; runId: string },
): Promise<number> {
  if (hits.length === 0) return 0;
  await sql`
    INSERT INTO engine_detector_hits (ticker, bar_date, detector, signal, category, strength,
      description, experimental, features, code_version, run_id)
    SELECT t, d::date, dt, s, cat, st, ds, ex, f::jsonb, ${meta.codeVersion}::text, ${meta.runId}::text
    FROM unnest(
      ${hits.map((h) => h.ticker)}::text[], ${hits.map((h) => h.barDate)}::text[],
      ${hits.map((h) => h.detector)}::text[], ${hits.map((h) => h.signal)}::text[],
      ${hits.map((h) => h.category)}::text[], ${hits.map((h) => h.strength)}::text[],
      ${hits.map((h) => h.description)}::text[], ${hits.map((h) => h.experimental)}::bool[],
      ${hits.map((h) => JSON.stringify(h.features))}::text[]
    ) AS x(t, d, dt, s, cat, st, ds, ex, f)
    ON CONFLICT (ticker, bar_date, detector, signal, code_version) DO UPDATE SET
      strength = EXCLUDED.strength, description = EXCLUDED.description,
      features = EXCLUDED.features, run_id = EXCLUDED.run_id
  `;
  return hits.length;
}

/** Live mode: fold the fib ladder into the card's numerics for audit; never touches score or tokens. */
export async function mergeCardFibNumerics(
  writes: readonly SnapshotWrite[],
): Promise<void> {
  for (const w of writes) {
    const fib = {
      fib_levels: w.snapshot.levels,
      fib_confluence_zones: w.snapshot.zones,
      nearest_fib_support: w.snapshot.nearestSupport,
      nearest_fib_resistance: w.snapshot.nearestResistance,
    };
    await sql`
      UPDATE ticker_cards SET numerics = numerics || ${JSON.stringify({ engine_fib: fib })}::jsonb
      WHERE ticker = ${w.ticker}
    `;
  }
}

export interface PendingHit {
  id: string;
  ticker: string;
  barDate: string;
  entry: number;
  stop: number | null;
  target: number | null;
  /** Bar feed of the run that produced the hit; its later bars come from the same feed. */
  feed: string;
  side: 1 | -1;
}

/**
 * Directional hits with no label at `horizon` whose entry bar is old enough to
 * have `horizon` later bars **in the hit's own feed** (a ticker can hold both
 * iex and sip rows, and counting across them would strand a hit unlabeled).
 * The entry close comes from that same feed's bar: engine_structure is keyed
 * without feed, so a later run on another feed can overwrite its close.
 */
export async function pendingHits(horizon: number, limit: number): Promise<PendingHit[]> {
  const rows = await sql`
    SELECT h.id, h.ticker, h.bar_date::text AS d, entry_bar.close AS entry,
           (h.features->>'stop')::float8 AS stop, (h.features->>'target')::float8 AS target,
           r.feed AS feed, h.strength AS strength
    FROM engine_detector_hits h
    JOIN engine_runs r ON r.id = h.run_id
    JOIN daily_bars entry_bar
      ON entry_bar.ticker = h.ticker AND entry_bar.feed = r.feed AND entry_bar.bar_date = h.bar_date
    LEFT JOIN engine_forward_returns f ON f.hit_id = h.id AND f.horizon_days = ${horizon}
    WHERE f.hit_id IS NULL
      AND h.strength = ANY(${DIRECTIONAL_STRENGTHS as readonly string[]})
      AND (SELECT count(*) FROM daily_bars b
           WHERE b.ticker = h.ticker AND b.feed = r.feed AND b.bar_date > h.bar_date) >= ${horizon}
    ORDER BY h.bar_date LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    ticker: r.ticker as string,
    barDate: r.d as string,
    entry: r.entry as number,
    stop: (r.stop as number | null) ?? null,
    target: (r.target as number | null) ?? null,
    feed: r.feed as string,
    side: sideForStrength(r.strength as string) ?? 1,
  }));
}

export async function barsAfter(ticker: string, feed: string, date: string, count: number): Promise<Bar[]> {
  const rows = await sql`
    SELECT open, high, low, close, volume FROM daily_bars
    WHERE ticker = ${ticker} AND feed = ${feed} AND bar_date > ${date}::date
    ORDER BY bar_date LIMIT ${count}
  `;
  return rows.map((r) => ({ open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }) as Bar);
}

export async function writeLabels(labels: ReadonlyArray<{ hitId: string; label: HitLabel }>): Promise<number> {
  if (labels.length === 0) return 0;
  await sql`
    INSERT INTO engine_forward_returns (hit_id, horizon_days, pct_return, hit, outcome, r_multiple)
    SELECT * FROM unnest(
      ${labels.map((l) => l.hitId)}::uuid[], ${labels.map((l) => l.label.horizonDays)}::int[],
      ${labels.map((l) => l.label.pctReturn)}::float8[], ${labels.map((l) => l.label.hit)}::bool[],
      ${labels.map((l) => l.label.outcome)}::text[], ${labels.map((l) => l.label.rMultiple)}::float8[]
    ) ON CONFLICT (hit_id, horizon_days) DO NOTHING
  `;
  return labels.length;
}

export interface LabelDiagnostics {
  horizon: number;
  /** Unlabeled directional hits, each counted in exactly one bucket below. */
  unlabeledDirectional: number;
  /** Would be returned by pendingHits right now. */
  ready: number;
  /** Fewer than horizon later bars stored in the hit's own feed — too recent, or that feed stopped being stored. */
  awaitingBars: number;
  /** The hit's (ticker, feed, bar_date) entry bar is not stored, so the pendingHits join drops it. */
  missingEntryBar: number;
  /** run_id is null or names no engine_runs row, so the pendingHits join drops it. */
  noRunRow: number;
  /** Unlabeled hits whose strength states no direction; never label candidates. */
  unlabeledNonDirectional: number;
  /** Unlabeled directional hits grouped by their run's feed ('(no run)' when runless). */
  byFeed: Record<string, number>;
}

/**
 * Why pendingHits returns what it returns. Buckets are mutually exclusive and
 * assigned in pendingHits' join order: a hit without a run row is counted
 * there even if its entry bar is also missing. Read-only. The label route
 * calls this when a batch examines zero hits so a silent labeled=0 names its
 * cause (feed switch stranding, runless hits, missing entry bars, or simply
 * nothing old enough) in the nightly log instead of looking like success.
 */
export async function labelDiagnostics(horizon: number): Promise<LabelDiagnostics> {
  // Subqueries rather than CTEs so the statement starts with SELECT: the
  // pg test shim in __tests__/engine-db.pg.test.ts only wraps SELECTs.
  const rows = await sql`
    SELECT
      count(*) FILTER (WHERE directional)::int AS directional_total,
      count(*) FILTER (WHERE NOT directional)::int AS non_directional,
      count(*) FILTER (WHERE directional AND NOT has_run)::int AS no_run_row,
      count(*) FILTER (WHERE directional AND has_run AND NOT has_entry)::int AS missing_entry_bar,
      count(*) FILTER (WHERE directional AND has_run AND has_entry AND later_bars < ${horizon})::int AS awaiting_bars,
      count(*) FILTER (WHERE directional AND has_run AND has_entry AND later_bars >= ${horizon})::int AS ready
    FROM (
      SELECT u.*,
        (u.strength = ANY(${DIRECTIONAL_STRENGTHS as readonly string[]})) AS directional,
        EXISTS (SELECT 1 FROM daily_bars eb
                WHERE eb.ticker = u.ticker AND eb.feed = u.feed AND eb.bar_date = u.bar_date) AS has_entry,
        (SELECT count(*) FROM daily_bars b
         WHERE b.ticker = u.ticker AND b.feed = u.feed AND b.bar_date > u.bar_date) AS later_bars
      FROM (
        SELECT h.ticker, h.bar_date, h.strength, r.feed AS feed, (r.id IS NOT NULL) AS has_run
        FROM engine_detector_hits h
        LEFT JOIN engine_runs r ON r.id = h.run_id
        LEFT JOIN engine_forward_returns f ON f.hit_id = h.id AND f.horizon_days = ${horizon}
        WHERE f.hit_id IS NULL
      ) u
    ) classified
  `;
  const feedRows = await sql`
    SELECT coalesce(r.feed, '(no run)') AS feed, count(*)::int AS n
    FROM engine_detector_hits h
    LEFT JOIN engine_runs r ON r.id = h.run_id
    LEFT JOIN engine_forward_returns f ON f.hit_id = h.id AND f.horizon_days = ${horizon}
    WHERE f.hit_id IS NULL AND h.strength = ANY(${DIRECTIONAL_STRENGTHS as readonly string[]})
    GROUP BY 1 ORDER BY 2 DESC
  `;
  const r = rows[0] ?? {};
  return {
    horizon,
    unlabeledDirectional: (r.directional_total as number) ?? 0,
    ready: (r.ready as number) ?? 0,
    awaitingBars: (r.awaiting_bars as number) ?? 0,
    missingEntryBar: (r.missing_entry_bar as number) ?? 0,
    noRunRow: (r.no_run_row as number) ?? 0,
    unlabeledNonDirectional: (r.non_directional as number) ?? 0,
    byFeed: Object.fromEntries(feedRows.map((f) => [f.feed as string, f.n as number])),
  };
}

export async function latestStructure(ticker: string) {
  const rows = await sql`
    SELECT bar_date::text AS bar_date, code_version, levels, zones, nearest_support, nearest_resistance
    FROM engine_structure WHERE ticker = ${ticker} ORDER BY bar_date DESC LIMIT 1
  `;
  return rows[0] ?? null;
}
