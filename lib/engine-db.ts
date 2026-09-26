/**
 * engine-db — the only lib/engine* module that touches Neon. Bars and engine_*
 * rows move in bulk (unnest arrays, one statement per batch), because a nightly
 * run writes ~4,000 tickers and a per-row round trip would not fit in a function.
 */
import sql from "@/lib/db";
import type { Bar } from "@/lib/engine";
import type { BarAdjustment, BarFeed, BarRow } from "@/lib/shared/engine-bars";
import type { SnapshotHit, TickerSnapshot } from "@/lib/engine/snapshot";
import type { HitLabel } from "@/lib/engine/labels";

export interface StoredSeries {
  ticker: string;
  dates: string[];
  bars: Bar[];
}

export async function upsertBars(
  rows: readonly BarRow[],
  meta: { feed: BarFeed; adjustment: BarAdjustment; source: string },
): Promise<number> {
  if (rows.length === 0) return 0;
  await sql`
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
  `;
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
  await sql`
    INSERT INTO engine_runs (id, code_version, mode, feed)
    VALUES (${id}::text, ${meta.codeVersion}::text, ${meta.mode}::text, ${meta.feed}::text)
    ON CONFLICT (id) DO NOTHING
  `;
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
}

/** Hits with no label at `horizon` whose entry bar is old enough to have `horizon` later bars. */
export async function pendingHits(horizon: number, limit: number): Promise<PendingHit[]> {
  const rows = await sql`
    SELECT h.id, h.ticker, h.bar_date::text AS d, s.close AS entry,
           (h.features->>'stop')::float8 AS stop, (h.features->>'target')::float8 AS target
    FROM engine_detector_hits h
    JOIN engine_structure s ON s.ticker = h.ticker AND s.bar_date = h.bar_date AND s.code_version = h.code_version
    LEFT JOIN engine_forward_returns f ON f.hit_id = h.id AND f.horizon_days = ${horizon}
    WHERE f.hit_id IS NULL
      AND (SELECT count(*) FROM daily_bars b WHERE b.ticker = h.ticker AND b.bar_date > h.bar_date) >= ${horizon}
    ORDER BY h.bar_date LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    ticker: r.ticker as string,
    barDate: r.d as string,
    entry: r.entry as number,
    stop: (r.stop as number | null) ?? null,
    target: (r.target as number | null) ?? null,
  }));
}

export async function barsAfter(ticker: string, date: string, count: number): Promise<Bar[]> {
  const rows = await sql`
    SELECT open, high, low, close, volume FROM daily_bars
    WHERE ticker = ${ticker} AND bar_date > ${date}::date
      AND feed = (SELECT feed FROM daily_bars WHERE ticker = ${ticker} AND bar_date = ${date}::date LIMIT 1)
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

export async function latestStructure(ticker: string) {
  const rows = await sql`
    SELECT bar_date::text AS bar_date, code_version, levels, zones, nearest_support, nearest_resistance
    FROM engine_structure WHERE ticker = ${ticker} ORDER BY bar_date DESC LIMIT 1
  `;
  return rows[0] ?? null;
}
