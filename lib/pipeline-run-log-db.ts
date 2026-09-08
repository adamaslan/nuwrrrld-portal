/**
 * pipeline-run-log-db — one append-only row per model-spending pipeline run.
 *
 * Unlike followed-tickers-db (the eval's system of record, where a failed write
 * is fatal), this table is pure observability: scripts/model-usage-report.mjs
 * reads it to build the dated markdown in docs/model-usage/, and nothing in a
 * request path ever reads it back. So `logPipelineRun` swallows and logs its
 * own errors — losing an audit row must never break a pipeline run.
 *
 * See lib/db/schema.sql `pipeline_run_log` for the column contract.
 */
import { randomUUID } from "node:crypto";
import sql from "@/lib/db";

export type PipelineName =
  | "followed-tickers"
  | "followed-tickers-judge"
  | "precompute-ai";

/** How one unit of work resolved. `skip` = no model call was attempted. */
export type RunItemOutcome = "ok" | "empty" | "fail" | "skip";

export interface RunItem {
  /** ticker, comma-joined ticker batch, pick:horizon — whatever the pipeline's unit is. */
  subject: string;
  seat?: string;
  /** The model that actually served, or null when none did (skip / fail-before-response). */
  model: string | null;
  outcome: RunItemOutcome;
  latencyMs?: number;
  /** True when the seat's primary lost and a FREE_MODEL_CHAIN entry served instead. */
  fallback?: boolean;
}

export interface PerModelStats {
  calls: number;
  empty: number;
  fallbacks: number;
  avgLatencyMs: number | null;
}

export interface PipelineRunLog {
  pipeline: PipelineName;
  dryRun: boolean;
  session?: string | null;
  itemsTotal: number;
  items: RunItem[];
  summary: Record<string, unknown>;
}

/** Fold a flat item list into the per-model rollup stored in the `models` column. */
export function rollupModels(items: RunItem[]): Record<string, PerModelStats> {
  const acc: Record<string, PerModelStats & { _latencySum: number; _latencyN: number }> = {};
  for (const it of items) {
    if (!it.model) continue;
    const m = (acc[it.model] ??= {
      calls: 0,
      empty: 0,
      fallbacks: 0,
      avgLatencyMs: null,
      _latencySum: 0,
      _latencyN: 0,
    });
    m.calls += 1;
    if (it.outcome === "empty") m.empty += 1;
    if (it.fallback) m.fallbacks += 1;
    if (typeof it.latencyMs === "number") {
      m._latencySum += it.latencyMs;
      m._latencyN += 1;
    }
  }
  const out: Record<string, PerModelStats> = {};
  for (const [model, m] of Object.entries(acc)) {
    out[model] = {
      calls: m.calls,
      empty: m.empty,
      fallbacks: m.fallbacks,
      avgLatencyMs: m._latencyN > 0 ? Math.round(m._latencySum / m._latencyN) : null,
    };
  }
  return out;
}

/**
 * Persist one pipeline run. Best-effort: never throws, returns whether the row
 * was written so a caller can note it in its response `meta` if it wants.
 */
export async function logPipelineRun(run: PipelineRunLog): Promise<boolean> {
  const models = rollupModels(run.items);
  const itemsAi = run.items.filter((it) => it.model != null).length;
  try {
    // Generate the id application-side rather than leaning on the column
    // default. Postgres has `DEFAULT gen_random_uuid()`, but the generated
    // SQLite schema (lib/db/schema.sqlite.sql, used by the backup/parity path)
    // has no default on `id TEXT PRIMARY KEY` — an omitted id there stores NULL.
    await sql`
      INSERT INTO pipeline_run_log
        (id, pipeline, dry_run, session, items_total, items_ai, models, items, summary)
      VALUES (
        ${randomUUID()},
        ${run.pipeline},
        ${run.dryRun},
        ${run.session ?? null},
        ${run.itemsTotal},
        ${itemsAi},
        ${JSON.stringify(models)},
        ${JSON.stringify(run.items)},
        ${JSON.stringify(run.summary)}
      )
    `;
    return true;
  } catch (err) {
    console.warn(
      `[pipeline-run-log] insert failed for ${run.pipeline} (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

// ── read side ───────────────────────────────────────────────────────────────
// The table was write-only for a long time: only scripts/model-usage-report.mjs
// and scripts/pipeline-run-report.mjs read it, both over their own direct
// connection. /dashboard/nulogdash/pipelines is the first *request path* reader,
// so unlike `logPipelineRun` these throw — a dashboard that silently renders
// "no runs" when the query failed is worse than one that errors.

/** One `pipeline_run_log` row as stored, with the jsonb columns parsed. */
export interface PipelineRunRow {
  id: string;
  pipeline: PipelineName;
  runAt: string;
  dryRun: boolean;
  session: string | null;
  itemsTotal: number;
  itemsAi: number;
  models: Record<string, PerModelStats>;
  items: RunItem[];
  summary: Record<string, unknown>;
}

/** `models`/`items`/`summary` come back as objects from Postgres (jsonb) but as
 * strings from the SQLite parity path, so normalise both. */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function toRow(r: Record<string, unknown>): PipelineRunRow {
  return {
    id: String(r.id),
    pipeline: r.pipeline as PipelineName,
    runAt: r.run_at instanceof Date ? r.run_at.toISOString() : String(r.run_at),
    dryRun: Boolean(r.dry_run),
    session: (r.session as string | null) ?? null,
    itemsTotal: Number(r.items_total ?? 0),
    itemsAi: Number(r.items_ai ?? 0),
    models: parseJson<Record<string, PerModelStats>>(r.models, {}),
    items: parseJson<RunItem[]>(r.items, []),
    summary: parseJson<Record<string, unknown>>(r.summary, {}),
  };
}

/** Most recent runs across all three pipelines, newest first. */
export async function listPipelineRuns(limit = 50): Promise<PipelineRunRow[]> {
  // Clamped because `limit` is reachable from a query string; an unbounded
  // value would let one request pull the whole audit table into memory.
  const n = Math.min(Math.max(Math.trunc(limit) || 0, 1), 200);
  const rows = (await sql`
    SELECT id, pipeline, run_at, dry_run, session, items_total, items_ai, models, items, summary
    FROM pipeline_run_log ORDER BY run_at DESC LIMIT ${n}
  `) as Record<string, unknown>[];
  return rows.map(toRow);
}

/** One run by id, or null if there is no such row. */
export async function getPipelineRun(id: string): Promise<PipelineRunRow | null> {
  // Guard the cast: a non-uuid id makes Postgres raise 22P02 rather than
  // returning zero rows, which would surface as a 500 on a mistyped URL.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const rows = (await sql`
    SELECT id, pipeline, run_at, dry_run, session, items_total, items_ai, models, items, summary
    FROM pipeline_run_log WHERE id = ${id}
  `) as Record<string, unknown>[];
  return rows[0] ? toRow(rows[0]) : null;
}

/** Fold a run's items into outcome counts — the summary cards' source. */
export function summarizeOutcomes(items: RunItem[]): Record<RunItemOutcome, number> {
  const acc: Record<RunItemOutcome, number> = { ok: 0, empty: 0, fail: 0, skip: 0 };
  for (const it of items) {
    if (it.outcome in acc) acc[it.outcome] += 1;
  }
  return acc;
}
