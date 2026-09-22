#!/usr/bin/env node
/**
 * nulogdash-report — a descriptive, self-contained HTML report for ONE
 * `/nulogdash` feature sweep (`.nulogdash/latest.json`, written by
 * scripts/nulogdash.mjs).
 *
 * `scripts/pipeline-run-report.mjs` is the equivalent for one row of
 * `pipeline_run_log` — a single *pipeline* run. This is the complement for a
 * single *feature sweep*: every feature in docs/nulogdash-inventory.json with
 * its status, entrypoint, latency and redacted reason, plus the two rollups
 * the terminal output can't show well — what is blocking the blocked features
 * (grouped by cause, so 38 identical "no session cookie" lines read as one
 * root cause), and which dependency each unexercised feature was waiting on.
 *
 * Reads only. No database, no model call, no request to the dev server — it
 * renders a sweep that already happened.
 *
 * Usage:
 *   node scripts/nulogdash-report.mjs                          # .nulogdash/latest.json
 *   node scripts/nulogdash-report.mjs --run <runId>            # .nulogdash/runs/<runId>.json
 *   node scripts/nulogdash-report.mjs --open                   # open the HTML when done
 *   node scripts/nulogdash-report.mjs --out-dir docs/nulogdash-runs   # default shown
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const runId = argValue("run", null);
const outDir = argValue("out-dir", join("docs", "nulogdash-runs"));
const shouldOpen = process.argv.includes("--open");

const srcFile = runId
  ? join(ROOT, ".nulogdash", "runs", `${runId}.json`)
  : join(ROOT, ".nulogdash", "latest.json");

if (!existsSync(srcFile)) {
  console.error(`No sweep found at ${srcFile} — run 'npm run nulogdash' first.`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(srcFile, "utf8"));

// ── shaping ─────────────────────────────────────────────────────────────────
const STATUS_ORDER = { fail: 0, blocked: 1, not_run: 2, pass: 3 };
const results = [...run.results].sort(
  (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.feature.localeCompare(b.feature),
);
const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
const total = results.length;
// A failed feature still ran — it's distinct from blocked/not_run, which
// never got the chance to. Excluding fail understated coverage whenever any
// feature legitimately failed.
const exercised = (counts.pass ?? 0) + (counts.fail ?? 0);
const notExercised = (counts.blocked ?? 0) + (counts.not_run ?? 0);
const coverage = total ? Math.round((exercised / total) * 100) : 0;

// Group blocked/not_run by their cause so N identical rows read as one root
// cause. The `reason` is already redacted + truncated by scripts/nulogdash.mjs.
const blockers = new Map();
for (const r of results) {
  if (r.status !== "blocked" && r.status !== "not_run") continue;
  const key = (r.reason ?? "no reason recorded").replace(/^excluded:\s*/, "");
  if (!blockers.has(key)) blockers.set(key, { status: r.status, features: [] });
  blockers.get(key).features.push(r.feature);
}
const blockerRows = [...blockers.entries()].sort((a, b) => b[1].features.length - a[1].features.length);

const latencies = results.filter((r) => typeof r.latencyMs === "number").map((r) => r.latencyMs);
const slowest = latencies.length ? Math.max(...latencies) : null;

// ── html ────────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cls = { pass: "ok", fail: "err", blocked: "warn", not_run: "muted" };
const ms = (v) => (typeof v === "number" ? `${v.toLocaleString()}ms` : "—");

const featureRow = (r) => `<tr class="${r.status === "fail" ? "err" : r.status === "blocked" ? "warn" : ""}">
  <td><span class="badge ${cls[r.status]}">${esc(r.status)}</span></td>
  <td class="subj">${esc(r.feature)}</td>
  <td class="ep">${esc((r.entrypoints ?? []).join(", "))}</td>
  <td>${(r.dependencies ?? []).length ? esc(r.dependencies.join(", ")) : '<span class="muted">—</span>'}</td>
  <td class="n">${ms(r.latencyMs)}</td>
  <td class="why">${r.reason ? esc(r.reason) : '<span class="muted">—</span>'}</td>
</tr>`;

const blockerRow = ([reason, info]) => `<tr>
  <td><span class="badge ${cls[info.status]}">${esc(info.status)}</span></td>
  <td class="n">${info.features.length}</td>
  <td class="why">${esc(reason)}</td>
  <td class="feats">${info.features.map((f) => `<code>${esc(f)}</code>`).join(" ")}</td>
</tr>`;

const chartData = {
  status: { labels: ["pass", "fail", "blocked", "not_run"], counts: ["pass", "fail", "blocked", "not_run"].map((s) => counts[s] ?? 0) },
  blockers: { labels: blockerRows.map(([reason]) => reason), counts: blockerRows.map(([, info]) => info.features.length) },
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nulogdash sweep — ${esc(run.runAt)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
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
  .wrap { max-width: 1180px; margin: 0 auto; }
  .eyebrow {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase;
    color: var(--accent); margin: 0 0 8px;
  }
  h1 {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 26px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.5px;
  }
  .sub { color: var(--muted); margin: 0 0 28px; font-size: 13px; max-width: 78ch; }
  .sub code, footer code, td.feats code {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    background: var(--panel2); padding: 1.5px 5px; border-radius: 4px; font-size: 12px;
  }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .card .k { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.7px; }
  .card .v {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 24px; font-weight: 500; margin-top: 6px; font-variant-numeric: tabular-nums;
  }
  .v.ok { color: var(--ok); } .v.warn { color: var(--warn); } .v.err { color: var(--err); }
  .card .note { color: var(--muted); font-size: 11px; margin-top: 4px; }

  .bar { display: flex; height: 10px; border-radius: 999px; overflow: hidden; margin: 20px 0 4px; border: 1px solid var(--line); }
  .bar span { display: block; }
  .bar .pass { background: var(--ok); } .bar .fail { background: var(--err); }
  .bar .blocked { background: var(--warn); } .bar .not_run { background: var(--muted); }
  .barkey { color: var(--muted); font-size: 11.5px; font-family: "IBM Plex Mono", ui-monospace, monospace; }

  h2 {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); font-weight: 600;
    margin: 34px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  h2 + p { color: var(--muted); font-size: 12.5px; margin: -4px 0 12px; max-width: 78ch; }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); }
  th, td { padding: 9px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  thead th {
    color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.5px;
    font-weight: 600; background: var(--panel2); white-space: nowrap;
  }
  tbody tr:last-child td { border-bottom: none; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.subj { font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 600; color: var(--accent); white-space: nowrap; }
  td.ep { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px; white-space: nowrap; }
  td.why { color: var(--muted); font-size: 12.5px; min-width: 26ch; }
  td.feats { font-size: 12px; line-height: 2; }
  .muted { color: var(--muted); }
  tr.err td { background: color-mix(in srgb, var(--err) 8%, transparent); }
  tr.warn td { background: color-mix(in srgb, var(--warn) 7%, transparent); }
  .badge {
    display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px;
    font-family: "IBM Plex Mono", ui-monospace, monospace; border: 1px solid currentColor; white-space: nowrap;
  }
  .badge.ok { color: var(--ok); } .badge.warn { color: var(--warn); }
  .badge.err { color: var(--err); } .badge.muted { color: var(--muted); }
  footer { color: var(--muted); font-size: 12px; margin-top: 34px; line-height: 1.85; }

  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0 4px; }
  @media (max-width: 720px) { .charts { grid-template-columns: 1fr; } }
  .chartbox { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
  .chartbox .ck { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 10px; }
  .chartbox canvas { max-height: 220px; }
  .chart-fallback { color: var(--muted); font-size: 12px; }

  .toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 10px; }
  .toolbar input[type="search"] {
    flex: 1; min-width: 180px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
    color: var(--ink); padding: 7px 11px; font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12.5px;
  }
  .toolbar input[type="search"]::placeholder { color: var(--muted); }
  .toolbar button.chip {
    background: var(--panel); border: 1px solid var(--line); border-radius: 999px; color: var(--muted);
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 11px; padding: 5px 12px; cursor: pointer;
  }
  .toolbar button.chip.active { color: var(--ink); border-color: var(--accent); background: var(--panel2); }
  .rowcount { color: var(--muted); font-size: 11.5px; margin: 0 0 8px; }
  tr.hide { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">nulogdash &middot; tier ${esc((run.tiers ?? ["api"]).join(", "))} &middot; run ${esc(run.runId)}</p>
  <h1>Feature sweep — ${esc(run.runAt)}</h1>
  <p class="sub">
    Every feature in <code>docs/nulogdash-inventory.json</code> fired against <code>${esc(run.baseUrl)}</code>
    on branch <code>${esc(run.branch)}</code> at <code>${esc(run.gitSha)}</code>.
    <b>${exercised} of ${total}</b> features were exercised end-to-end; <b>${notExercised}</b> were not.
    A <span class="badge warn">blocked</span> feature is one whose dependency was unmet, not one that failed —
    the distinction is the point of this sweep.
  </p>

  <div class="cards">
    <div class="card"><div class="k">Pass</div><div class="v ok">${counts.pass ?? 0}</div><div class="note">ran, 2xx</div></div>
    <div class="card"><div class="k">Fail</div><div class="v err">${counts.fail ?? 0}</div><div class="note">ran, non-2xx or threw</div></div>
    <div class="card"><div class="k">Blocked</div><div class="v warn">${counts.blocked ?? 0}</div><div class="note">dependency unmet</div></div>
    <div class="card"><div class="k">Not run</div><div class="v">${counts.not_run ?? 0}</div><div class="note">excluded by design</div></div>
    <div class="card"><div class="k">Coverage</div><div class="v ${coverage >= 80 ? "ok" : coverage >= 40 ? "warn" : "err"}">${coverage}%</div><div class="note">${exercised}/${total} exercised</div></div>
    <div class="card"><div class="k">Slowest</div><div class="v">${slowest !== null ? slowest.toLocaleString() : "—"}</div><div class="note">ms, of ${latencies.length} timed</div></div>
  </div>

  <div class="bar">
    ${["pass", "fail", "blocked", "not_run"].map((s) => (counts[s] ? `<span class="${s}" style="flex:${counts[s]}"></span>` : "")).join("")}
  </div>
  <div class="barkey">pass ${counts.pass ?? 0} &middot; fail ${counts.fail ?? 0} &middot; blocked ${counts.blocked ?? 0} &middot; not_run ${counts.not_run ?? 0}</div>

  <div class="charts">
    <div class="chartbox">
      <div class="ck">Status breakdown</div>
      <canvas id="statusChart" role="img" aria-label="Donut chart of feature status counts"></canvas>
      <div id="statusFallback" class="chart-fallback" style="display:none">Chart.js failed to load — see the cards above for exact counts.</div>
    </div>
    <div class="chartbox">
      <div class="ck">Top blockers by feature count</div>
      <canvas id="blockerChart" role="img" aria-label="Bar chart of blocker causes ranked by affected feature count"></canvas>
      <div id="blockerFallback" class="chart-fallback" style="display:none">Chart.js failed to load — see the table below for exact counts.</div>
    </div>
  </div>

  ${(run.driftWarnings ?? []).length ? `<h2>Inventory drift</h2>
  <div class="scroll"><table><tbody>${run.driftWarnings.map((w) => `<tr><td class="why">${esc(typeof w === "string" ? w : JSON.stringify(w))}</td></tr>`).join("")}</tbody></table></div>`
    : `<h2>Inventory drift</h2><p>None — <code>docs/nulogdash-inventory.json</code> matches the routes under <code>app/api/**</code>.</p>`}

  <h2>Why ${notExercised} features were not exercised</h2>
  <p>Grouped by cause, largest first. One row here is one thing to fix; the feature list is what unblocks when it is.</p>
  <div class="scroll"><table>
    <thead><tr><th>Status</th><th class="n">Features</th><th>Cause</th><th>Affected</th></tr></thead>
    <tbody>${blockerRows.map(blockerRow).join("\n")}</tbody>
  </table></div>

  <h2>Every feature (${total})</h2>
  <p>Failures first, then blocked, then excluded, then passing. Reasons are redacted and truncated at write time by <code>scripts/nulogdash.mjs</code>.</p>
  <div class="toolbar">
    <input type="search" id="featureFilter" placeholder="Filter by feature, entrypoint, or reason&hellip;" autocomplete="off">
    <button class="chip active" data-status="all">all ${total}</button>
    <button class="chip" data-status="pass">pass ${counts.pass ?? 0}</button>
    <button class="chip" data-status="fail">fail ${counts.fail ?? 0}</button>
    <button class="chip" data-status="blocked">blocked ${counts.blocked ?? 0}</button>
    <button class="chip" data-status="not_run">not_run ${counts.not_run ?? 0}</button>
  </div>
  <p class="rowcount" id="rowcount"></p>
  <div class="scroll"><table>
    <thead><tr><th>Status</th><th>Feature</th><th>Entrypoint</th><th>Depends on</th><th class="n">Latency</th><th>Reason</th></tr></thead>
    <tbody id="featureBody">${results.map((r) => featureRow(r).replace("<tr", `<tr data-status="${r.status}" data-search="${esc(`${r.feature} ${(r.entrypoints ?? []).join(" ")} ${r.reason ?? ""}`).toLowerCase()}"`)).join("\n")}</tbody>
  </table></div>

  <footer>
    Generated by <code>scripts/nulogdash-report.mjs</code> from <code>${esc(srcFile.replace(ROOT + "/", ""))}</code>.
    Read-only: no database write, no model call, no request to the dev server.<br>
    Re-run the sweep with <code>npm run nulogdash</code>, then <code>npm run nulogdash:report</code>.
    The live matrix is at <code>${esc(run.baseUrl)}/dashboard/nulogdash</code>.
  </footer>
</div>
<script>
(function () {
  var DATA = ${JSON.stringify(chartData)};
  var STATUS_COLOR = { pass: "#15803d", fail: "#b91c1c", blocked: "#b45309", not_run: "#5c6773" };
  var isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var gridColor = isDark ? "#2a323d" : "#dde3ea";
  var textColor = isDark ? "#8b98a5" : "#5c6773";

  function renderCharts() {
    if (typeof Chart === "undefined") {
      var sf = document.getElementById("statusFallback"); if (sf) sf.style.display = "block";
      var bf = document.getElementById("blockerFallback"); if (bf) bf.style.display = "block";
      return;
    }
    var statusCanvas = document.getElementById("statusChart");
    if (statusCanvas && DATA.status.counts.some(function (n) { return n > 0; })) {
      new Chart(statusCanvas, {
        type: "doughnut",
        data: {
          labels: DATA.status.labels,
          datasets: [{ data: DATA.status.counts, backgroundColor: DATA.status.labels.map(function (s) { return STATUS_COLOR[s]; }), borderWidth: 0 }],
        },
        options: {
          plugins: { legend: { position: "bottom", labels: { color: textColor, font: { size: 11 }, boxWidth: 10 } } },
          cutout: "62%",
        },
      });
    }
    var blockerCanvas = document.getElementById("blockerChart");
    if (blockerCanvas && DATA.blockers.counts.length) {
      new Chart(blockerCanvas, {
        type: "bar",
        data: {
          labels: DATA.blockers.labels.map(function (l) { return l.length > 34 ? l.slice(0, 33) + "…" : l; }),
          datasets: [{ data: DATA.blockers.counts, backgroundColor: "#b45309", borderRadius: 4, maxBarThickness: 18 }],
        },
        options: {
          indexAxis: "y",
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: textColor, precision: 0 }, grid: { color: gridColor } },
            y: { ticks: { color: textColor, font: { size: 10.5 } }, grid: { display: false } },
          },
        },
      });
    } else if (blockerCanvas) {
      var bf2 = document.getElementById("blockerFallback"); if (bf2) { bf2.textContent = "No blockers to chart — every feature ran."; bf2.style.display = "block"; }
    }
  }

  function initFilter() {
    var input = document.getElementById("featureFilter");
    var rows = Array.prototype.slice.call(document.querySelectorAll("#featureBody tr"));
    var chips = Array.prototype.slice.call(document.querySelectorAll(".toolbar button.chip"));
    var rowcount = document.getElementById("rowcount");
    var activeStatus = "all";

    function apply() {
      var q = (input.value || "").trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (tr) {
        var matchesStatus = activeStatus === "all" || tr.getAttribute("data-status") === activeStatus;
        var matchesQuery = !q || (tr.getAttribute("data-search") || "").indexOf(q) !== -1;
        var visible = matchesStatus && matchesQuery;
        tr.classList.toggle("hide", !visible);
        if (visible) shown++;
      });
      rowcount.textContent = "Showing " + shown + " of " + rows.length + " features.";
    }

    if (input) input.addEventListener("input", apply);
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (c) { c.classList.remove("active"); });
        chip.classList.add("active");
        activeStatus = chip.getAttribute("data-status");
        apply();
      });
    });
    apply();
  }

  renderCharts();
  initFilter();
})();
</script>
</body>
</html>`;

// ── write ───────────────────────────────────────────────────────────────────
const stamp = new Date(run.runAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
const absOutDir = join(ROOT, outDir);
mkdirSync(absOutDir, { recursive: true });
const htmlPath = join(absOutDir, `${stamp}-nulogdash.html`);
writeFileSync(htmlPath, html);
writeFileSync(join(absOutDir, `${stamp}-nulogdash.json`), JSON.stringify(run, null, 2));

console.log(`nulogdash report: ${counts.pass ?? 0} pass, ${counts.fail ?? 0} fail, ${counts.blocked ?? 0} blocked, ${counts.not_run ?? 0} not_run (${coverage}% coverage)`);
console.log(`Wrote ${htmlPath.replace(ROOT + "/", "")}`);
if (shouldOpen) spawnSync("open", [htmlPath], { stdio: "ignore" });
