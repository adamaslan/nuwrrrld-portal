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
