/**
 * Folds a Playwright JSON-reporter run into .nulogdash/latest.json as
 * tier: "browser" FeatureResults — the browser tier docs/nulogdash-dashboard-plan.md
 * describes as "a later phase" and lib/nulogdash.ts's FeatureResult.tier
 * already types as "api" | "browser" | null in anticipation of.
 *
 * Run after `npx playwright test` (which writes .nulogdash/e2e-raw.json via
 * the json reporter in playwright.config.ts):
 *
 *   npx playwright test
 *   node scripts/nulogdash-merge-e2e.mjs
 *
 * Or together:
 *
 *   npm run test:e2e:nulogdash
 *
 * Writes:
 *   - .nulogdash/latest.json  — api-tier results (if any) preserved, browser-tier appended
 *   - .nulogdash/runs/<runId>.json — same content, timestamped (matches nulogdash.mjs's pattern)
 *   - stdout: a ready-to-paste `## [{date}] ...` line for docs/wiki-portal/log.md,
 *     per ~/.claude/CLAUDE.md "Update the Project Wiki on PR Creation" and the
 *     wiki skill's ingest workflow — this script does not write the wiki
 *     itself (that stays an LLM/human decision), it only prepares the fact.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const RAW_FILE = join(ROOT, ".nulogdash", "e2e-raw.json");
const RUNS_DIR = join(ROOT, ".nulogdash", "runs");
const LATEST_FILE = join(ROOT, ".nulogdash", "latest.json");

// Same redaction set as scripts/nulogdash.mjs — Playwright error messages
// can embed request bodies/headers, and this file is read by a page humans
// (and this script's own log-line suggestion) will look at.
const SECRET_PATTERNS = [
  /sk_(live|test)_[A-Za-z0-9]+/g,
  /pk_(live|test)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /sk-ant-[A-Za-z0-9-]+/g,
  /sk-or-v1-[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._-]+/g,
  // e2e-resiliency.yml passes DATABASE_URL to the dev server these tests
  // drive, so a boot/connection error can embed the connection string
  // (password included) verbatim in a Playwright error message.
  /(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s"']+/gi,
  // E2E_CLERK_TEST_EMAIL is a user identifier, not a secret, but this file
  // is rendered on a page — keep it out of a stored report regardless.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

function redact(text) {
  if (!text) return text;
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out.length > 500 ? out.slice(0, 500) + "…[truncated]" : out;
}

// Playwright test titles are written as "DIAGNOSE: ..." / "EXPOSE: ..." /
// plain sentences (see e2e/**/*.spec.ts) — carry that prefix into `feature`
// so the dashboard groups by diagnostic intent, same spirit as nulogdash's
// pass/fail/blocked/not_run distinction.
function toFeatureSlug(projectName, filePath, title) {
  const file = filePath.split("/").pop()?.replace(/\.spec\.ts$/, "") ?? "unknown";
  return `${projectName}:${file}:${title}`.slice(0, 120);
}

function statusFromOutcome(outcome) {
  // Playwright JSON reporter per-spec status values: "expected" | "unexpected"
  // | "flaky" | "skipped". Map onto FeatureStatus so the dashboard's existing
  // pass/fail/blocked/not_run styling (nld-badge--*) just works.
  if (outcome === "skipped") return "not_run";
  if (outcome === "expected") return "pass";
  if (outcome === "flaky") return "pass"; // passed on retry — real signal, but not a fail
  return "fail";
}

function collectSpecs(suites, filePath = "") {
  const specs = [];
  for (const suite of suites ?? []) {
    const currentFile = suite.file ?? filePath;
    if (Array.isArray(suite.specs)) {
      for (const spec of suite.specs) {
        specs.push({ ...spec, file: currentFile });
      }
    }
    if (Array.isArray(suite.suites)) {
      specs.push(...collectSpecs(suite.suites, currentFile));
    }
  }
  return specs;
}

function main() {
  if (!existsSync(RAW_FILE)) {
    console.error(
      `No Playwright JSON report at ${RAW_FILE} — run 'npx playwright test' first ` +
        `(playwright.config.ts's json reporter writes it automatically).`,
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(RAW_FILE, "utf8"));
  const specs = collectSpecs(raw.suites);

  const results = specs.map((spec) => {
    const test = spec.tests?.[0]; // one project per test in this config's projects[]
    const projectName = test?.projectName ?? "unknown";
    const outcome = test?.status ?? "skipped"; // "expected" | "unexpected" | "flaky" | "skipped"
    const status = statusFromOutcome(outcome);
    const lastResult = test?.results?.at(-1);
    const errorMessage = lastResult?.error?.message ?? lastResult?.errors?.[0]?.message ?? null;

    return {
      feature: toFeatureSlug(projectName, spec.file ?? "", spec.title),
      label: spec.title,
      entrypoints: [`${projectName} :: ${spec.file ?? "unknown"}`],
      tier: "browser",
      dependencies: [], // Playwright's own preflight/health projects already gate this — see e2e/
      latencyMs: typeof lastResult?.duration === "number" ? lastResult.duration : null,
      status,
      reason: status === "pass" ? null : redact(errorMessage ?? `${outcome} with no captured error`),
    };
  });

  if (results.length === 0) {
    console.error("Playwright JSON report parsed but produced zero specs — nothing to merge.");
    process.exit(1);
  }

  let gitSha = "unknown";
  let branch = "unknown";
  try {
    gitSha = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: ROOT }).toString().trim();
  } catch { /* not fatal */ }

  // Preserve any existing api-tier run (from scripts/nulogdash.mjs) rather
  // than clobbering it — the dashboard is meant to show both tiers from the
  // most recent pass of each, per docs/nulogdash-dashboard-plan.md.
  const existing = existsSync(LATEST_FILE) ? JSON.parse(readFileSync(LATEST_FILE, "utf8")) : null;
  const apiResults = existing?.results?.filter((r) => r.tier === "api") ?? [];
  const otherExcluded = existing?.excluded ?? [];
  const otherDrift = existing?.driftWarnings ?? [];

  const run = {
    runId: `${Date.now()}`,
    runAt: new Date().toISOString(),
    gitSha,
    branch,
    // `||` not `??` — NULOGDASH_BASE_URL ships empty in .env.example, and
    // dotenv loads an empty var as "" (not undefined), which `??` won't
    // fall back on. Same fix as playwright.config.ts.
    baseUrl: process.env.NULOGDASH_BASE_URL || "http://localhost:3000",
    tiers: [...new Set([...(existing?.tiers ?? []), "browser"])],
    results: [...apiResults, ...results],
    excluded: otherExcluded,
    driftWarnings: otherDrift,
  };

  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(join(RUNS_DIR, `${run.runId}.json`), JSON.stringify(run, null, 2));
  writeFileSync(LATEST_FILE, JSON.stringify(run, null, 2));

  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {});
  console.log("");
  console.log(`nulogdash (browser tier): ${counts.pass ?? 0} pass, ${counts.fail ?? 0} fail, ${counts.not_run ?? 0} not_run`);
  console.log(`Merged into .nulogdash/latest.json — view at ${run.baseUrl}/dashboard/nulogdash`);

  // Ready-to-paste wiki log.md line — see ~/.claude/CLAUDE.md's
  // "Update the Project Wiki on PR Creation" and docs/wiki-portal/SCHEMA.md's
  // log format. Printed, not written: the wiki skill's ingest workflow
  // synthesizes into entity/concept pages first, and log.md lines follow
  // that synthesis rather than raw test counts.
  const today = new Date().toISOString().slice(0, 10);
  console.log("");
  console.log("Wiki log.md line (paste after synthesizing into entity-playwright-e2e.md if this run found something new):");
  console.log(
    `## [${today}] ingest | e2e run ${run.runId} (${branch}@${gitSha}) | browser: ${counts.pass ?? 0} pass, ${counts.fail ?? 0} fail, ${counts.not_run ?? 0} not_run | pages touched: 0`,
  );

  if ((counts.fail ?? 0) > 0) process.exitCode = 1;
}

main();
