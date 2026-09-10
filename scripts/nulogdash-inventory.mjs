/**
 * Generate docs/nulogdash-inventory.json from two sources:
 *   1. A hand-authored FEATURE_META table below (what to call, with what
 *      body, which dependencies it needs, why it's excluded if it is).
 *   2. A filesystem scan of app/api/** /route.ts for exported HTTP verbs.
 *
 * The two are cross-checked. Anything the filesystem scan finds that isn't
 * in FEATURE_META becomes a "discovered" entry with status `not_run` and
 * reason "not in inventory" — so a new route can never silently fall
 * outside the /nulogdash sweep (see docs/nulogdash-dashboard-plan.md).
 *
 *   node scripts/nulogdash-inventory.mjs
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "app", "api");
const OUT_FILE = join(ROOT, "docs", "nulogdash-inventory.json");

// ---------------------------------------------------------------------------
// Hand-authored feature metadata. Keyed by "<METHOD> <path>" where dynamic
// segments use a real sample value (matches what the runner will call).
// ---------------------------------------------------------------------------
const FEATURE_META = {
  "GET /api/health": {
    slug: "health",
    label: "Health check",
    auth: false,
    dependencies: [],
  },
  "GET /api/holdfold": {
    slug: "holdfold",
    label: "Hold / Fold verdicts",
    auth: true,
    dependencies: ["mcp"],
  },
  "POST /api/nuai": {
    slug: "nuai",
    label: "Nu AI chat",
    auth: true,
    dependencies: ["openrouter"],
    body: { question: "What is RSI?" },
  },
  "GET /api/signals/digest": {
    slug: "signals-digest",
    label: "Signal digest",
    auth: true,
    dependencies: ["mcp"],
  },
  "GET /api/signals/live": {
    slug: "signals-live",
    label: "Live signals feed",
    auth: true,
    dependencies: ["mcp"],
  },
  "GET /api/signals/card": {
    slug: "signals-card",
    label: "Signal share card",
    auth: true,
    dependencies: ["mcp"],
  },
  "POST /api/signals/AAPL/chat": {
    slug: "signal-chat",
    label: "Per-ticker signal chat",
    auth: true,
    dependencies: ["openrouter"],
    body: { question: "Why is this a hold?" },
  },
  "GET /api/backtest/AAPL": {
    slug: "backtest",
    label: "Backtest",
    auth: true,
    dependencies: ["mcp"],
  },
  "GET /api/portfolio/health": {
    slug: "portfolio-health",
    label: "Portfolio health score",
    auth: true,
    dependencies: ["neon", "mcp"],
  },
  "POST /api/portfolio/health-ai": {
    slug: "portfolio-health-ai",
    label: "Portfolio health — AI narrative",
    auth: true,
    dependencies: ["neon", "openrouter"],
    body: {},
  },
  "GET /api/portfolio/suggestions": {
    slug: "portfolio-suggestions",
    label: "Portfolio suggestions",
    auth: true,
    dependencies: ["neon", "mcp"],
  },
  "GET /api/portfolio/watchlist": {
    slug: "watchlist-list",
    label: "Watchlist — list",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/portfolio/watchlist": {
    slug: "watchlist-add",
    label: "Watchlist — add",
    auth: true,
    dependencies: ["neon"],
    body: { ticker: "NULOGDASH-TEST" },
    writesData: true,
  },
  "DELETE /api/portfolio/watchlist/NULOGDASH-TEST": {
    slug: "watchlist-remove",
    label: "Watchlist — remove",
    auth: true,
    dependencies: ["neon"],
    writesData: true,
  },
  "GET /api/referral": {
    slug: "referral-get",
    label: "Referral — status",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/referral": {
    slug: "referral-create",
    label: "Referral — create link",
    auth: true,
    dependencies: ["neon"],
    body: {},
    writesData: true,
  },
  "GET /api/retention/streak": {
    slug: "retention-streak-get",
    label: "Retention — streak status",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/retention/streak": {
    slug: "retention-streak-post",
    label: "Retention — record streak visit",
    auth: true,
    dependencies: ["neon"],
    body: {},
    writesData: true,
  },
  "POST /api/retention/trial-nudge": {
    slug: "retention-trial-nudge",
    label: "Retention — trial nudge",
    auth: true,
    dependencies: ["neon"],
    body: {},
  },
  "POST /api/push/register": {
    slug: "push-register",
    label: "Push notification registration",
    auth: true,
    dependencies: ["neon"],
    body: { endpoint: "https://nulogdash.test/fake-endpoint", keys: { p256dh: "test", auth: "test" } },
    writesData: true,
  },
  "POST /api/stripe/checkout": {
    slug: "stripe-checkout",
    label: "Billing — start checkout",
    auth: true,
    dependencies: ["stripe", "neon"],
    body: { plan: "monthly" },
    note: "creates a real Stripe test-mode Checkout Session; does not complete a purchase",
  },
  "POST /api/stripe/portal": {
    slug: "stripe-portal",
    label: "Billing — customer portal",
    auth: true,
    dependencies: ["stripe", "neon"],
    body: {},
    note: "requires the test user to already have a Stripe customer/subscription",
  },
  "GET /api/stripe/subscription": {
    slug: "stripe-subscription",
    label: "Billing — subscription status",
    auth: true,
    dependencies: ["stripe", "neon"],
  },
  "GET /api/council/sample": {
    slug: "council-sample",
    label: "Council — sample deliberation",
    auth: false,
    dependencies: ["openrouter"],
  },
  "POST /api/council": {
    slug: "council",
    label: "Council — deliberate",
    auth: true,
    dependencies: ["openrouter"],
    body: { ticker: "AAPL" },
  },
  "POST /api/council/deliberate": {
    slug: "council-deliberate",
    label: "Council — deliberate (v2)",
    auth: true,
    dependencies: ["openrouter"],
    body: { ticker: "AAPL" },
  },
  "POST /api/council/public": {
    slug: "council-public",
    label: "Council — public deliberation",
    auth: false,
    dependencies: ["openrouter"],
    body: { ticker: "AAPL" },
  },
  "POST /api/brief": {
    slug: "brief",
    label: "Morning brief",
    auth: true,
    dependencies: ["mcp", "openrouter"],
    body: {},
  },
  "POST /api/feedback": {
    slug: "feedback",
    label: "Feedback submission",
    auth: true,
    dependencies: ["neon"],
    body: { message: "nulogdash automated sweep — ignore" },
    writesData: true,
  },
  // launch/remind is NOT a Clerk-session feature: it requires a
  // LAUNCH_REMIND_SECRET bearer token and has no user-facing form. Firing it
  // unauthenticated just yields a 401. Excluded like the other bearer-secret
  // server-to-server routes below.
  "POST /api/launch/remind": {
    slug: "launch-remind",
    label: "Launch waitlist reminder",
    excluded:
      "server-to-server (Bearer LAUNCH_REMIND_SECRET); one-shot Product Hunt launch reminder, " +
      "not a user-facing feature — triggered manually / by its own job",
  },

  // --- Consent, disclaimer & attribution (added 2026-09-09) ---
  // analyze / disclaimer / legal-consent sit behind proxy.ts's
  // isProtectedApiRoute matcher, so an unauthenticated probe gets Clerk's
  // route-obscuring 404 (not a 401). Marking them auth:true makes the sweep
  // report them as "blocked — needs NULOGDASH_SESSION_COOKIE" instead of
  // "fail — HTTP 404", which is what they actually are.
  "POST /api/analyze": {
    slug: "analyze",
    label: "Per-ticker live analysis",
    auth: true,
    dependencies: ["mcp"],
    body: { symbol: "AAPL" },
  },
  "GET /api/disclaimer": {
    slug: "disclaimer-get",
    label: "Disclaimer — acknowledgement status",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/disclaimer": {
    slug: "disclaimer-ack",
    label: "Disclaimer — record acknowledgement",
    auth: true,
    dependencies: ["neon"],
    body: { surface: "nulogdash-sweep" },
    writesData: true,
  },
  "GET /api/legal-consent": {
    slug: "legal-consent-get",
    label: "Legal consent — status",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/legal-consent": {
    slug: "legal-consent-post",
    label: "Legal consent — record sign-up consent",
    auth: true,
    dependencies: ["neon"],
    body: { surface: "web" },
    writesData: true,
  },
  // consent / attribution are cookieless-friendly: the handler runs with or
  // without a Clerk session (an anonymous visitor still sets a consent cookie
  // / records a marketing touch), so they are reachable on an unauthenticated
  // sweep and should PASS, not block.
  "GET /api/consent": {
    slug: "consent-get",
    label: "Cookie consent — current choices",
    auth: false,
    dependencies: ["neon"],
  },
  "POST /api/consent": {
    slug: "consent-post",
    label: "Cookie consent — save choices",
    auth: false,
    dependencies: ["neon"],
    body: { choices: { preferences: true, analytics: false, marketing: false }, source: "preferences" },
    writesData: true,
  },
  "POST /api/attribution": {
    slug: "attribution",
    label: "Marketing attribution touch",
    auth: false,
    dependencies: ["neon"],
    body: { first_touch: { source: "nulogdash", medium: "sweep" } },
    writesData: true,
  },

  // --- Privacy / DSAR rights (added 2026-09-09) ---
  // export / profile are in the proxy matcher (Clerk 404 unauth); rectify is
  // handler-guarded only (returns its own 401) and rate-limited.
  "GET /api/privacy/export": {
    slug: "privacy-export",
    label: "Privacy — data export (DSAR Art. 15/20)",
    auth: true,
    dependencies: ["neon"],
  },
  "GET /api/privacy/profile": {
    slug: "privacy-profile",
    label: "Privacy — automated-processing profile (DSAR Art. 15/22)",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/privacy/rectify": {
    slug: "privacy-rectify",
    label: "Privacy — rectification request (DSAR Art. 16)",
    auth: true,
    dependencies: ["neon"],
    body: {
      field: "display_name",
      current_value: "nulogdash sweep",
      requested_value: "nulogdash sweep",
      reason: "automated sweep — no-op rectification request",
    },
    writesData: true,
  },

  // --- Signals ranking (added 2026-09-09) ---
  "GET /api/signals/top": {
    slug: "signals-top",
    label: "Signals — top ranking",
    auth: true,
    dependencies: ["neon"],
  },

  // --- Deliberately excluded — see docs/nulogdash-dashboard-plan.md ---
  "POST /api/privacy/delete": {
    slug: "privacy-delete",
    label: "Privacy — erase account (DSAR Art. 17)",
    excluded:
      "irreversibly deletes the test user's Clerk account (clerkClient.users.deleteUser) " +
      "and every row they own across USER_TABLES; never safe to fire on a routine sweep",
  },
  "POST /api/signals/drain": {
    slug: "signals-drain",
    label: "Signal queue drain",
    excluded: "drains a production queue; not safe to fire on a routine sweep",
  },
  "GET /api/signals/drain": {
    slug: "signals-drain-status",
    label: "Signal queue drain — status",
    auth: true,
    dependencies: ["neon"],
  },
  "POST /api/signals/refresh": {
    slug: "signals-refresh",
    label: "Signal refresh trigger",
    excluded: "triggers a real GCP backend refresh job; expensive to run routinely",
  },
  "GET /api/signals/refresh": {
    slug: "signals-refresh-status",
    label: "Signal refresh — status",
    auth: true,
    dependencies: ["mcp"],
  },
  "POST /api/retention/digest-email": {
    slug: "retention-digest-email",
    label: "Retention — digest email send",
    excluded: "sends a real email to real users; not safe to fire on a routine sweep",
  },
  "POST /api/webhooks/stripe": {
    slug: "webhook-stripe",
    label: "Stripe webhook receiver",
    excluded: "requires a Stripe-signed payload from `stripe listen`; not a plain fetch target",
  },
  "POST /api/webhooks/clerk": {
    slug: "webhook-clerk",
    label: "Clerk webhook receiver",
    excluded: "requires a Svix-signed payload from Clerk; not a plain fetch target",
  },
  "POST /api/signals/live": {
    slug: "signals-live-ingest",
    label: "Live price ingest (internal)",
    excluded: "internal WS-worker ingest endpoint gated by PORTAL_PUSH_SECRET, not a user-facing feature",
  },

  // Server-to-server pipeline triggers. All are Bearer-authed (CRON_SECRET or
  // PORTAL_PUSH_SECRET), not Clerk-session features, and each does real writes
  // against Neon / the model quota. Their coverage is the scheduled workflows
  // in .github/workflows/ (+ deploy/*/modal_app.py), not this sweep — firing
  // them here would double-spend quota and mutate benchmark tables.
  "POST /api/pipeline/precompute-ai": {
    slug: "pipeline-precompute-ai",
    label: "Pipeline — nightly AI precompute",
    excluded: "server-to-server (Bearer PORTAL_PUSH_SECRET); spends model quota + writes precomputed_ai — covered by precompute-ai.yml",
  },
  "POST /api/pipeline/hydrate-universe": {
    slug: "pipeline-hydrate-universe",
    label: "Pipeline — universe hydration",
    excluded: "server-to-server (Bearer PORTAL_PUSH_SECRET); writes ticker_cards — covered by hydrate-universe.yml",
  },
  "GET /api/pipeline/hydrate-universe": {
    slug: "pipeline-hydrate-universe-status",
    label: "Pipeline — universe hydration (status)",
    excluded: "server-to-server pipeline route; not a user-facing feature",
  },
  "PUT /api/pipeline/hydrate-universe": {
    slug: "pipeline-hydrate-universe-put",
    label: "Pipeline — universe hydration (seed)",
    excluded: "server-to-server (Bearer PORTAL_PUSH_SECRET); bulk-writes ticker_universe — covered by hydrate-universe.yml",
  },
  "POST /api/pipeline/followed-tickers": {
    slug: "pipeline-followed-tickers",
    label: "Pipeline — followed-tickers daily observer",
    excluded: "server-to-server (Bearer CRON_SECRET); appends benchmark observations — covered by track-followed-tickers.yml",
  },
  "POST /api/pipeline/followed-tickers-judge": {
    slug: "pipeline-followed-tickers-judge",
    label: "Pipeline — followed-tickers LLM judge",
    excluded: "server-to-server (Bearer CRON_SECRET); spends model quota + writes judge scores — covered by judge-followed-tickers.yml",
  },
  "POST /api/pipeline/followed-tickers-select": {
    slug: "pipeline-followed-tickers-select",
    label: "Pipeline — followed-tickers monthly cohort",
    excluded: "server-to-server (Bearer CRON_SECRET); freezes the monthly benchmark cohort — covered by select-followed-tickers.yml",
  },
  // Requires a Clerk session OR the PORTAL_PUSH_SECRET bearer — an
  // unauthenticated GET returns 401, so this is auth:true for sweep purposes
  // (the session path is the user-facing one). Was mislabelled auth:false,
  // which surfaced as a false "fail — HTTP 401".
  "GET /api/followed-tickers": {
    slug: "followed-tickers-read",
    label: "Followed-tickers — scoreboard read",
    auth: true,
    dependencies: ["neon"],
  },
};

// ---------------------------------------------------------------------------
// Filesystem scan
// ---------------------------------------------------------------------------
function findRouteFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function routePathFromFile(file) {
  const rel = relative(API_DIR, file).replace(/\/route\.ts$/, "");
  return "/api/" + rel.split("/").map((seg) => {
    // Strip Next.js dynamic-segment brackets so it lines up with the sample
    // paths used as FEATURE_META keys, e.g. "[symbol]" -> "AAPL".
    if (/^\[.+\]$/.test(seg)) return "__DYNAMIC__";
    return seg;
  }).join("/");
}

function scanRoutes() {
  const files = findRouteFiles(API_DIR);
  const discovered = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const methods = [...src.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)/g)].map((m) => m[1]);
    const templatePath = routePathFromFile(file);
    for (const method of methods) {
      discovered.push({ method, templatePath, file: relative(ROOT, file) });
    }
  }
  return discovered;
}

// ---------------------------------------------------------------------------
// Cross-check + build inventory
// ---------------------------------------------------------------------------
function buildInventory() {
  const discovered = scanRoutes();
  const metaKeys = new Set(Object.keys(FEATURE_META));
  const matchedMetaKeys = new Set();
  const features = [];
  const driftWarnings = [];

  for (const { method, templatePath, file } of discovered) {
    // Find a FEATURE_META entry whose path matches this route's dynamic
    // template (exact literal match, or same shape with __DYNAMIC__ swapped
    // for the sample value FEATURE_META used).
    const matchKey = [...metaKeys].find((key) => {
      const [m, p] = key.split(" ");
      if (m !== method) return false;
      const templateSegs = templatePath.split("/");
      const keySegs = p.split("/");
      if (templateSegs.length !== keySegs.length) return false;
      return templateSegs.every((seg, i) => seg === "__DYNAMIC__" || seg === keySegs[i]);
    });

    if (!matchKey) {
      driftWarnings.push(`${method} ${templatePath} (${file}) has no FEATURE_META entry`);
      features.push({
        slug: `undocumented-${method.toLowerCase()}-${templatePath.replace(/\W+/g, "-")}`,
        label: `${method} ${templatePath} (undocumented)`,
        method,
        path: templatePath,
        auth: null,
        dependencies: [],
        tier: [],
        status: "not_run",
        reason: "not in inventory — add a FEATURE_META entry in scripts/nulogdash-inventory.mjs",
      });
      continue;
    }

    matchedMetaKeys.add(matchKey);
    const [method2, path] = matchKey.split(" ");
    const meta = FEATURE_META[matchKey];
    features.push({
      slug: meta.slug,
      label: meta.label,
      method: method2,
      path,
      auth: meta.auth ?? null,
      dependencies: meta.dependencies ?? [],
      tier: meta.excluded ? [] : ["api"],
      body: meta.body,
      writesData: !!meta.writesData,
      note: meta.note ?? null,
      excluded: meta.excluded ?? null,
    });
  }

  // FEATURE_META entries that never matched a discovered route are stale —
  // the route was removed/renamed and the inventory wasn't updated.
  for (const key of metaKeys) {
    if (!matchedMetaKeys.has(key)) {
      driftWarnings.push(`FEATURE_META entry "${key}" (${FEATURE_META[key].slug}) has no matching route on disk`);
    }
  }

  const excluded = features
    .filter((f) => f.excluded)
    .map((f) => ({ feature: f.slug, path: `${f.method} ${f.path}`, reason: f.excluded }));

  return {
    generatedAt: new Date().toISOString(),
    features: features.filter((f) => !f.excluded),
    excluded,
    driftWarnings,
  };
}

const inventory = buildInventory();
writeFileSync(OUT_FILE, JSON.stringify(inventory, null, 2) + "\n");

console.log(`nulogdash inventory: ${inventory.features.length} features, ${inventory.excluded.length} excluded, ${inventory.driftWarnings.length} drift warning(s)`);
for (const w of inventory.driftWarnings) console.log(`  ! ${w}`);
console.log(`written to ${relative(ROOT, OUT_FILE)}`);
