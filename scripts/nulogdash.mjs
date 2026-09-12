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
 *   NULOGDASH_SESSION_COOKIE optional escape hatch: an explicit Clerk
 *                            __session cookie value. Not needed any more —
 *                            when unset the sweep mints a session token for
 *                            E2E_CLERK_TEST_EMAIL from CLERK_SECRET_KEY and
 *                            presents it as a bearer token. See
 *                            scripts/lib/nulogdash-auth.mjs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolveSessionAuth } from "./lib/nulogdash-auth.mjs";

const ROOT = process.cwd();
const INVENTORY_FILE = join(ROOT, "docs", "nulogdash-inventory.json");
const RUNS_DIR = join(ROOT, ".nulogdash", "runs");
const LATEST_FILE = join(ROOT, ".nulogdash", "latest.json");

// `??` only guards against undefined — an env var set to an empty string
// (NULOGDASH_BASE_URL= with nothing after it, a common .env.local state) would
// otherwise pass straight through and every probe would fail with
// "Failed to parse URL from /api/health". Trim and treat blank as unset.
const BASE_URL = process.env.NULOGDASH_BASE_URL?.trim() || "http://localhost:3000";
// 25s, not 10s. Nine features failed the 2026-09-11 sweep purely as "This
// operation was aborted", and every one of them was a first-request `next dev`
// route compile rather than a slow handler — GET /api/disclaimer aborted at 10s
// and the POST on the same already-compiled route answered in 523ms right
// after. A sweep that reports compile latency as a feature defect is worse than
// a slow sweep. Override with NULOGDASH_TIMEOUT_MS.
const envTimeout = Number(process.env.NULOGDASH_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 25_000;

// Any feature that calls a model needs a budget shaped by the model path, not
// by HTTP norms. `runSeat` allows 20s per attempt and walks a primary plus a
// 5-deep fallback chain, and the verdict-repair loop can add another pass — so
// a *correctly working* single-seat call has a worst case near two minutes even
// though its median is 2-5s. Timing it out at 25s is how POST /api/council
// reported "This operation was aborted" on one run and passed in 2.3s on the
// next: the sweep was measuring free-tier variance, not the feature.
//
// Derived from the declared `openrouter` dependency rather than listed per
// feature, so a new AI route inherits the right budget without anyone
// remembering to set it.
const AI_REQUEST_TIMEOUT_MS = 120_000;

/** Request budget for one feature: explicit override, else model-aware default. */
function timeoutFor(feature) {
  if (feature.timeoutMs) return feature.timeoutMs;
  if (feature.dependencies?.includes("openrouter")) return AI_REQUEST_TIMEOUT_MS;
  return REQUEST_TIMEOUT_MS;
}

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
async function withTimeout(fn, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function checkDependencies(sessionAuth) {
  const deps = {};

  deps.neon = process.env.DATABASE_URL
    ? { ok: true }
    : { ok: false, reason: "DATABASE_URL not set" };

  deps.openrouter = process.env.OPENROUTER_API_KEY
    ? { ok: true }
    : { ok: false, reason: "OPENROUTER_API_KEY not set" };

  // The second analyze backend (holdemfoldem-api) is a separate dependency from
  // gcp3-backend — see the FEATURE_META note on POST /api/analyze. Unset is its
  // normal state locally and in production, which makes /api/analyze `blocked`,
  // not failing.
  deps.analyzeBackend = process.env.MCP_ANALYZE_URL?.trim()
    ? { ok: true }
    : {
        ok: false,
        reason:
          "MCP_ANALYZE_URL not set — the second analyze backend (holdemfoldem-api) is " +
          "unconfigured here and in prod by design; see docs/wiki-portal/decision-second-analyze-backend.md",
      };

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceMonthly = process.env.STRIPE_PRICE_MONTHLY ?? "";
  const priceAnnual = process.env.STRIPE_PRICE_ANNUAL ?? "";
  if (!stripeKey) {
    deps.stripe = { ok: false, reason: "STRIPE_SECRET_KEY not set" };
  } else if (stripeKey.startsWith("sk_live_")) {
    // Refuse to transact against a live payment account, full stop. The sweep
    // POSTs /api/stripe/checkout and /api/stripe/portal, which create real
    // Stripe objects — a live Checkout Session and, on the portal's lazy
    // provisioning path, a real live Customer — on every single run. That is
    // not something a nightly feature sweep gets to do, and unlike every other
    // dependency here it cannot be undone by re-running.
    //
    // This is fail-closed on purpose: `blocked` on a live key is the correct
    // outcome, and the fix is a test-mode key, not a louder warning.
    deps.stripe = {
      ok: false,
      reason:
        "STRIPE_SECRET_KEY is a LIVE key (sk_live_) — the sweep creates real Stripe objects " +
        "(Checkout Sessions, and a Customer via the portal's lazy provisioning), so billing " +
        "features are blocked until a test-mode key (sk_test_) is configured",
    };
  } else if (!priceMonthly || priceMonthly.includes("placeholder") || !priceAnnual || priceAnnual.includes("placeholder")) {
    deps.stripe = { ok: false, reason: "STRIPE_PRICE_MONTHLY/ANNUAL unset or placeholder" };
  } else {
    deps.stripe = { ok: true };
  }

  const mcpUrl = process.env.MCP_BACKEND_URL?.trim() || "https://gcp3-backend-cif7ppahzq-uc.a.run.app";
  try {
    const res = await withTimeout((signal) => fetch(`${mcpUrl}/health`, { signal }));
    deps.mcp = res.ok ? { ok: true } : { ok: false, reason: `MCP backend returned ${res.status}` };
  } catch (err) {
    deps.mcp = { ok: false, reason: `MCP backend unreachable: ${err instanceof Error ? err.message : "unknown"}` };
  }

  // Session is a "dependency" in the same sense: without it every auth
  // feature is blocked, not individually failing for the same root cause.
  deps.session = sessionAuth.ok
    ? { ok: true, mode: sessionAuth.mode }
    : { ok: false, reason: sessionAuth.reason };

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
async function runFeature(feature, deps, sessionAuth) {
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

  const url = `${BASE_URL}${feature.path}${feature.query ?? ""}`;
  const headers = { "content-type": "application/json" };
  if (feature.auth) {
    try {
      Object.assign(headers, await sessionAuth.headersFor());
    } catch (err) {
      return {
        ...base,
        status: "blocked",
        reason: redact(`session token unavailable: ${err instanceof Error ? err.message : "unknown"}`),
      };
    }
  }

  const start = Date.now();
  try {
    const res = await withTimeout(
      (signal) =>
        fetch(url, {
          method: feature.method,
          headers,
          body: feature.body !== undefined ? JSON.stringify(feature.body) : undefined,
          signal,
        }),
      timeoutFor(feature),
    );
    const latencyMs = Date.now() - start;
    // `expectStatus` exists for routes where 2xx is not the right answer — a
    // documented empty-state 404, a lookup miss. The inventory entry must say
    // why; see the comments on the entries that use it.
    const accepted = feature.expectStatus ?? null;

    // A 429 is the feature's own rate limiter refusing this call — which means
    // the feature was *not exercised*, not that it is broken. That is precisely
    // the blocked/fail distinction this sweep exists to make, so it reports
    // `blocked` with the retry window rather than a red row.
    //
    // It is a real condition, not a hypothetical: GET /api/privacy/export is
    // deliberately limited to roughly one call per user per hour (a GDPR export
    // dumps every row a user owns), so iterating the sweep exhausts it and every
    // subsequent run showed a passing feature as failing. A feature may still
    // opt into 429 via expectStatus if 429 is genuinely its contract.
    if (res.status === 429 && !(accepted && accepted.includes(429))) {
      const body429 = await res.text().catch(() => "");
      let retryHint = "";
      try {
        const parsed = JSON.parse(body429);
        if (parsed?.retry_after_seconds) {
          retryHint = ` — retry after ${parsed.retry_after_seconds}s`;
        }
      } catch { /* body need not be JSON */ }
      return {
        ...base,
        status: "blocked",
        latencyMs,
        reason: redact(
          `rate-limited by the route's own guard (HTTP 429)${retryHint}. Not exercised this run; ` +
            `this is the limiter working, not a defect.`,
        ),
      };
    }

    if (res.ok || (accepted && accepted.includes(res.status))) {
      const reason =
        !res.ok && accepted
          ? `HTTP ${res.status} — expected for this feature (see inventory note)`
          : null;
      return { ...base, status: "pass", latencyMs, reason };
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
  const sessionAuth = await resolveSessionAuth();
  const deps = await checkDependencies(sessionAuth);
  if (deps.session.ok) console.log(`session: ${deps.session.mode}`);
  else console.log(`session: unavailable — ${deps.session.reason}`);

  let features = inventory.features;
  if (featureFilter) features = features.filter((f) => f.slug === featureFilter);

  const results = [];
  for (const feature of features) {
    const result = await runFeature(feature, deps, sessionAuth);
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
