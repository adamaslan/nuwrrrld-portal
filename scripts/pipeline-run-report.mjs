#!/usr/bin/env node
/**
 * pipeline-run-report — a descriptive, self-contained HTML + JSON report for
 * ONE row of `pipeline_run_log` (lib/pipeline-run-log-db.ts).
 *
 * `npm run model-usage` rolls many runs of the three pipelines
 * (followed-tickers | followed-tickers-judge | precompute-ai) into a dated
 * markdown summary over a day/week/month. This script is the complement: it
 * renders exactly one run — the one a manual trigger just produced, or any
 * past run by id — in enough detail to actually debug it: every item's
 * subject, seat, model, outcome, latency, and fallback flag, plus the
 * per-model rollup and the run's own `summary` blob.
 *
 * Nothing is written to the database and no model is called — purely a
 * read-and-render over an existing row.
 *
 * Usage:
 *   node scripts/pipeline-run-report.mjs                                # latest run, any pipeline
 *   node scripts/pipeline-run-report.mjs --pipeline precompute-ai        # latest run of one pipeline
 *   node scripts/pipeline-run-report.mjs --id <uuid>                     # one specific run
 *   node scripts/pipeline-run-report.mjs --open                         # open the HTML when done
 *   node scripts/pipeline-run-report.mjs --out-dir docs/pipeline-runs    # default shown
 *
 * Chained automatically by `node scripts/local-trigger.mjs C <workflow>`
 * after a successful pipeline call — see the `pipeline` field on that
 * registry's `calls` entries.
 *
 * Env: DATABASE_URL (falls back to reading .env.local, like model-usage-report.mjs).
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { neon } from "@neondatabase/serverless";

// ── env ─────────────────────────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf8").split("\n")) {
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
  console.error("DATABASE_URL is not set — cannot read pipeline_run_log.");
  process.exit(1);
}

// ── args ────────────────────────────────────────────────────────────────────
function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PIPELINE = argValue("pipeline", null);
const RUN_ID = argValue("id", null);
const OUT_DIR = argValue("out-dir", join("docs", "pipeline-runs"));
const OPEN = process.argv.includes("--open");

const VALID_PIPELINES = ["followed-tickers", "followed-tickers-judge", "precompute-ai"];
if (PIPELINE && !VALID_PIPELINES.includes(PIPELINE)) {
  console.error(`--pipeline must be one of ${VALID_PIPELINES.join(", ")} (got "${PIPELINE}")`);
  process.exit(1);
}

// ── query ───────────────────────────────────────────────────────────────────
const sql = neon(process.env.DATABASE_URL);

let row;
try {
  const rows = RUN_ID
    ? await sql`
        SELECT id, pipeline, run_at, dry_run, session, items_total, items_ai, models, items, summary
        FROM pipeline_run_log WHERE id = ${RUN_ID}
      `
    : PIPELINE
      ? await sql`
          SELECT id, pipeline, run_at, dry_run, session, items_total, items_ai, models, items, summary
          FROM pipeline_run_log WHERE pipeline = ${PIPELINE}
          ORDER BY run_at DESC LIMIT 1
        `
      : await sql`
          SELECT id, pipeline, run_at, dry_run, session, items_total, items_ai, models, items, summary
          FROM pipeline_run_log ORDER BY run_at DESC LIMIT 1
        `;
  row = rows[0];
} catch (err) {
  if (err && err.code === "42P01") {
    console.error("pipeline_run_log does not exist yet — run `npm run db:migrate`.");
    process.exit(1);
  }
  throw err;
}

if (!row) {
  const scope = RUN_ID ? `id=${RUN_ID}` : PIPELINE ? `pipeline=${PIPELINE}` : "any pipeline";
  console.error(`No pipeline_run_log row found for ${scope}.`);
  process.exit(1);
}

// ── html ─────────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (v, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));

const OUTCOME_CLASS = { ok: "ok", empty: "warn", fail: "err", skip: "muted" };

function itemRowHtml(it) {
  const cls = OUTCOME_CLASS[it.outcome] ?? "muted";
  return `<tr class="${cls}">
    <td class="subj">${esc(it.subject)}</td>
    <td class="muted">${it.seat ? esc(it.seat) : "—"}</td>
    <td>${it.model ? esc(it.model) : "—"}</td>
    <td><span class="badge ${cls}">${esc(it.outcome)}</span></td>
    <td class="n">${it.latencyMs != null ? `${num(it.latencyMs)}ms` : "—"}</td>
    <td class="n">${it.fallback ? "yes" : "—"}</td>
  </tr>`;
}

function modelRowHtml(name, stats) {
  return `<tr>
    <td class="tk">${esc(name)}</td>
    <td class="n">${num(stats.calls)}</td>
    <td class="n">${num(stats.empty)}</td>
    <td class="n">${num(stats.fallbacks)}</td>
    <td class="n">${stats.avgLatencyMs != null ? `${num(stats.avgLatencyMs)}ms` : "—"}</td>
  </tr>`;
}

function buildHtml(row) {
  const items = Array.isArray(row.items) ? row.items : [];
  const models = row.models && typeof row.models === "object" ? row.models : {};
  const summary = row.summary && typeof row.summary === "object" ? row.summary : {};

  const okCount = items.filter((i) => i.outcome === "ok").length;
  const emptyCount = items.filter((i) => i.outcome === "empty").length;
  const failCount = items.filter((i) => i.outcome === "fail").length;
  const skipCount = items.filter((i) => i.outcome === "skip").length;

  const itemHead = `<tr><th>Subject</th><th>Seat</th><th>Model</th><th>Outcome</th><th class="n">Latency</th><th class="n">Fallback</th></tr>`;
  const modelHead = `<tr><th>Model</th><th class="n">Calls</th><th class="n">Empty</th><th class="n">Fallbacks</th><th class="n">Avg latency</th></tr>`;

  const summaryRows = Object.entries(summary)
    .map(([k, v]) => `<tr><td class="tk">${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : String(v))}</td></tr>`)
    .join("\n");

  const runAt = new Date(row.run_at).toISOString().replace("T", " ").slice(0, 19) + "Z";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pipeline Run — ${esc(row.pipeline)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  :root {
    --bg: #f6f8fa; --panel: #ffffff; --panel2: #eef1f5; --line: #dde3ea;
    --ink: #1b2027; --muted: #5c6773; --accent: #2563eb;
    --ok: #15803d; --warn: #b45309; --err: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e1116; --panel: #161b22; --panel2: #1c232c; --line: #2a323d;
      --ink: #e6edf3; --muted: #8b98a5; --accent: #58a6ff;
      --ok: #3fb950; --warn: #d29922; --err: #f85149;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0e1116; --panel: #161b22; --panel2: #1c232c; --line: #2a323d;
    --ink: #e6edf3; --muted: #8b98a5; --accent: #58a6ff;
    --ok: #3fb950; --warn: #d29922; --err: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    font-size: 14px; line-height: 1.55; padding: 40px 20px 72px;
  }
  .wrap { max-width: 1120px; margin: 0 auto; }
  .eyebrow {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
    color: var(--accent); margin: 0 0 8px;
  }
  h1 {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 26px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.5px;
  }
  .sub { color: var(--muted); margin: 0 0 28px; font-size: 13px; max-width: 70ch; }
  .sub code { background: var(--panel2); padding: 1.5px 5px; border-radius: 4px; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.7px; }
  .card .v {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 24px; font-weight: 500; margin-top: 6px; font-variant-numeric: tabular-nums;
  }
  .v.ok { color: var(--ok); } .v.warn { color: var(--warn); } .v.err { color: var(--err); }

  h2 {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); font-weight: 600;
    margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }
  thead th {
    color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px;
    font-weight: 600; background: var(--panel2); position: sticky; top: 0;
  }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--panel2); }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.subj, td.tk {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 600; color: var(--accent);
    white-space: normal; word-break: break-word;
  }
  .muted { color: var(--muted); }
  tr.err td { background: color-mix(in srgb, var(--err) 8%, transparent); }
  tr.warn td { background: color-mix(in srgb, var(--warn) 8%, transparent); }

  .badge {
    display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px;
    font-family: "IBM Plex Mono", ui-monospace, monospace; border: 1px solid currentColor;
  }
  .badge.ok { color: var(--ok); } .badge.warn { color: var(--warn); }
  .badge.err { color: var(--err); } .badge.muted { color: var(--muted); }

  footer { color: var(--muted); font-size: 12px; margin-top: 32px; line-height: 1.75; }
  footer code {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px;
    background: var(--panel2); padding: 1.5px 5px; border-radius: 4px;
  }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">pipeline_run_log &middot; ${esc(row.dry_run ? "dry run" : "live run")}</p>
  <h1>${esc(row.pipeline)}</h1>
  <p class="sub">
    Run <code>${esc(row.id)}</code> at <b>${esc(runAt)}</b>${row.session ? ` &middot; session <code>${esc(row.session)}</code>` : ""}.
    ${row.dry_run ? "No model was called and nothing was written — this run rehearsed selection only." : "Live run — models were called and results were written."}
  </p>

  <div class="cards">
    <div class="card"><div class="k">Items total</div><div class="v">${num(row.items_total)}</div></div>
    <div class="card"><div class="k">Items AI</div><div class="v">${num(row.items_ai)}</div></div>
    <div class="card"><div class="k">Ok</div><div class="v ok">${okCount}</div></div>
    <div class="card"><div class="k">Empty</div><div class="v warn">${emptyCount}</div></div>
    <div class="card"><div class="k">Failed</div><div class="v err">${failCount}</div></div>
    <div class="card"><div class="k">Skipped</div><div class="v">${skipCount}</div></div>
  </div>

  ${Object.keys(models).length ? `<h2>Per-model rollup</h2>
  <div class="scroll"><table>
    <thead>${modelHead}</thead>
    <tbody>${Object.entries(models).map(([name, stats]) => modelRowHtml(name, stats)).join("\n")}</tbody>
  </table></div>` : ""}

  <h2>Items <span class="muted">&mdash; ${items.length} total</span></h2>
  <div class="scroll"><table>
    <thead>${itemHead}</thead>
    <tbody>${items.length ? items.map(itemRowHtml).join("\n") : `<tr><td colspan="6" class="muted">no items</td></tr>`}</tbody>
  </table></div>

  ${summaryRows ? `<h2>Run summary</h2>
  <div class="scroll"><table><tbody>${summaryRows}</tbody></table></div>` : ""}

  <footer>
    Regenerate with <code>node scripts/pipeline-run-report.mjs --id ${esc(row.id)}</code>
    &middot; latest of this pipeline with <code>node scripts/pipeline-run-report.mjs --pipeline ${esc(row.pipeline)}</code>
    &middot; weekly/monthly rollups with <code>npm run model-usage</code>.
  </footer>
</div>
</body>
</html>
`;
}

// ── main ─────────────────────────────────────────────────────────────────
mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date(row.run_at).toISOString().replace(/[:.]/g, "-");
const base = `${stamp}-${row.pipeline}`;
const htmlPath = join(OUT_DIR, `${base}.html`);
const jsonPath = join(OUT_DIR, `${base}.json`);

writeFileSync(htmlPath, buildHtml(row));
writeFileSync(jsonPath, JSON.stringify(row, null, 2) + "\n");

console.log(`[pipeline-run-report] ${row.pipeline}  run_at=${row.run_at}  dry_run=${row.dry_run}`);
console.log(`  ${htmlPath}`);
console.log(`  ${jsonPath}`);

if (OPEN) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawnSync(opener, [htmlPath], { stdio: "ignore", shell: process.platform === "win32" });
}
