/**
 * hydrate-dev.mjs — LOCAL-DEV-ONLY financial-data seeder.
 *
 * Fills every financial-data column the dashboards read (signals digest,
 * Hold/Fold, per-ticker signal cache, backtest hit-rates, watchlist,
 * pending-signals queue, council verdicts) with realistic, frontend-VALID
 * data so `npm run dev` renders fully populated pages without a live gcp3
 * backend.
 *
 *   npm run db:hydrate:dev            # guard + seed + verify
 *   npm run db:hydrate:dev -- --verify   # read-only readiness report
 *   npm run db:hydrate:dev -- --reset    # remove dev rows, then seed
 *
 * SAFETY — this script refuses to touch anything that looks like production:
 *   • hard-refuse if NODE_ENV=production or running on Vercel
 *   • hard-refuse if the DATABASE_URL host/db name contains a prod marker
 *   • localhost/127.0.0.1 hosts run freely
 *   • any other (cloud) host requires BOTH `--force` AND
 *     DEV_HYDRATE_CONFIRM=<exact-host> so a dev Neon branch is opt-in, explicit,
 *     and impossible to hit by muscle memory.
 *
 * Zero extra deps: plain .mjs on @neondatabase/serverless (already a dep).
 * All writes are idempotent (upsert / delete-dev-rows-then-insert), so re-running
 * converges to the same state instead of piling up duplicates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { neon } from "@neondatabase/serverless";

// ── env loading (mirrors scripts/db-migrate.mjs) ─────────────────────────────
if (!process.env.DATABASE_URL) {
  try {
    const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of envLocal.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[m[1]] = val;
      }
    }
  } catch {
    /* .env.local absent — process.env is the only source */
  }
}

const args = new Set(process.argv.slice(2));
const VERIFY_ONLY = args.has("--verify");
const RESET = args.has("--reset");
const FORCE = args.has("--force");

function die(msg) {
  console.error(`\n✖ hydrate-dev refused: ${msg}\n`);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) die("DATABASE_URL is not set (put it in .env.local for local dev).");

// ── PROD-REFUSAL GUARD ───────────────────────────────────────────────────────
const PROD_MARKERS = ["prod", "production", "-main", "/main"];
function assertDevSafe(connectionUrl) {
  if (process.env.NODE_ENV === "production") die("NODE_ENV=production.");
  if (process.env.VERCEL || process.env.CI) die("running on Vercel/CI, not a local dev box.");

  let parsed;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    die("DATABASE_URL is not a parseable URL.");
  }
  const host = parsed.host.toLowerCase();
  const dbName = parsed.pathname.toLowerCase();
  const hay = `${host}${dbName}`;

  if (PROD_MARKERS.some((m) => hay.includes(m))) {
    die(`host/db name contains a production marker ("${host}${dbName}"). Never run this there.`);
  }

  const isLocal =
    /^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:\d+)?$/.test(host) ||
    host.includes("localhost");

  if (!isLocal) {
    if (!FORCE) {
      die(
        `non-local host "${host}". If this really is a throwaway dev Neon branch, re-run with ` +
          `--force and DEV_HYDRATE_CONFIRM=${host}`,
      );
    }
    if (process.env.DEV_HYDRATE_CONFIRM !== host) {
      die(`--force given but DEV_HYDRATE_CONFIRM must equal the exact host "${host}".`);
    }
    console.warn(`⚠ Non-local host "${host}" explicitly confirmed. Proceeding.`);
  } else {
    console.log(`✓ Local host "${host}" — safe to hydrate.`);
  }
}

assertDevSafe(url);
const sql = neon(url);

// ── fixtures ─────────────────────────────────────────────────────────────────
export const DEV_USER_ID = "user_devlocal000000000000000";
const DEV_SESSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"; // fixed, all-hex sentinel → idempotent
const DEV_DIGEST_LABEL = "DEV (local hydrate)";
const DEV_SOURCE = "dev-hydrate"; // sentinel written into cache payloads for cleanup
const nowIso = new Date().toISOString();

const CONF_WORD = { HIGH: "high", MEDIUM: "medium", LOW: "low" };
const CONF_NUM = { HIGH: 85, MEDIUM: 60, LOW: 35 };
const VERDICT = { BUY: "HOLD EM", SELL: "FOLD EM", HOLD: "NEUTRAL" };
const BIAS = { BUY: "bullish", SELL: "bearish", HOLD: "neutral" };

/** Base per-ticker facts; every payload is derived from these so the surfaces agree. */
const TICKERS = [
  { ticker: "AAPL", industry: "Consumer Electronics",     price: 229.35, rsi: 58.2, macd: 1.24, adx: 27.5, action: "BUY",  conf: "HIGH",   direction: "bullish", high52w: 260.10, low52w: 164.08, score: 0.62 },
  { ticker: "NVDA", industry: "Semiconductors",           price: 128.44, rsi: 63.9, macd: 2.81, adx: 34.2, action: "BUY",  conf: "HIGH",   direction: "bullish", high52w: 153.13, low52w:  86.62, score: 0.78 },
  { ticker: "MSFT", industry: "Software—Infrastructure",  price: 449.78, rsi: 51.4, macd: 0.42, adx: 19.8, action: "HOLD", conf: "MEDIUM", direction: "neutral", high52w: 468.35, low52w: 362.90, score: 0.08 },
  { ticker: "TSLA", industry: "Auto Manufacturers",       price: 248.98, rsi: 41.7, macd: -1.63, adx: 22.1, action: "SELL", conf: "MEDIUM", direction: "bearish", high52w: 299.29, low52w: 138.80, score: -0.44 },
  { ticker: "SPY",  industry: "Index ETF",                price: 558.20, rsi: 55.0, macd: 0.88, adx: 18.3, action: "BUY",  conf: "LOW",    direction: "bullish", high52w: 565.16, low52w: 409.21, score: 0.31 },
];

const returnsFor = (t) => ({
  "1d": Number((t.score * 0.9).toFixed(2)),
  "1w": Number((t.score * 2.1).toFixed(2)),
  "1mo": Number((t.score * 4.7).toFixed(2)),
  "3mo": Number((t.score * 9.3).toFixed(2)),
  "1y": Number((t.score * 21.4).toFixed(2)),
});

const topSignalsFor = (t) => [
  { signal: t.macd >= 0 ? "MACD_BULL_CROSS" : "MACD_BEAR_CROSS", strength: t.conf === "HIGH" ? "STRONG" : "MODERATE", detail: `MACD ${t.macd} vs signal line`, category: "MOMENTUM" },
  { signal: t.rsi > 60 ? "RSI_OVERBOUGHT_WATCH" : t.rsi < 45 ? "RSI_WEAK" : "RSI_NEUTRAL", strength: "MODERATE", detail: `RSI ${t.rsi}`, category: "OSCILLATOR" },
  { signal: t.adx > 25 ? "ADX_TRENDING" : "ADX_RANGEBOUND", strength: t.adx > 30 ? "STRONG" : "WEAK", detail: `ADX ${t.adx}`, category: "TREND" },
];

// ── payload builders (shapes verified against lib/digest.ts + holdfold route) ──
function signalPayload(t) {
  return {
    id: `dev-${t.ticker}-1`,
    ticker: t.ticker,
    direction: t.direction,
    timeframe: "short",
    confidence: CONF_WORD[t.conf],
    title: `${t.ticker} ${t.direction} setup`,
    explanation: `${t.ticker} shows a ${t.direction} confluence: MACD ${t.macd}, RSI ${t.rsi}, ADX ${t.adx}. Seeded dev data.`,
    indicators: ["RSI", "MACD", "ADX"],
    generatedAt: nowIso,
    score: t.score,
    reasons: [
      `RSI at ${t.rsi} — ${t.rsi > 60 ? "elevated" : t.rsi < 45 ? "soft" : "balanced"}.`,
      `MACD ${t.macd >= 0 ? "positive" : "negative"} (${t.macd}).`,
      `ADX ${t.adx} — ${t.adx > 25 ? "a real trend" : "range-bound"}.`,
    ],
    signalCounts: {
      bullish: t.direction === "bullish" ? 3 : 1,
      bearish: t.direction === "bearish" ? 3 : 1,
      total: 4,
    },
    isStale: false,
    engineVersion: "dev-hydrate-1",
    dataQualityScore: "fresh",
  };
}

function digestPayload() {
  return {
    schemaVersion: 1,
    periodLabel: DEV_DIGEST_LABEL,
    signals: TICKERS.map(signalPayload),
    generatedAt: nowIso,
    sources: [DEV_SOURCE],
  };
}

function holdFoldVerdict(t) {
  return {
    ticker: t.ticker,
    verdict: VERDICT[t.action],
    confidence: CONF_NUM[t.conf],
    confidenceLabel: t.conf,
    bias: BIAS[t.action],
    industry: t.industry,
    rsi: t.rsi,
    macd: t.macd,
    adx: t.adx,
    price: t.price,
    high52w: t.high52w,
    low52w: t.low52w,
    returns: returnsFor(t),
    signals: topSignalsFor(t),
    aiSummary: `${t.ticker}: ${VERDICT[t.action]} — ${BIAS[t.action]} bias at $${t.price}. Seeded dev data.`,
    aiOutlook: `${t.conf} conviction over the short horizon; invalidate on a close through the opposite 52w extreme.`,
    updatedAt: nowIso,
  };
}

function holdFoldPayload() {
  const verdicts = TICKERS.map(holdFoldVerdict);
  return {
    verdicts,
    total: verdicts.length,
    holdCount: verdicts.filter((v) => v.verdict === "HOLD EM").length,
    foldCount: verdicts.filter((v) => v.verdict === "FOLD EM").length,
    neutralCount: verdicts.filter((v) => v.verdict === "NEUTRAL").length,
    updatedAt: nowIso,
    _source: DEV_SOURCE, // sentinel for idempotent cleanup; ignored by the typed reader
  };
}

function signalCachePayload(t) {
  return {
    symbol: t.ticker,
    action: t.action,
    price: t.price,
    ai_confidence: t.conf,
    ai_summary: `${t.ticker}: ${VERDICT[t.action]} — ${BIAS[t.action]} bias. Seeded dev data.`,
    ai_outlook: `${t.conf} conviction, short horizon.`,
    rsi: t.rsi,
    macd: t.macd,
    adx: t.adx,
    high_52w: t.high52w,
    low_52w: t.low52w,
    industry: t.industry,
    bias: BIAS[t.action],
    generated_at: nowIso,
    top_signals: topSignalsFor(t),
  };
}

// ── seed ─────────────────────────────────────────────────────────────────────
async function resetDevRows() {
  await sql`DELETE FROM signal_digest_cache WHERE period_label = ${DEV_DIGEST_LABEL}`;
  await sql`DELETE FROM user_digest_cache   WHERE user_id = ${DEV_USER_ID}`;
  await sql`DELETE FROM holdfold_cache       WHERE payload->>'_source' = ${DEV_SOURCE}`;
  const tickers = TICKERS.map((t) => t.ticker);
  await sql`DELETE FROM signal_cache        WHERE ticker = ANY(${tickers})`;
  await sql`DELETE FROM backtest_hit_rates  WHERE ticker = ANY(${tickers})`;
  await sql`DELETE FROM watchlist_items     WHERE user_id = ${DEV_USER_ID}`;
  await sql`DELETE FROM pending_signals     WHERE requested_by = ${DEV_USER_ID}`;
  await sql`DELETE FROM council_verdicts    WHERE session_id = ${DEV_SESSION_ID}`;
  await sql`DELETE FROM council_sessions    WHERE id = ${DEV_SESSION_ID}`;
  console.log("↺ Removed prior dev rows.");
}

async function seed() {
  // 1) global signals digest (delete dev label first → idempotent).
  // generated_at is passed explicitly: the live table predates schema.sql's
  // DEFAULT now(), and CREATE TABLE IF NOT EXISTS never back-fills a default —
  // so omitting it hits a NOT NULL violation (matches lib/digest-cache-db.ts).
  await sql`DELETE FROM signal_digest_cache WHERE period_label = ${DEV_DIGEST_LABEL}`;
  await sql`INSERT INTO signal_digest_cache (period_label, payload, generated_at)
            VALUES (${DEV_DIGEST_LABEL}, ${JSON.stringify(digestPayload())}, ${nowIso})`;

  // 2) per-user digest cache (24h window)
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await sql`INSERT INTO user_digest_cache (user_id, payload, expires_at)
            VALUES (${DEV_USER_ID}, ${JSON.stringify(digestPayload())}, ${expires})
            ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`;

  // 3) Hold/Fold cache (delete dev-sentinel rows first → idempotent, non-destructive
  //    to real rows). generated_at passed explicitly for the same reason as above.
  await sql`DELETE FROM holdfold_cache WHERE payload->>'_source' = ${DEV_SOURCE}`;
  await sql`INSERT INTO holdfold_cache (payload, generated_at)
            VALUES (${JSON.stringify(holdFoldPayload())}, ${nowIso})`;

  // 4) per-ticker signal_cache (upsert) + backtest_hit_rates (upsert)
  for (const t of TICKERS) {
    await sql`INSERT INTO signal_cache (ticker, payload, generated_at)
              VALUES (${t.ticker}, ${JSON.stringify(signalCachePayload(t))}, ${nowIso})
              ON CONFLICT (ticker) DO UPDATE SET payload = excluded.payload, generated_at = excluded.generated_at`;

    const strengthBucket = t.direction === "bullish" ? "STRONG BULLISH" : t.direction === "bearish" ? "STRONG BEARISH" : "NEUTRAL";
    const catHits = Math.round(60 + t.score * 20);
    await sql`INSERT INTO backtest_hit_rates (ticker, bucket_kind, bucket_key, hits, total, hit_rate)
              VALUES (${t.ticker}, 'category', 'MA_CROSS', ${catHits}, 100, ${catHits / 100})
              ON CONFLICT (ticker, bucket_kind, bucket_key)
              DO UPDATE SET hits = excluded.hits, total = excluded.total, hit_rate = excluded.hit_rate, computed_at = now()`;
    const strHits = Math.round(55 + Math.abs(t.score) * 25);
    await sql`INSERT INTO backtest_hit_rates (ticker, bucket_kind, bucket_key, hits, total, hit_rate)
              VALUES (${t.ticker}, 'strength', ${strengthBucket}, ${strHits}, 100, ${strHits / 100})
              ON CONFLICT (ticker, bucket_kind, bucket_key)
              DO UPDATE SET hits = excluded.hits, total = excluded.total, hit_rate = excluded.hit_rate, computed_at = now()`;
  }

  // 5) watchlist (primary user data) — every seeded ticker is on the dev watchlist
  for (const t of TICKERS) {
    await sql`INSERT INTO watchlist_items (user_id, ticker)
              VALUES (${DEV_USER_ID}, ${t.ticker})
              ON CONFLICT (user_id, ticker) DO NOTHING`;
  }

  // 6) pending_signals — exercise all three states (respect one-pending-per-ticker).
  // Clear this dev user's rows first so done/error seeds stay idempotent across
  // re-runs (only the 'pending' insert is naturally dedup'd by the unique index).
  await sql`DELETE FROM pending_signals WHERE requested_by = ${DEV_USER_ID}`;
  const pendingSeed = [
    { ticker: "AMD", status: "pending", attempts: 0, error: null },
    { ticker: "GOOG", status: "done", attempts: 0, error: null },
    { ticker: "META", status: "error", attempts: 3, error: "gcp3 timeout (seeded)" },
  ];
  for (const p of pendingSeed) {
    if (p.status === "pending") {
      await sql`INSERT INTO pending_signals (ticker, requested_by, status, attempts)
                SELECT ${p.ticker}, ${DEV_USER_ID}, 'pending', ${p.attempts}
                WHERE NOT EXISTS (SELECT 1 FROM pending_signals WHERE ticker = ${p.ticker} AND status = 'pending')`;
    } else {
      await sql`INSERT INTO pending_signals (ticker, requested_by, status, attempts, error, processed_at)
                VALUES (${p.ticker}, ${DEV_USER_ID}, ${p.status}, ${p.attempts}, ${p.error}, now())`;
    }
  }

  // 7) council session + verdicts (session first for the FK)
  await sql`INSERT INTO council_sessions (id, user_id, topic)
            VALUES (${DEV_SESSION_ID}, ${DEV_USER_ID}, 'NVDA — seeded dev deliberation')
            ON CONFLICT (id) DO NOTHING`;
  await sql`DELETE FROM council_verdicts WHERE session_id = ${DEV_SESSION_ID}`;
  const verdictSeed = [
    { ticker: "NVDA", direction: "bullish", confidence: "high", horizon: "1-5d", invalidation: "close below $118" },
    { ticker: "TSLA", direction: "bearish", confidence: "medium", horizon: "6-12m", invalidation: "reclaim of $265" },
  ];
  for (const v of verdictSeed) {
    await sql`INSERT INTO council_verdicts (session_id, ticker, direction, confidence, horizon, invalidation)
              VALUES (${DEV_SESSION_ID}, ${v.ticker}, ${v.direction}, ${v.confidence}, ${v.horizon}, ${v.invalidation})`;
  }

  console.log("✓ Seeded financial-data tables.");
}

// ── verify ───────────────────────────────────────────────────────────────────
async function count(query) {
  const rows = await query;
  return Number(rows[0]?.n ?? 0);
}

async function verify() {
  const tickers = TICKERS.map((t) => t.ticker);
  const checks = {
    signal_digest_cache: await count(sql`SELECT count(*)::int n FROM signal_digest_cache WHERE period_label = ${DEV_DIGEST_LABEL}`),
    user_digest_cache: await count(sql`SELECT count(*)::int n FROM user_digest_cache WHERE user_id = ${DEV_USER_ID} AND expires_at > now()`),
    holdfold_cache: await count(sql`SELECT count(*)::int n FROM holdfold_cache WHERE payload->>'_source' = ${DEV_SOURCE} AND generated_at > now() - interval '15 minutes'`),
    signal_cache: await count(sql`SELECT count(*)::int n FROM signal_cache WHERE ticker = ANY(${tickers})`),
    backtest_hit_rates: await count(sql`SELECT count(*)::int n FROM backtest_hit_rates WHERE ticker = ANY(${tickers})`),
    watchlist_items: await count(sql`SELECT count(*)::int n FROM watchlist_items WHERE user_id = ${DEV_USER_ID}`),
    pending_signals: await count(sql`SELECT count(*)::int n FROM pending_signals WHERE requested_by = ${DEV_USER_ID}`),
    council_verdicts: await count(sql`SELECT count(*)::int n FROM council_verdicts WHERE session_id = ${DEV_SESSION_ID}`),
  };

  const expect = {
    signal_digest_cache: 1,
    user_digest_cache: 1,
    holdfold_cache: 1,
    signal_cache: TICKERS.length,
    backtest_hit_rates: TICKERS.length * 2,
    watchlist_items: TICKERS.length,
    pending_signals: 3,
    council_verdicts: 2,
  };

  console.log("\n── Per-table hydration ──────────────────────────────");
  let allTablesOk = true;
  for (const [table, got] of Object.entries(checks)) {
    const want = expect[table];
    const ok = got >= want;
    if (!ok) allTablesOk = false;
    console.log(`  ${ok ? "✓" : "✗"} ${table.padEnd(20)} ${got}/${want}`);
  }

  // Per-frontend-feature readiness: a feature is "ready" only if EVERY table it
  // reads is populated — this is the question the dashboards actually ask.
  const features = {
    "Signals dashboard (/dashboard/signals)": ["signal_digest_cache", "user_digest_cache"],
    "Hold/Fold (/dashboard/holdfold)": ["holdfold_cache"],
    "Portfolio (/dashboard/portfolio)": ["watchlist_items", "signal_cache", "backtest_hit_rates"],
    "Watchlist → pending-signals loop": ["watchlist_items", "pending_signals"],
    "Council verdicts": ["council_verdicts"],
    "Per-ticker signal lookup (Nu AI / grounding)": ["signal_cache"],
  };
  console.log("\n── Per-frontend-feature readiness ───────────────────");
  let allFeaturesOk = true;
  for (const [feature, tables] of Object.entries(features)) {
    const missing = tables.filter((t) => checks[t] < expect[t]);
    const ok = missing.length === 0;
    if (!ok) allFeaturesOk = false;
    console.log(`  ${ok ? "✓ READY " : "✗ GAP   "} ${feature}${ok ? "" : `  (missing: ${missing.join(", ")})`}`);
  }

  console.log(
    `\n${allTablesOk && allFeaturesOk ? "✓ ALL GREEN — every dashboard has enough data to render." : "✗ Gaps above — run without --verify to seed."}\n`,
  );
  return allTablesOk && allFeaturesOk;
}

// ── main ─────────────────────────────────────────────────────────────────────
try {
  if (VERIFY_ONLY) {
    const ok = await verify();
    process.exit(ok ? 0 : 1);
  }
  if (RESET) await resetDevRows();
  await seed();
  await verify();
} catch (err) {
  console.error("\n✖ hydrate-dev failed:", err?.message ?? err);
  process.exit(1);
}
