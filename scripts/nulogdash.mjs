/**
 * /nulogdash runner — fires every feature in docs/nulogdash-inventory.json
 * (tier "api" only; browser tier is a later phase, see
 * docs/nulogdash-dashboard-plan.md) against a running `next dev` server,
 * classifies each as pass/fail/blocked/not_run, and writes the result to
 * .nulogdash/latest.json (+ a timestamped copy under .nulogdash/runs/) so
 * app/dashboard/nulogdash can render it.
 *
 *   node --env-file=.env.local scripts/nulogdash.mjs
 *   node --env-file=.env.local scripts/nulogdash.mjs --feature holdfold
 *
 * Env:
 *   NULOGDASH_BASE_URL       default http://localhost:3000
 *   NULOGDASH_SESSION_COOKIE a real Clerk __session cookie value for a
 *                            dedicated test user (copy from browser devtools).
 *                            Without it, every auth-required feature reports
 *                            `blocked` rather than being silently skipped.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const INVENTORY_FILE = join(ROOT, "docs", "nulogdash-inventory.json");
const RUNS_DIR = join(ROOT, ".nulogdash", "runs");
const LATEST_FILE = join(ROOT, ".nulogdash", "latest.json");

const BASE_URL = process.env.NULOGDASH_BASE_URL ?? "http://localhost:3000";
const SESSION_COOKIE = process.env.NULOGDASH_SESSION_COOKIE ?? "";
const REQUEST_TIMEOUT_MS = 10_000;

const args = process.argv.slice(2);
const featureFilterIdx = args.indexOf("--feature");
const featureFilter = featureFilterIdx >= 0 ? args[featureFilterIdx + 1] : null;

// ---------------------------------------------------------------------------
// Secret redaction — reasons are persisted to disk and eventually rendered
// on a dashboard page. Scrub at write time, not render time.
// ---------------------------------------------------------------------------
const SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9]+/g,
  /pk_(live|test)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > 500 ? out.slice(0, 500) + "…[truncated]" : out;
}

// ---------------------------------------------------------------------------
// Dependency preflight — mirrors app/api/health/route.ts's checks, done
// standalone here since this script runs outside the Next.js request
// lifecycle. A dependency that's down/not_configured makes every feature
// that needs it `blocked`, not `fail` — see docs/nulogdash-dashboard-plan.md
// on why that distinction matters.
// ---------------------------------------------------------------------------
async function withTimeout(fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkDependencies() {
  const deps = {};

  deps.neon = process.env.DATABASE_URL
    ? { ok: true }
    : { ok: false, reason: "DATABASE_URL not set" };

  deps.openrouter = process.env.OPENROUTER_API_KEY
    ? { ok: true }
    : { ok: false, reason: "OPENROUTER_API_KEY not set" };

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceMonthly = process.env.STRIPE_PRICE_MONTHLY ?? "";
  const priceAnnual = process.env.STRIPE_PRICE_ANNUAL ?? "";
  if (!stripeKey) {
    deps.stripe = { ok: false, reason: "STRIPE_SECRET_KEY not set" };
  } else if (!priceMonthly || priceMonthly.includes("placeholder") || !priceAnnual || priceAnnual.includes("placeholder")) {
    deps.stripe = { ok: false, reason: "STRIPE_PRICE_MONTHLY/ANNUAL unset or placeholder" };
  } else {
    deps.stripe = { ok: true };
  }

  const mcpUrl = process.env.MCP_BACKEND_URL ?? "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
  try {
    const res = await withTimeout((signal) => fetch(`${mcpUrl}/health`, { signal }));
    deps.mcp = res.ok ? { ok: true } : { ok: false, reason: `MCP backend returned ${res.status}` };
  } catch (err) {
    deps.mcp = { ok: false, reason: `MCP backend unreachable: ${err instanceof Error ? err.message : "unknown"}` };
  }

  // Session is a "dependency" in the same sense: without it every auth
  // feature is blocked, not individually failing for the same root cause.
  deps.session = SESSION_COOKIE
    ? { ok: true }
    : { ok: false, reason: "NULOGDASH_SESSION_COOKIE not set — see docs/nulogdash-dashboard-plan.md" };

  try {
    const res = await withTimeout((signal) => fetch(`${BASE_URL}/api/health`, { signal }));
    deps.devServer = res.ok || res.status < 500
      ? { ok: true }
      : { ok: false, reason: `dev server at ${BASE_URL} returned ${res.status}` };
  } catch (err) {
    deps.devServer = { ok: false, reason: `dev server unreachable at ${BASE_URL} — run 'npm run dev' first (${err instanceof Error ? err.message : "unknown"})` };
  }

  return deps;
}

// ---------------------------------------------------------------------------
// Run a single feature
// ---------------------------------------------------------------------------
async function runFeature(feature, deps) {
  const base = {
    feature: feature.slug,
    label: feature.label,
    entrypoints: [`${feature.method} ${feature.path}`],
    tier: "api",
    dependencies: feature.dependencies,
    latencyMs: null,
  };

  if (!deps.devServer.ok) {
    return { ...base, status: "blocked", reason: deps.devServer.reason };
  }

  if (feature.auth && !deps.session.ok) {
    return { ...base, status: "blocked", reason: deps.session.reason };
  }

  const unmetDep = feature.dependencies.find((d) => deps[d] && !deps[d].ok);
  if (unmetDep) {
    return { ...base, status: "blocked", reason: `${unmetDep}: ${deps[unmetDep].reason}` };
  }

  const url = `${BASE_URL}${feature.path}`;
  const headers = { "content-type": "application/json" };
  if (feature.auth) headers.cookie = `__session=${SESSION_COOKIE}`;

  const start = Date.now();
  try {
    const res = await withTimeout((signal) =>
      fetch(url, {
        method: feature.method,
        headers,
        body: feature.body !== undefined ? JSON.stringify(feature.body) : undefined,
        signal,
      }),
    );
    const latencyMs = Date.now() - start;
    if (res.ok) {
      return { ...base, status: "pass", latencyMs, reason: null };
    }
    const bodyText = await res.text().catch(() => "");
    return { ...base, status: "fail", latencyMs, reason: redact(`HTTP ${res.status}: ${bodyText}`) };
  } catch (err) {
    return {
      ...base,
      status: "fail",
      latencyMs: Date.now() - start,
      reason: redact(err instanceof Error ? err.message : "request threw"),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(INVENTORY_FILE)) {
    console.error(`No inventory found at ${INVENTORY_FILE} — run 'node scripts/nulogdash-inventory.mjs' first.`);
    process.exit(1);
  }
  const inventory = JSON.parse(readFileSync(INVENTORY_FILE, "utf8"));
  const deps = await checkDependencies();

  let features = inventory.features;
  if (featureFilter) features = features.filter((f) => f.slug === featureFilter);

  const results = [];
  for (const feature of features) {
    const result = await runFeature(feature, deps);
    results.push(result);
    const icon = { pass: "✓", fail: "✗", blocked: "◐", not_run: "○" }[result.status];
    console.log(`  ${icon} ${result.status.padEnd(8)} ${feature.slug.padEnd(28)} ${result.latencyMs !== null ? `${result.latencyMs}ms` : ""}`);
    if (result.reason) console.log(`      ${result.reason}`);
  }

  for (const ex of inventory.excluded) {
    results.push({
      feature: ex.feature,
      label: ex.feature,
      entrypoints: [ex.path],
      tier: null,
      dependencies: [],
      latencyMs: null,
      status: "not_run",
      reason: `excluded: ${ex.reason}`,
    });
  }

  let gitSha = "unknown";
  let branch = "unknown";
  try {
    gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT }).toString().trim();
  } catch { /* not fatal — git may be unavailable in some run contexts */ }

  const run = {
    runId: `${Date.now()}`,
    runAt: new Date().toISOString(),
    gitSha,
    branch,
    baseUrl: BASE_URL,
    tiers: ["api"],
    results,
    excluded: inventory.excluded,
    driftWarnings: inventory.driftWarnings,
  };

  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, `${run.runId}.json`), JSON.stringify(run, null, 2));
  writeFileSync(LATEST_FILE, JSON.stringify(run, null, 2));

  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
  const notExercised = (counts.blocked ?? 0) + (counts.not_run ?? 0);

  console.log("");
  console.log(`nulogdash: ${counts.pass ?? 0} pass, ${counts.fail ?? 0} fail, ${counts.blocked ?? 0} blocked, ${counts.not_run ?? 0} not_run`);
  console.log(`${notExercised} of ${results.length} features not run end-to-end this pass.`);
  if (inventory.driftWarnings.length > 0) {
    console.log(`${inventory.driftWarnings.length} inventory drift warning(s) — run the inventory generator and check docs/nulogdash-inventory.json.`);
  }
  console.log(`Run written to .nulogdash/latest.json — view at ${BASE_URL}/dashboard/nulogdash`);

  if ((counts.fail ?? 0) > 0) process.exitCode = 1;
}

main();
