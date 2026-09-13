#!/usr/bin/env node
/**
 * seed-paper-portfolios — Phase 2 of docs/council-paper-portfolios.md.
 *
 * Seeds the 8 fixed paper-trading accounts (t1, t2, risk, macro, quant,
 * chair, equal, spy) and their watchlists (§2.1). Unlike
 * scripts/seed-watchlist-universe.mjs, there is no "which user" question —
 * the account set is fixed — but the same care applies for the same reason:
 * this is primary data whose seed date anchors every NAV series that follows,
 * so it must be explicit, validated, reversible, and never silently re-run.
 *
 *   • the Core 50 + per-account 25 extras below are transcribed VERBATIM from
 *     the design doc's §2.1 — never re-derived from ticker_universe at seed
 *     time, so two seeds a week apart stay comparable (§11 Q2)
 *   • every symbol is checked against ticker_universe before anything is
 *     written; an unresolved symbol fails the whole run, loudly
 *   • refuses to run against a DB that already has paper_accounts rows
 *     unless --force-reseed is passed, which archives the existing rows
 *     first (never deletes)
 *   • writes a manifest per run under docs/watchlist-seeds/paper/, and
 *     --undo=<manifest> reverses exactly that run
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs --dry-run
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs --force-reseed
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs --undo=docs/watchlist-seeds/paper/<file>.json
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";

const MANIFEST_DIR = "docs/watchlist-seeds/paper";
/** Rows per batched INSERT — same Neon HTTP statement-size ceiling as the
 *  watchlist-universe seeder; 501 rows total across all watchlists comfortably
 *  needs batching. */
const BATCH_SIZE = 200;

// ── docs/council-paper-portfolios.md §2.1, transcribed verbatim ────────────

/** The Core 50 — identical seed book for all seven multi-name accounts. */
export const CORE_50 = [
  // Technology (7)
  "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ACN",
  // Financial Services (6)
  "JPM", "BAC", "BRK.B", "V", "MA", "GS",
  // Healthcare (6)
  "JNJ", "LLY", "ABBV", "UNH", "TMO", "ABT",
  // Consumer Cyclical (5)
  "AMZN", "TSLA", "HD", "MCD", "NKE",
  // Industrials (5)
  "CAT", "HON", "UNP", "GE", "RTX",
  // Communication Services (5)
  "GOOGL", "META", "NFLX", "DIS", "TMUS",
  // Consumer Defensive (5)
  "PG", "KO", "COST", "WMT", "PEP",
  // Energy (4)
  "XOM", "CVX", "COP", "SLB",
  // Utilities (3)
  "NEE", "SO", "DUK",
  // Real Estate (2)
  "PLD", "AMT",
  // Basic Materials (2)
  "LIN", "SHW",
];

/** Per-account 25 extras — the other half of each 75-name watchlist. */
export const EXTRAS = {
  t1: [
    "PLTR", "SMCI", "COIN", "HOOD", "MSTR", "AMD", "MU", "ARM", "CRWD", "NET",
    "SHOP", "RBLX", "DASH", "ABNB", "UBER", "RIVN", "LCID", "MARA", "RIOT", "CLSK",
    "AFRM", "UPST", "SOUN", "IONQ", "APP",
  ],
  t2: [
    "ADBE", "ASML", "TSM", "TXN", "ADI", "ISRG", "SYK", "REGN", "VRTX", "DHR",
    "MCO", "SPGI", "ICE", "CME", "BLK", "AXP", "ADP", "ROP", "ITW", "ETN",
    "WM", "RSG", "EQIX", "O", "MDLZ",
  ],
  risk: [
    "MRK", "PFE", "BMY", "GIS", "KMB", "CL", "CLX", "MO", "PM", "KR",
    "SYY", "HRL", "MKC", "CHD", "KDP", "ED", "XEL", "WEC", "AEP", "D",
    "VZ", "T", "BRO", "AJG", "CB",
  ],
  macro: [
    "XLE", "XLI", "XLU", "XLB", "XLC", "VGT", "VIS", "VOX", "KRE", "SMH",
    "QQQ", "IWM", "RSP", "DIA", "TLT", "GLD", "SLV", "URA", "EEM", "VGK",
    "FXI", "KWEB", "FCX", "NUE", "CCJ",
  ],
  quant: [
    "NOW", "PANW", "FTNT", "KLAC", "LRCX", "AMAT", "QCOM", "INTU", "MDT", "CI",
    "ELV", "CVS", "MMM", "DE", "LMT", "NOC", "FDX", "UPS", "TGT", "DG",
    "EOG", "PSX", "MPC", "VST", "CEG",
  ],
  chair: [
    "PLTR", "AMD", "COIN", "ADBE", "TSM", "ISRG", "SPGI", "BLK", "MRK", "CL",
    "VZ", "CEG", "VST", "NOW", "QCOM", "INTU", "DE", "LMT", "UPS", "TGT",
    "EOG", "MPC", "EQIX", "O", "ETN",
  ],
};

/** `spy` is NOT a registered ticker_universe symbol — the control holds IVV.
 *  See §2.1's "spy — control, one name, and it is not SPY". */
export const SPY_HOLDING = "IVV";

export const PAPER_POLICY_VERSION = "v1"; // must track lib/shared/paper-policy.ts's export
export const STARTING_CASH = 10000;

/** account -> { seat, label, tickers } — the full seed plan. `equal`'s
 *  watchlist is the Core 50, frozen, no extras (§2.1). `spy` holds one name. */
export const ACCOUNTS = {
  t1: { seat: "T1", label: "T1 — Short-Term Tactical", tickers: [...CORE_50, ...EXTRAS.t1] },
  t2: { seat: "T2", label: "T2 — Long-Horizon Compounder", tickers: [...CORE_50, ...EXTRAS.t2] },
  risk: { seat: "RISK", label: "RISK — Survive-Being-Wrong", tickers: [...CORE_50, ...EXTRAS.risk] },
  macro: { seat: "MACRO", label: "MACRO — Rotation & Liquidity", tickers: [...CORE_50, ...EXTRAS.macro] },
  quant: { seat: "QUANT", label: "QUANT — Numeric-Only Control", tickers: [...CORE_50, ...EXTRAS.quant] },
  chair: { seat: "CHAIR", label: "CHAIR — Council Consensus", tickers: [...CORE_50, ...EXTRAS.chair] },
  equal: { seat: null, label: "Equal-Weight Control", tickers: [...CORE_50] },
  spy: { seat: null, label: "Buy-and-Hold Control (IVV)", tickers: [SPY_HOLDING] },
};

export const ACCOUNT_IDS = Object.keys(ACCOUNTS);

function die(msg) {
  console.error(`\n✖ seed-paper-portfolios refused: ${msg}\n`);
  process.exit(1);
}

async function main() {
  // ── env loading (mirrors scripts/seed-watchlist-universe.mjs) ─────────────
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

  const argv = process.argv.slice(2);
  const flag = (name) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
  };

  const DRY_RUN = flag("dry-run") === true;
  const FORCE_RESEED = flag("force-reseed") === true;
  const UNDO = flag("undo");

  const url = process.env.DATABASE_URL;
  if (!url) die("DATABASE_URL is not set (put it in .env.local for local dev).");
  const sql = neon(url);

  // Structural guard (lib/pipeline-db-guard.ts) — kept inline because this
  // .mjs cannot import TS. Opt-in: only bites when PRODUCTION_DB_HOST is set.
  // A dry-run never writes, so it is exempt.
  if (!DRY_RUN) {
    const prodHost = (process.env.PRODUCTION_DB_HOST || "").trim().toLowerCase();
    let dbHost = null;
    try {
      dbHost = new URL(url).hostname.toLowerCase();
    } catch {
      /* unparseable — treat as "not production" */
    }
    if (prodHost && dbHost === prodHost) {
      die(
        "DATABASE_URL resolves to the host named by PRODUCTION_DB_HOST. " +
          "Point it at a dev branch, or clear PRODUCTION_DB_HOST if this is genuinely intended.",
      );
    }
  }

  // ── undo ───────────────────────────────────────────────────────────────────
  if (typeof UNDO === "string") {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(UNDO, "utf8"));
    } catch (err) {
      die(`could not read manifest "${UNDO}": ${err.message}`);
    }
    const { accounts, watchlistVersion } = manifest;
    if (!Array.isArray(accounts) || typeof watchlistVersion !== "number") {
      die("manifest is missing `accounts` or `watchlistVersion`.");
    }

    console.log(`↩ Undo: removing ${accounts.length} accounts (watchlist_version=${watchlistVersion})`);
    if (DRY_RUN) {
      console.log("  --dry-run: nothing written.");
      return;
    }
    const ids = accounts.map((a) => a.account);
    const wlRows = await sql`
      DELETE FROM paper_watchlists
      WHERE account = ANY(${ids}::text[]) AND watchlist_version = ${watchlistVersion}
      RETURNING account
    `;
    // ON DELETE CASCADE on paper_accounts takes paper_runs/positions/orders/nav
    // with it — safe here because undo only ever targets a seed that has not
    // yet run (the seeder refuses to reseed an account with existing rows
    // without --force-reseed, and a run always happens after a seed).
    const acctRows = await sql`
      DELETE FROM paper_accounts WHERE account = ANY(${ids}::text[]) RETURNING account
    `;
    console.log(`✓ Removed ${wlRows.length} watchlist rows and ${acctRows.length} accounts.`);
    return;
  }

  // ── refuse to reseed silently ──────────────────────────────────────────────
  const existingAccounts = await sql`SELECT account FROM paper_accounts`;
  if (existingAccounts.length > 0 && !FORCE_RESEED) {
    die(
      `${existingAccounts.length} paper_accounts row(s) already exist ` +
        `(${existingAccounts.map((r) => r.account).join(", ")}). ` +
        "Pass --force-reseed to archive them and reseed, or --undo=<manifest> to reverse a prior seed.",
    );
  }

  // ── validate every symbol against ticker_universe ─────────────────────────
  const allSymbols = [...new Set(Object.values(ACCOUNTS).flatMap((a) => a.tickers))];
  const universeRows = await sql`
    SELECT ticker, active FROM ticker_universe WHERE ticker = ANY(${allSymbols}::text[])
  `;
  const universeByTicker = new Map(universeRows.map((r) => [r.ticker, r.active]));
  const missing = allSymbols.filter((t) => !universeByTicker.has(t));
  const inactive = allSymbols.filter((t) => universeByTicker.get(t) === false);
  if (missing.length > 0) {
    die(
      `${missing.length} symbol(s) do not resolve in ticker_universe: ${missing.join(", ")}. ` +
        "Fix docs/council-paper-portfolios.md §2.1 or hydrate the universe first — never silently drop a symbol.",
    );
  }
  if (inactive.length > 0) {
    die(
      `${inactive.length} symbol(s) resolve but are inactive in ticker_universe: ${inactive.join(", ")}. ` +
        "A watchlist must not seed a delisted/inactive name.",
    );
  }
  console.log(`✓ All ${allSymbols.length} distinct symbols resolve to active ticker_universe rows.`);

  // ── report plan ────────────────────────────────────────────────────────────
  const watchlistVersion = 1;
  const seededOn = new Date().toISOString().slice(0, 10);
  let totalWatchlistRows = 0;
  for (const id of ACCOUNT_IDS) {
    const { seat, label, tickers } = ACCOUNTS[id];
    totalWatchlistRows += tickers.length;
    console.log(`  ${id.padEnd(6)} seat=${(seat ?? "—").padEnd(6)} ${tickers.length} tickers  ${label}`);
  }
  console.log(`\nAccounts: ${ACCOUNT_IDS.length}, watchlist rows: ${totalWatchlistRows}, starting cash: $${STARTING_CASH} each`);

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing written.");
    return;
  }

  // ── archive existing rows on --force-reseed (never delete outright) ──────
  if (existingAccounts.length > 0) {
    const archiveStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveManifestPath = join(MANIFEST_DIR, `archived-before-reseed-${archiveStamp}.json`);
    const existingWatchlists = await sql`SELECT * FROM paper_watchlists`;
    const existingAccountRows = await sql`SELECT * FROM paper_accounts`;
    mkdirSync(dirname(archiveManifestPath), { recursive: true });
    writeFileSync(
      archiveManifestPath,
      `${JSON.stringify({ archivedAt: new Date().toISOString(), accounts: existingAccountRows, watchlists: existingWatchlists }, null, 2)}\n`,
    );
    console.log(`✓ Archived ${existingAccountRows.length} existing accounts to ${archiveManifestPath}`);
    // paper_accounts cascades to watchlists/positions/orders/nav/runs.
    await sql`DELETE FROM paper_accounts WHERE account = ANY(${ACCOUNT_IDS}::text[])`;
  }

  // ── insert accounts ────────────────────────────────────────────────────────
  for (let i = 0; i < ACCOUNT_IDS.length; i += BATCH_SIZE) {
    const chunk = ACCOUNT_IDS.slice(i, i + BATCH_SIZE);
    await sql`
      INSERT INTO paper_accounts (account, seat, label, policy_version, starting_cash, cash, seeded_on)
      SELECT * FROM unnest(
        ${chunk}::text[],
        ${chunk.map((id) => ACCOUNTS[id].seat)}::text[],
        ${chunk.map((id) => ACCOUNTS[id].label)}::text[],
        ${chunk.map(() => PAPER_POLICY_VERSION)}::text[],
        ${chunk.map(() => STARTING_CASH)}::numeric[],
        ${chunk.map(() => STARTING_CASH)}::numeric[],
        ${chunk.map(() => seededOn)}::date[]
      ) AS t(account, seat, label, policy_version, starting_cash, cash, seeded_on)
    `;
  }
  console.log(`✓ Inserted ${ACCOUNT_IDS.length} paper_accounts rows.`);

  // ── insert watchlists ──────────────────────────────────────────────────────
  const wlRows = [];
  for (const id of ACCOUNT_IDS) {
    const core = new Set(CORE_50);
    for (const ticker of ACCOUNTS[id].tickers) {
      wlRows.push({ account: id, ticker, inSeedBook: core.has(ticker) || id === "spy" });
    }
  }
  let wlInserted = 0;
  for (let i = 0; i < wlRows.length; i += BATCH_SIZE) {
    const chunk = wlRows.slice(i, i + BATCH_SIZE);
    const rows = await sql`
      INSERT INTO paper_watchlists (account, ticker, watchlist_version, in_seed_book, active)
      SELECT * FROM unnest(
        ${chunk.map((r) => r.account)}::text[],
        ${chunk.map((r) => r.ticker)}::text[],
        ${chunk.map(() => watchlistVersion)}::int[],
        ${chunk.map((r) => r.inSeedBook)}::boolean[],
        ${chunk.map(() => true)}::boolean[]
      ) AS t(account, ticker, watchlist_version, in_seed_book, active)
      ON CONFLICT (account, ticker, watchlist_version) DO NOTHING
      RETURNING account
    `;
    wlInserted += rows.length;
    process.stdout.write(`  inserted ${wlInserted}/${wlRows.length}\r`);
  }
  console.log(`\n✓ Inserted ${wlInserted} paper_watchlists rows.`);

  // ── manifest (makes the run reversible) ───────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = join(MANIFEST_DIR, `seed-${stamp}.json`);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        seededAt: new Date().toISOString(),
        watchlistVersion,
        policyVersion: PAPER_POLICY_VERSION,
        accounts: ACCOUNT_IDS.map((id) => ({
          account: id,
          seat: ACCOUNTS[id].seat,
          label: ACCOUNTS[id].label,
          tickers: ACCOUNTS[id].tickers,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`✓ Manifest: ${manifestPath}`);
  console.log(`  Undo with: node --env-file=.env.local scripts/seed-paper-portfolios.mjs --undo=${manifestPath}`);
}

// Guarded so the constants above can be imported by a unit test without the
// seeder running as a side effect — same idiom as scripts/seed-signals-universe.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`seed-paper-portfolios failed: ${err.message}\n`);
    process.exit(1);
  });
}
