#!/usr/bin/env node
/**
 * model-usage-report — roll up pipeline_run_log into a dated markdown report.
 *
 * Answers "which models actually ran, on what, and how well" for a day, a
 * week, or a month, and writes it to docs/model-usage/<start>-<period>.md so
 * there is a durable, diffable record in the repo (the same pattern as
 * docs/free-model-rotation-status.md).
 *
 * Primary source: the `pipeline_run_log` table (lib/pipeline-run-log-db.ts),
 * one row per invocation of followed-tickers / followed-tickers-judge /
 * precompute-ai. A supplementary tally of `council_messages` covers the
 * interactive council, which those pipelines don't touch.
 *
 *   npm run model-usage                       # this week, write the file
 *   npm run model-usage -- --period month     # this month
 *   npm run model-usage -- --period day --date 2026-09-07
 *   npm run model-usage -- --stdout --dry-run # print, don't write
 *
 * Env: DATABASE_URL (falls back to reading .env.local, like db-migrate).
 * Zero extra deps — @neondatabase/serverless is already a dependency.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { neon } from '@neondatabase/serverless';

// ── env ─────────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    for (const line of readFileSync(join(process.cwd(), '.env.local'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env[m[1]] = v;
      }
    }
  } catch {
    /* no .env.local — process.env is the only source */
  }
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — cannot read pipeline_run_log.');
  process.exit(1);
}

// ── args ────────────────────────────────────────────────────────────────────
/**
 * Read `--<name> <value>` from argv. Returns `fallback` when the flag is absent
 * or has no following token. Flags-as-booleans (`--dry-run`, `--stdout`) are
 * handled separately with `process.argv.includes`.
 */
function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PERIOD = argValue('period', 'week');
const ANCHOR = argValue('date', new Date().toISOString().slice(0, 10));
const OUT_DIR = argValue('out-dir', join('docs', 'model-usage'));
const DRY_RUN = process.argv.includes('--dry-run');
const TO_STDOUT = process.argv.includes('--stdout');

if (!['day', 'week', 'month'].includes(PERIOD)) {
  console.error(`--period must be day | week | month (got "${PERIOD}")`);
  process.exit(1);
}

/**
 * True only for a real calendar date in YYYY-MM-DD form. The format test alone
 * accepts `2026-02-30`, which `new Date` silently rolls to March 2 — so the
 * report period would then differ from the date the caller asked for. Require
 * the parsed date to round-trip back to the same string.
 */
function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
if (!isValidIsoDate(ANCHOR)) {
  console.error(`--date must be a real calendar date in YYYY-MM-DD form (got "${ANCHOR}")`);
  process.exit(1);
}

// ── period bounds (UTC) ─────────────────────────────────────────────────────
/**
 * Half-open [start, end) UTC window for the report.
 *   - day:   the anchor date, 00:00Z .. next day 00:00Z
 *   - week:  the ISO week containing the anchor (Monday 00:00Z .. next Monday)
 *   - month: the 1st of the anchor's month 00:00Z .. the 1st of the next month
 * `anchorIso` is a YYYY-MM-DD string (already validated by the caller).
 */
function periodBounds(period, anchorIso) {
  const d = new Date(`${anchorIso}T00:00:00Z`);
  let start;
  let end;
  if (period === 'day') {
    start = d;
    end = new Date(d);
    end.setUTCDate(end.getUTCDate() + 1);
  } else if (period === 'week') {
    // ISO week: Monday 00:00Z .. next Monday 00:00Z
    const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
    start = new Date(d);
    start.setUTCDate(start.getUTCDate() - dow);
    end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
  } else {
    start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
  return { start, end };
}

const { start, end } = periodBounds(PERIOD, ANCHOR);
const startIso = start.toISOString();
const endIso = end.toISOString();
const startDay = startIso.slice(0, 10);
const label =
  PERIOD === 'day'
    ? `day ${startDay}`
    : PERIOD === 'week'
      ? `week of ${startDay}`
      : `month ${startIso.slice(0, 7)}`;
const fileName =
  PERIOD === 'month' ? `${startIso.slice(0, 7)}-month.md` : `${startDay}-${PERIOD}.md`;

// ── query ───────────────────────────────────────────────────────────────────
const sql = neon(process.env.DATABASE_URL);

let runs = [];
let tableMissing = false;
try {
  runs = await sql`
    SELECT id, pipeline, run_at, dry_run, session, items_total, items_ai, models, items, summary
    FROM pipeline_run_log
    WHERE run_at >= ${startIso} AND run_at < ${endIso}
    ORDER BY run_at ASC
  `;
} catch (err) {
  // 42P01 = undefined_table: the migration hasn't run against this DB yet.
  if (err && err.code === '42P01') {
    tableMissing = true;
  } else {
    throw err;
  }
}

// Supplementary: interactive council calls (not covered by the pipelines above).
// A failed query must not be rendered as "no data" — the scheduled workflow
// commits whatever this produces, and a transient/permission/SQL error silently
// hiding real council_messages rows is worse than an explicit "unavailable".
let councilByModel = [];
let councilUnavailable = false;
try {
  councilByModel = await sql`
    SELECT model, count(*)::int AS calls, round(avg(latency_ms))::int AS avg_latency_ms
    FROM council_messages
    WHERE created_at >= ${startIso} AND created_at < ${endIso}
    GROUP BY model
    ORDER BY calls DESC
  `;
} catch (err) {
  // 42P01 (table absent) is an expected state on a not-yet-migrated DB; any
  // other failure is a real error worth showing as such in the report.
  councilUnavailable = true;
  councilByModel = [];
  console.warn(
    `[model-usage] council_messages query failed (${err?.code || 'unknown'}): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}

// ── aggregate ───────────────────────────────────────────────────────────────
const isFreeId = (id) => typeof id === 'string' && id.endsWith(':free');

/** { model: { calls, empty, fallbacks, latencySum, latencyN, pipelines:Set } } */
const byModel = new Map();
const byPipeline = new Map();

for (const r of runs) {
  const models = typeof r.models === 'string' ? JSON.parse(r.models) : r.models ?? {};
  const p = byPipeline.get(r.pipeline) ?? {
    runs: 0,
    itemsTotal: 0,
    itemsAi: 0,
    dryRuns: 0,
    models: new Map(),
  };
  p.runs += 1;
  p.itemsTotal += r.items_total ?? 0;
  p.itemsAi += r.items_ai ?? 0;
  if (r.dry_run) p.dryRuns += 1;

  for (const [model, s] of Object.entries(models)) {
    const g = byModel.get(model) ?? {
      calls: 0,
      empty: 0,
      fallbacks: 0,
      latencySum: 0,
      latencyN: 0,
      pipelines: new Set(),
    };
    g.calls += s.calls ?? 0;
    g.empty += s.empty ?? 0;
    g.fallbacks += s.fallbacks ?? 0;
    if (typeof s.avgLatencyMs === 'number') {
      g.latencySum += s.avgLatencyMs * (s.calls ?? 1);
      g.latencyN += s.calls ?? 1;
    }
    g.pipelines.add(r.pipeline);
    byModel.set(model, g);

    const pm = p.models.get(model) ?? { calls: 0, empty: 0, fallbacks: 0 };
    pm.calls += s.calls ?? 0;
    pm.empty += s.empty ?? 0;
    pm.fallbacks += s.fallbacks ?? 0;
    p.models.set(model, pm);
  }
  byPipeline.set(r.pipeline, p);
}

const totalCalls = [...byModel.values()].reduce((n, g) => n + g.calls, 0);

// ── render ──────────────────────────────────────────────────────────────────
/** Format `n / d` as a whole-number percent for a table cell, or `—` when `d` is 0. */
function pct(n, d) {
  return d > 0 ? `${((100 * n) / d).toFixed(0)}%` : '—';
}
/** Format a millisecond duration for a table cell: `—` for null, `1.2s` at or above 1000ms, else `340ms`. */
function ms(n) {
  return n == null ? '—' : n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

const lines = [];
lines.push(`# Model usage — ${label}`);
lines.push('');
lines.push(
  `Window \`${startIso}\` … \`${endIso}\` (UTC, end-exclusive). ` +
    `Generated ${new Date().toISOString()} by \`scripts/model-usage-report.mjs\`.`,
);
lines.push('');
lines.push(`Source: \`pipeline_run_log\` — ${runs.length} pipeline run(s), ${totalCalls} model call(s).`);
lines.push('');

if (tableMissing) {
  lines.push(
    '_`pipeline_run_log` does not exist in this database yet — run `npm run db:migrate` ' +
      '(it also runs automatically on every deploy via the `prebuild` step). No pipeline ' +
      'data to report until then._',
  );
  lines.push('');
} else if (runs.length === 0) {
  lines.push('_No pipeline runs recorded in this window._');
  lines.push('');
} else {
  // ── by model ──
  lines.push('## By model');
  lines.push('');
  lines.push('| model | calls | share | empty | chain-rescued | avg latency | cost |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|');
  const sortedModels = [...byModel.entries()].sort((a, b) => b[1].calls - a[1].calls);
  for (const [model, g] of sortedModels) {
    const avg = g.latencyN > 0 ? g.latencySum / g.latencyN : null;
    lines.push(
      `| \`${model}\` | ${g.calls} | ${pct(g.calls, totalCalls)} | ${g.empty} | ` +
        `${g.fallbacks} | ${ms(avg)} | ${isFreeId(model) ? '$0' : '⚠ paid'} |`,
    );
  }
  lines.push('');
  const paidModels = sortedModels.filter(([m]) => !isFreeId(m));
  if (paidModels.length > 0) {
    lines.push(
      `> ⚠ ${paidModels.length} non-\`:free\` model(s) served calls this period: ` +
        `${paidModels.map(([m]) => `\`${m}\``).join(', ')}. ` +
        'Token counts are not stored, so per-call cost is not computed — treat as "spent real money".',
    );
    lines.push('');
  }

  // ── by pipeline ──
  lines.push('## By pipeline');
  lines.push('');
  for (const [pipeline, p] of [...byPipeline.entries()].sort()) {
    lines.push(`### \`${pipeline}\``);
    lines.push('');
    lines.push(
      `- ${p.runs} run(s)${p.dryRuns ? ` (${p.dryRuns} dry)` : ''}, ` +
        `${p.itemsTotal} unit(s) seen, ${p.itemsAi} spent a model call`,
    );
    if (p.models.size > 0) {
      lines.push('');
      lines.push('| model | calls | empty | chain-rescued |');
      lines.push('|---|--:|--:|--:|');
      for (const [model, pm] of [...p.models.entries()].sort((a, b) => b[1].calls - a[1].calls)) {
        lines.push(`| \`${model}\` | ${pm.calls} | ${pm.empty} | ${pm.fallbacks} |`);
      }
    }
    lines.push('');
  }

  // ── runs, chronological ──
  lines.push('## Runs');
  lines.push('');
  lines.push('| run_at (UTC) | pipeline | dry | units | ai | models used |');
  lines.push('|---|---|:-:|--:|--:|---|');
  for (const r of runs) {
    const models = typeof r.models === 'string' ? JSON.parse(r.models) : r.models ?? {};
    const used =
      Object.entries(models)
        .map(([m, s]) => `${m.replace(/:free$/, '')}×${s.calls}`)
        .join(', ') || '—';
    lines.push(
      `| ${new Date(r.run_at).toISOString().replace('T', ' ').slice(0, 19)} | ${r.pipeline} | ` +
        `${r.dry_run ? '✓' : ''} | ${r.items_total ?? 0} | ${r.items_ai ?? 0} | ${used} |`,
    );
  }
  lines.push('');
}

// ── supplementary: interactive council ──
lines.push('## Interactive council (`council_messages`)');
lines.push('');
if (councilUnavailable) {
  lines.push('_⚠ `council_messages` query failed — this tally is unavailable, not empty. See the run log._');
} else if (councilByModel.length === 0) {
  lines.push('_None in this window._');
} else {
  lines.push('| model | calls | avg latency |');
  lines.push('|---|--:|--:|');
  for (const c of councilByModel) {
    lines.push(`| \`${c.model}\` | ${c.calls} | ${ms(c.avg_latency_ms)} |`);
  }
}
lines.push('');

const out = lines.join('\n');

if (TO_STDOUT || DRY_RUN) {
  process.stdout.write(out + '\n');
}
if (!DRY_RUN) {
  mkdirSync(OUT_DIR, { recursive: true });
  const dest = join(OUT_DIR, fileName);
  writeFileSync(dest, out + '\n', 'utf8');
  console.error(`\nWrote ${dest}`);
}
