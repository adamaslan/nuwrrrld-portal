#!/usr/bin/env node
/**
 * local-signal-report — run the universe-hydration indicator math locally and
 * emit an HTML + JSON report of the results, especially per-ticker signals.
 *
 * This is the "run it from my own terminal" path described in
 * docs/modal-deployment-and-local-triggering.md and
 * docs/running-universe-hydration-locally.md, minus the portal POST: it fetches
 * daily bars from Alpaca, computes the exact same indicators as
 * scripts/hydrate-local.mjs / deploy/universe-hydration/modal_app.py (shared
 * lib scripts/lib/hydrate-indicators.mjs), ranks the basket by confluence
 * score, and writes:
 *
 *   docs/local-signal-report.json   — machine-readable rows
 *   docs/local-signal-report.html   — standalone report, opens with file://
 *
 * Nothing is written to the database or the portal. No model is called.
 *
 * Usage:
 *   node scripts/local-signal-report.mjs
 *   node scripts/local-signal-report.mjs --symbols=AAPL,MSFT,NVDA
 *   node scripts/local-signal-report.mjs --symbols=AAPL,MSFT --etfs=SPY,QQQ
 *   node scripts/local-signal-report.mjs --lookback=180
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  adx,
  confluence,
  macdCross,
  rsi,
  volatilityPercentile,
} from "./lib/hydrate-indicators.mjs";

// ── env loading (same shape as hydrate-local.mjs) ─────────────────────────
let env = {};
try {
  const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  for (const line of envLocal.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)="?([^"]+)"?$/);
    if (m && m[1] && m[2]) env[m[1]] = m[2];
  }
} catch {
  /* .env.local absent — rely on process.env */
}

const ALPACA_API_KEY = process.env.ALPACA_API_KEY ?? env.ALPACA_API_KEY;
const ALPACA_API_SECRET = process.env.ALPACA_API_SECRET ?? env.ALPACA_API_SECRET;

if (!ALPACA_API_KEY) throw new Error("ALPACA_API_KEY is not set");
if (!ALPACA_API_SECRET) throw new Error("ALPACA_API_SECRET is not set");

// ── args ─────────────────────────────────────────────────────────────────
function flag(name, fallback = null) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function parseList(raw) {
  return raw
    ? raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];
}

const DEFAULT_STOCKS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD",
  "NFLX", "JPM", "XOM", "WMT", "UNH", "LLY", "AVGO", "COST", "BAC", "DIS",
];
const DEFAULT_ETFS = [
  "SPY", "QQQ", "IWM", "DIA", "GLD", "TLT", "XLE", "XLF", "SOXX", "ARKK",
];

const STOCKS = parseList(flag("symbols")) .length
  ? parseList(flag("symbols"))
  : DEFAULT_STOCKS;
const ETFS = flag("etfs") !== null ? parseList(flag("etfs")) : DEFAULT_ETFS;
const LOOKBACK_DAYS = Number(flag("lookback", "150")) || 150;
const MIN_BARS = 40;

// ── vendor fetch (ported from hydrate-local.mjs) ─────────────────────────
async function fetchBarsOnce(symbols) {
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const startIso = start.toISOString().split("T")[0];

  const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
  url.searchParams.set("symbols", symbols.join(","));
  url.searchParams.set("timeframe", "1Day");
  url.searchParams.set("start", startIso);
  url.searchParams.set("limit", "10000");
  url.searchParams.set("adjustment", "split");

  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_API_KEY,
      "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
    },
  });
  if (!res.ok) throw new Error(`Alpaca returned ${res.status}: ${await res.text()}`);
  return (await res.json()).bars || {};
}

/** One unusable symbol costs only itself (same retry logic as hydrate-local). */
async function fetchBars(symbols) {
  let remaining = [...symbols];
  const dropped = [];
  while (remaining.length > 0) {
    try {
      const bars = await fetchBarsOnce(remaining);
      return { bars, dropped };
    } catch (e) {
      const bad = /invalid symbol:\s*([^"'}\s]+)/i.exec(e.message)?.[1];
      if (!bad || !remaining.includes(bad)) throw e;
      dropped.push(bad);
      remaining = remaining.filter(s => s !== bad);
    }
  }
  return { bars: {}, dropped };
}

// ── per-symbol row (mirrors rowFor() in hydrate-local.mjs) ───────────────
function rowFor(symbol, universe, barData) {
  if (!barData || barData.length < MIN_BARS) {
    return { ticker: symbol, universe, status: "error", error: "insufficient history" };
  }
  try {
    const sorted = [...barData].sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const close = sorted.map(b => b.c);
    const high = sorted.map(b => b.h);
    const low = sorted.map(b => b.l);

    const rsiVal = rsi(close);
    const macdVal = macdCross(close);
    const adxVal = adx(high, low, close);
    const volVal = volatilityPercentile(close);
    const { score, direction } = confluence(
      rsiVal,
      macdVal === "missing" ? undefined : macdVal,
      adxVal
    );

    return {
      ticker: symbol,
      universe,
      status: "ok",
      lastClose: close.at(-1),
      lastBarDate: String(sorted.at(-1).t).split("T")[0],
      bars: close.length,
      rsi: rsiVal,
      adx: adxVal,
      macdCross: macdVal === "missing" ? null : macdVal,
      volatilityPercentile: volVal,
      confluenceScore: score,
      direction,
    };
  } catch (e) {
    return { ticker: symbol, universe, status: "error", error: `${e.name}: ${e.message}` };
  }
}

// ── html ─────────────────────────────────────────────────────────────────
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const num = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "—" : Number(v).toFixed(d));

function dirBadge(dir) {
  const map = { bullish: "bull", bearish: "bear", neutral: "neu" };
  return `<span class="badge ${map[dir] ?? "neu"}">${esc(dir ?? "n/a")}</span>`;
}

function rowHtml(r) {
  if (r.status !== "ok") {
    return `<tr class="err">
      <td>${esc(r.ticker)}</td><td>${esc(r.universe)}</td>
      <td colspan="8">error: ${esc(r.error)}</td></tr>`;
  }
  const w = Math.max(0, Math.min(100, Number(r.confluenceScore) || 0));
  return `<tr>
    <td class="tk">${esc(r.ticker)}</td>
    <td class="muted">${esc(r.universe)}</td>
    <td class="n">${num(r.lastClose, 2)}</td>
    <td class="n score" style="--w:${w}%">${num(r.confluenceScore)}</td>
    <td>${dirBadge(r.direction)}</td>
    <td class="n">${num(r.rsi)}</td>
    <td class="n">${num(r.adx)}</td>
    <td>${r.macdCross ? esc(r.macdCross) : "—"}</td>
    <td class="n">${num(r.volatilityPercentile)}</td>
    <td class="n muted">${esc(r.lastBarDate)}</td>
  </tr>`;
}

function buildHtml(rows, meta) {
  const ok = rows.filter(r => r.status === "ok");
  const ranked = [...ok].sort((a, b) => (b.confluenceScore ?? -1) - (a.confluenceScore ?? -1));
  const bull = ok.filter(r => r.direction === "bullish").length;
  const bear = ok.filter(r => r.direction === "bearish").length;
  const neu = ok.filter(r => r.direction === "neutral" || r.direction === null).length;
  const errs = rows.filter(r => r.status !== "ok");

  const topMovers = ranked.filter(r => (r.confluenceScore ?? 0) > 0);
  const head = `<tr><th>Ticker</th><th>Class</th><th class="n">Close</th><th class="n">Score</th><th>Direction</th><th class="n">RSI</th><th class="n">ADX</th><th>MACD cross</th><th class="n">Vol&nbsp;%ile</th><th class="n">Bar date</th></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Local Signal Report</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  /* Light palette on bare :root — neutrals carry a slight blue bias toward the accent. */
  :root {
    --bg: #f6f8fa; --panel: #ffffff; --panel2: #eef1f5; --line: #dde3ea;
    --ink: #1b2027; --muted: #5c6773; --accent: #2563eb;
    --bull: #15803d; --bear: #b91c1c; --neu: #5c6773;
    --score-fill: #dbeafe;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0e1116; --panel: #161b22; --panel2: #1c232c; --line: #2a323d;
      --ink: #e6edf3; --muted: #8b98a5; --accent: #58a6ff;
      --bull: #3fb950; --bear: #f85149; --neu: #8b98a5;
      --score-fill: #1f2d3d;
    }
  }
  :root[data-theme="dark"] {
    --bg: #0e1116; --panel: #161b22; --panel2: #1c232c; --line: #2a323d;
    --ink: #e6edf3; --muted: #8b98a5; --accent: #58a6ff;
    --bull: #3fb950; --bear: #f85149; --neu: #8b98a5;
    --score-fill: #1f2d3d;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
    font-size: 14px; line-height: 1.55;
    padding: 40px 20px 72px;
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
    text-wrap: balance;
  }
  .sub { color: var(--muted); margin: 0 0 28px; font-size: 13px; max-width: 62ch; }
  .sub b { color: var(--ink); font-weight: 500; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; margin-bottom: 8px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; }
  .card .k { color: var(--muted); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.7px; }
  .card .v {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 26px; font-weight: 500; margin-top: 6px; font-variant-numeric: tabular-nums;
  }
  .card .v small { font-size: 14px; color: var(--muted); }
  .v.bull { color: var(--bull); } .v.bear { color: var(--bear); }

  h2 {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--muted); font-weight: 600;
    margin: 36px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--line);
  }
  h2 .hint { text-transform: none; letter-spacing: 0; color: var(--muted); font-weight: 400; }

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
  td.tk {
    font-family: "IBM Plex Mono", ui-monospace, monospace;
    font-weight: 600; color: var(--accent);
  }
  .muted { color: var(--muted); }
  tr.err td { color: var(--bear); }

  .badge {
    display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px;
    font-family: "IBM Plex Mono", ui-monospace, monospace; border: 1px solid currentColor;
  }
  .badge.bull { color: var(--bull); } .badge.bear { color: var(--bear); } .badge.neu { color: var(--neu); }

  td.score {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-weight: 600;
    background-image: linear-gradient(to left, var(--score-fill) 0 var(--w, 0%), transparent var(--w, 0%));
  }

  footer { color: var(--muted); font-size: 12px; margin-top: 32px; line-height: 1.75; }
  footer b { color: var(--ink); font-weight: 600; }
  code {
    font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 12px;
    background: var(--panel2); padding: 1.5px 5px; border-radius: 4px;
  }
</style>
</head>
<body>
<div class="wrap">
  <p class="eyebrow">universe-hydration &middot; local run</p>
  <h1>Local Signal Report</h1>
  <p class="sub">
    The same indicator math as <code>hydrate-local.mjs</code> and the Modal job, run from a
    terminal against <b>Alpaca daily bars</b> &mdash; <b>${esc(String(meta.lookback))}-day</b> lookback,
    generated <b>${esc(meta.generatedAt)}</b>. Nothing was written to the database, the portal, or a model.
  </p>

  <div class="cards">
    <div class="card"><div class="k">Tickers scored</div><div class="v">${ok.length}<small> / ${rows.length}</small></div></div>
    <div class="card"><div class="k">Bullish</div><div class="v bull">${bull}</div></div>
    <div class="card"><div class="k">Bearish</div><div class="v bear">${bear}</div></div>
    <div class="card"><div class="k">Neutral</div><div class="v">${neu}</div></div>
    <div class="card"><div class="k">Errors</div><div class="v">${errs.length}</div></div>
  </div>

  ${topMovers.length ? `<h2>Signals with confluence <span class="hint">&mdash; score &gt; 0, at least one indicator voting</span></h2>
  <div class="scroll"><table>
    <thead>${head}</thead>
    <tbody>${topMovers.map(rowHtml).join("\n")}</tbody>
  </table></div>` : ""}

  <h2>Full basket <span class="hint">&mdash; ranked by confluence score</span></h2>
  <div class="scroll"><table>
    <thead>${head}</thead>
    <tbody>${ranked.map(rowHtml).join("\n")}${errs.map(rowHtml).join("\n")}</tbody>
  </table></div>

  <footer>
    <b>How to read this.</b> <code>Score</code> is indicator agreement 0&ndash;100 from
    <code>confluence(rsi, macdCross, adx)</code>: RSI&nbsp;&le;&nbsp;30 or a MACD bullish cross votes up,
    RSI&nbsp;&ge;&nbsp;70 or a MACD bearish cross votes down, and an ADX&nbsp;&ge;&nbsp;25 trending tape
    amplifies the agreement by 1.25&times;. <code>Direction</code> is the sign of the net vote. A wall of
    zeros over a short window is expected &mdash; the indicators need history before they say anything, and
    a daily MACD cross is a rare event.<br>
    Regenerate with <code>node scripts/local-signal-report.mjs</code> &middot; raw rows in
    <code>docs/local-signal-report.json</code>.
  </footer>
</div>
</body>
</html>
`;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const lanes = [
    { universe: "stock", targets: STOCKS },
    { universe: "etf", targets: ETFS },
  ].filter(l => l.targets.length);

  console.log(
    `[local-signal-report] ${lanes.map(l => `${l.universe}=${l.targets.length}`).join(" ")} lookback=${LOOKBACK_DAYS}d`
  );

  const rows = [];
  for (const { universe, targets } of lanes) {
    for (let i = 0; i < targets.length; i += 10) {
      const chunk = targets.slice(i, i + 10);
      const { bars, dropped } = await fetchBars(chunk);
      if (dropped.length) console.log(`  (skipped unusable: ${dropped.join(", ")})`);
      for (const sym of chunk) {
        const r = rowFor(sym, universe, bars[sym]);
        rows.push(r);
        if (r.status === "ok") {
          console.log(`  ${r.ticker.padEnd(6)} ${universe.padEnd(5)} score=${num(r.confluenceScore)} dir=${r.direction} rsi=${num(r.rsi)} adx=${num(r.adx)} macd=${r.macdCross ?? "-"}`);
        } else {
          console.log(`  ${r.ticker.padEnd(6)} ${universe.padEnd(5)} ERROR ${r.error}`);
        }
      }
    }
  }

  const meta = {
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 16) + "Z",
    lookback: LOOKBACK_DAYS,
    source: "alpaca:1Day",
  };

  const jsonPath = join(process.cwd(), "docs", "local-signal-report.json");
  const htmlPath = join(process.cwd(), "docs", "local-signal-report.html");
  const artifactPath = join(process.cwd(), "docs", "local-signal-report.artifact.html");
  const fullHtml = buildHtml(rows, meta);
  writeFileSync(jsonPath, JSON.stringify({ meta, rows }, null, 2) + "\n");
  writeFileSync(htmlPath, fullHtml);
  // Artifact variant: the Artifact tool supplies its own <!doctype>/<html>/<head>/<body>
  // skeleton, so hand it just the inner content (the <title>, <link>, <style> and
  // markup are all valid inside <body> and the CSP admits Google Fonts).
  writeFileSync(
    artifactPath,
    fullHtml
      .replace(/^<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, "")
      .replace(/<meta[^>]*>\s*/gi, "")
      .replace(/<\/head>\s*<body>\s*/i, "")
      .replace(/<\/body>\s*<\/html>\s*$/i, "")
  );

  const ok = rows.filter(r => r.status === "ok").length;
  console.log(`\n[done] ${ok}/${rows.length} scored`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${htmlPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
