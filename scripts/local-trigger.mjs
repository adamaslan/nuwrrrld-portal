#!/usr/bin/env node
/**
 * local-trigger — one entry point for every way to fire a GitHub Actions
 * workflow in this repo, local or remote.
 *
 * It is the executable form of docs/github-actions-deployment-and-local-triggering.md:
 * that doc describes four independent trigger paths and a table of workflows →
 * endpoints → scripts; this script encodes the same table and runs any cell of it.
 *
 *   Path A  gh workflow run ......... the real workflow, real runner, real secrets
 *   Path B  act .................... the workflow YAML locally in Docker
 *   Path C  call the endpoint ...... the deployed route the workflow POSTs to
 *   Path D  run the script ......... the underlying script against your checkout
 *
 * Reach for the cheapest path that reproduces what you are chasing. Most
 * "the workflow is broken" reports are Path C or Path D problems.
 *
 * Usage:
 *   node scripts/local-trigger.mjs list
 *   node scripts/local-trigger.mjs <A|B|C|D> <workflow> [options]
 *
 * Options:
 *   --input k=v     (repeatable) dispatch input        [Path A]
 *   --ref <branch>  run the workflow file from a ref   [Path A]
 *   --job <name>    run a single job                   [Path B]
 *   --local         hit http://localhost:3000          [Path C]
 *   --url <base>    hit an explicit base URL           [Path C]
 *   --no-dry-run    send dry_run:false (WRITES TO PROD); requires --yes  [Path C]
 *   --yes           confirm a --no-dry-run call        [Path C]
 *   --print         print the commands/requests, run nothing
 *
 * Examples:
 *   node scripts/local-trigger.mjs D ci
 *   node scripts/local-trigger.mjs C track-followed-tickers
 *   node scripts/local-trigger.mjs C afternoon-pipeline --local
 *   node scripts/local-trigger.mjs A hydrate-universe --input universe=stock --input limit=5 --input dryRun=true
 *   node scripts/local-trigger.mjs B ci --job test
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const DEFAULT_PORTAL_URL = "https://financial.nuwrrrld.com";

// ── Workflow registry ─────────────────────────────────────────────────────
// Mirrors docs/github-actions-deployment-and-local-triggering.md §1 and §4.
// dispatch:   can `gh workflow run` / the Actions UI fire it (workflow_dispatch)
// inputs:     dispatch input names (Path A help + validation)
// calls:      ordered endpoint calls the workflow makes (Path C)
//               { path, session?, dryRunnable, body(dryRun) -> object }
// scripts:    shell commands that do the workflow's work locally (Path D)
const WORKFLOWS = {
  // ── Shape 1: CI (event-driven) ─────────────────────────────────────────
  ci: {
    file: "ci.yml",
    shape: "ci",
    dispatch: false,
    scripts: [
      "npm run lint",
      "npm test",
      "node scripts/check-shared-drift.mjs",
    ],
  },
  "e2e-resiliency": {
    file: "e2e-resiliency.yml",
    shape: "ci",
    dispatch: false,
    scripts: ["npm run test:e2e"],
  },
  "integration-tests": {
    file: "integration-tests.yml",
    shape: "ci",
    dispatch: true,
    inputs: [],
    scripts: ["npm run db:migrate", "npm run test:integration"],
  },

  // ── Shape 2: scheduled callers (cron → curl a deployed route) ──────────
  "afternoon-pipeline": {
    file: "afternoon-pipeline.yml",
    shape: "caller",
    dispatch: true,
    inputs: ["skip_market_check", "dry_run"],
    calls: [
      { path: "/api/pipeline/signals-refresh", session: "afternoon", dryRunnable: true },
      { path: "/api/pipeline/theses-score", session: "afternoon", dryRunnable: true },
      { path: "/api/pipeline/council-run", session: "afternoon", dryRunnable: true },
      { path: "/api/pipeline/council-validate-distribution", dryRunnable: false },
    ],
  },
  "track-followed-tickers": {
    file: "track-followed-tickers.yml",
    shape: "caller",
    dispatch: true,
    inputs: ["skip_market_check", "dry_run"],
    calls: [
      {
        path: "/api/pipeline/followed-tickers",
        session: "followed-daily",
        dryRunnable: true,
      },
    ],
  },
  "select-followed-tickers": {
    file: "select-followed-tickers.yml",
    shape: "caller",
    dispatch: true,
    inputs: ["dry_run", "universe"],
    calls: [
      {
        path: "/api/pipeline/followed-tickers-select",
        dryRunnable: true,
        body: (dryRun) => ({ universe: "stock", count: 10, dry_run: dryRun }),
      },
    ],
  },
  "judge-followed-tickers": {
    file: "judge-followed-tickers.yml",
    shape: "caller",
    dispatch: true,
    inputs: ["dry_run"],
    calls: [
      {
        path: "/api/pipeline/followed-tickers-judge",
        dryRunnable: true,
        body: (dryRun) => ({ dry_run: dryRun }),
      },
    ],
  },
  "hydrate-universe": {
    file: "hydrate-universe.yml",
    shape: "caller",
    dispatch: true,
    inputs: ["universe", "limit", "dryRun"],
    // The workflow runs the script, not a raw curl. Path C == the script in
    // dry-run against a portal; Path D == the same without dry-run.
    endpointNote: "/api/pipeline/hydrate-universe (POSTed by hydrate-local.mjs)",
    scriptForC: "node scripts/hydrate-local.mjs --dry-run --limit=5",
    scripts: ["node scripts/hydrate-local.mjs"],
  },
  "precompute-ai": {
    file: "precompute-ai.yml",
    shape: "caller",
    dispatch: true,
    inputs: ["maxSubjects"],
    calls: [
      {
        path: "/api/pipeline/precompute-ai",
        dryRunnable: false,
        body: () => ({ maxSubjects: 3 }),
      },
    ],
  },

  // ── Shape 3: scheduled committers (cron → run a script → open a PR) ────
  "refresh-free-models": {
    file: "refresh-free-models.yml",
    shape: "committer",
    dispatch: true,
    inputs: [],
    scripts: ["node scripts/refresh-free-models.mjs"],
    remote: "bash scripts/run-refresh-remote.sh",
  },
  "compile-grounding-pack": {
    file: "compile-grounding-pack.yml",
    shape: "committer",
    dispatch: true,
    inputs: [],
    scripts: ["node scripts/compile_grounding_pack.mjs"],
  },
};

const ALIASES = {
  afternoon: "afternoon-pipeline",
  track: "track-followed-tickers",
  select: "select-followed-tickers",
  judge: "judge-followed-tickers",
  hydrate: "hydrate-universe",
  precompute: "precompute-ai",
  "refresh-models": "refresh-free-models",
  grounding: "compile-grounding-pack",
  e2e: "e2e-resiliency",
  integration: "integration-tests",
};

// ── arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const positional = [];
  const opts = { input: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") opts.input.push(argv[++i]);
    else if (a === "--ref") opts.ref = argv[++i];
    else if (a === "--job") opts.job = argv[++i];
    else if (a === "--url") opts.url = argv[++i];
    else if (a === "--local") opts.local = true;
    else if (a === "--no-dry-run") opts.noDryRun = true;
    else if (a === "--yes") opts.yes = true;
    else if (a === "--print") opts.print = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else positional.push(a);
  }
  return { positional, opts };
}

function resolveWorkflow(name) {
  if (!name) return null;
  const key = ALIASES[name] || name.replace(/\.yml$/, "");
  return WORKFLOWS[key] ? { key, ...WORKFLOWS[key] } : null;
}

function loadEnvLocal() {
  const p = join(REPO_ROOT, ".env.local");
  const env = {};
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[m[1]] = v;
  }
  return env;
}

function run(cmd, extraEnv = {}) {
  console.log(`\n\x1b[36m$ ${cmd}\x1b[0m`);
  const r = spawnSync(cmd, {
    shell: true,
    stdio: "inherit",
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
  });
  return r.status ?? 1;
}

// ── path implementations ─────────────────────────────────────────────────
function pathList() {
  console.log("workflow                    shape      dispatch  paths");
  console.log("─".repeat(64));
  for (const [key, w] of Object.entries(WORKFLOWS)) {
    const paths = [
      w.dispatch ? "A" : " ",
      "B",
      w.calls || w.scriptForC ? "C" : " ",
      w.scripts ? "D" : " ",
    ].join("");
    console.log(
      `${key.padEnd(27)} ${w.shape.padEnd(10)} ${
        (w.dispatch ? "yes" : "no").padEnd(8)
      } ${paths}`,
    );
  }
  console.log(
    "\nAliases: " +
      Object.entries(ALIASES)
        .map(([a, t]) => `${a}→${t}`)
        .join(", "),
  );
}

function pathA(w, opts) {
  if (!w.dispatch) {
    console.error(
      `\x1b[31m${w.key} has no workflow_dispatch trigger — it fires on push/pull_request only.\x1b[0m\n` +
        `Use Path B (act ${w.file}) or Path D (${(w.scripts || []).join(" && ")}).`,
    );
    return 2;
  }
  const known = new Set(w.inputs || []);
  const flags = [];
  for (const kv of opts.input) {
    const [k] = kv.split("=");
    if (known.size && !known.has(k)) {
      console.error(
        `\x1b[33mwarning: '${k}' is not a known input for ${w.key} (known: ${
          [...known].join(", ") || "none"
        })\x1b[0m`,
      );
    }
    flags.push(`-f ${kv}`);
  }
  const ref = opts.ref ? ` --ref ${opts.ref}` : "";
  const cmd = `gh workflow run ${w.file}${ref} ${flags.join(" ")}`.trim();
  if (opts.print) return console.log(cmd), 0;
  const status = run(cmd);
  if (status === 0) {
    run(`gh run list --workflow=${w.file} --limit 3`);
    console.log(
      `\nWatch it:  gh run watch --exit-status\nFailed logs only:  gh run view <id> --log-failed`,
    );
  }
  return status;
}

function pathB(w, opts) {
  const probe = spawnSync("act", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    console.error(
      "\x1b[31mact is not installed.\x1b[0m  brew install act\n" +
        "Apple Silicon: act --container-architecture linux/amd64 -l",
    );
    return 2;
  }
  const evt = w.dispatch ? "workflow_dispatch" : "pull_request";
  const job = opts.job ? ` -j ${opts.job}` : "";
  const secretFile = existsSync(join(REPO_ROOT, ".secrets"))
    ? " --secret-file .secrets"
    : "";
  const cmd =
    `act ${evt} -W .github/workflows/${w.file}${job}${secretFile}`.trim();
  if (opts.print) return console.log(cmd), 0;
  if (!secretFile && (w.calls || w.shape === "caller")) {
    console.log(
      "\x1b[33mnote: no .secrets file — caller workflows will 401. See the doc's Path B section.\x1b[0m",
    );
  }
  return run(cmd);
}

async function pathC(w, opts) {
  const env = { ...loadEnvLocal(), ...process.env };
  const base = opts.url
    ? opts.url.replace(/\/$/, "")
    : opts.local
      ? "http://localhost:3000"
      : (env.PORTAL_URL || DEFAULT_PORTAL_URL).replace(/\/$/, "");

  // hydrate-universe is script-driven, not a raw curl.
  if (!w.calls && w.scriptForC) {
    if (opts.print) return console.log(w.scriptForC), 0;
    console.log(`(hydrate runs against ${base})`);
    return run(w.scriptForC, { PORTAL_URL: base });
  }
  if (!w.calls) {
    console.error(
      `\x1b[31m${w.key} does not call an endpoint. Try Path D: ${
        (w.scripts || []).join(" && ")
      }\x1b[0m`,
    );
    return 2;
  }

  const dryRun = !opts.noDryRun;
  if (!dryRun && !opts.yes) {
    console.error(
      "\x1b[31m--no-dry-run writes to production. Re-run with --yes to confirm.\x1b[0m",
    );
    return 2;
  }
  const secret = env.CRON_SECRET;
  if (!secret && !opts.print) {
    console.error(
      "\x1b[31mCRON_SECRET not found in .env.local or the environment.\x1b[0m",
    );
    return 2;
  }

  let worst = 0;
  for (const call of w.calls) {
    const body = call.body
      ? call.body(dryRun)
      : {
          ...(call.dryRunnable ? { dry_run: dryRun } : {}),
          ...(call.session ? { session: call.session } : {}),
        };
    const url = `${base}${call.path}`;
    if (opts.print) {
      console.log(
        `curl -X POST ${url} -H 'Authorization: Bearer $CRON_SECRET' -d '${
          JSON.stringify(body)
        }'`,
      );
      continue;
    }
    process.stdout.write(`\n\x1b[36mPOST ${url}\x1b[0m  ${JSON.stringify(body)}\n`);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      const ms = Date.now() - started;
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
      console.log(`\x1b[${res.ok ? 32 : 31}mHTTP ${res.status}\x1b[0m  ${ms}ms`);
      console.log(pretty.slice(0, 4000));
      if (!res.ok) worst = res.status;
    } catch (err) {
      console.error(`\x1b[31mrequest failed: ${err.message}\x1b[0m`);
      worst = 1;
    }
  }
  return worst && worst >= 400 ? 1 : worst;
}

function pathD(w, opts) {
  if (!w.scripts) {
    console.error(
      `\x1b[31m${w.key} has no local script equivalent. Try Path C.\x1b[0m`,
    );
    return 2;
  }
  if (opts.print) {
    w.scripts.forEach((s) => console.log(s));
    if (w.remote) console.log(`# remote wrapper: ${w.remote}`);
    return 0;
  }
  let status = 0;
  for (const s of w.scripts) {
    const code = run(s);
    if (code !== 0) {
      status = code;
      console.error(`\x1b[31mstep failed (exit ${code}): ${s}\x1b[0m`);
      break;
    }
  }
  if (w.remote) {
    console.log(
      `\nPortable remote equivalent (runs anywhere with bash+git+node):\n  ${w.remote}`,
    );
  }
  return status;
}

// ── main ─────────────────────────────────────────────────────────────────
const USAGE = `local-trigger — fire any workflow via any of the four paths

  node scripts/local-trigger.mjs list
  node scripts/local-trigger.mjs <A|B|C|D> <workflow> [options]

  A  gh workflow run   real runner, real secrets   (needs workflow_dispatch)
  B  act               workflow YAML in Docker
  C  endpoint call     the route the workflow POSTs (dry-run by default)
  D  local script      the underlying script(s)

Options: --input k=v  --ref <b>  --job <j>  --local  --url <base>  --no-dry-run --yes  --print

See docs/github-actions-deployment-and-local-triggering.md for the full story.`;

async function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const [rawPath, rawWorkflow] = positional;

  if (opts.help || !rawPath) {
    console.log(USAGE);
    return rawPath ? 0 : 1;
  }
  if (rawPath === "list" || rawPath === "ls") {
    pathList();
    return 0;
  }

  const path = rawPath.toUpperCase();
  if (!["A", "B", "C", "D"].includes(path)) {
    console.error(`unknown path '${rawPath}' — expected A, B, C, D, or 'list'`);
    return 1;
  }
  const w = resolveWorkflow(rawWorkflow);
  if (!w) {
    console.error(
      `unknown workflow '${rawWorkflow}'. Run: node scripts/local-trigger.mjs list`,
    );
    return 1;
  }

  if (path === "A") return pathA(w, opts);
  if (path === "B") return pathB(w, opts);
  if (path === "C") return await pathC(w, opts);
  if (path === "D") return pathD(w, opts);
  return 1;
}

main().then((code) => process.exit(code ?? 0));
