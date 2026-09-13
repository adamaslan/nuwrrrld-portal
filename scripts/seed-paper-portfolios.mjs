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
 *     unless --force-reseed is passed, which archives paper_accounts/
 *     paper_watchlists then deletes them — and refuses outright if any of
 *     those accounts have run history (paper_runs/positions/orders/nav),
 *     since paper_orders' append-only guarantee (§8.6) forbids destroying it
 *   • writes a manifest per run under docs/watchlist-seeds/paper/, and
 *     --undo=<manifest> reverses exactly that run
 *
 * Usage:
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs --dry-run
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs --force-reseed
 *   node --env-file=.env.local scripts/seed-paper-portfolios.mjs --undo=docs/watchlist-seeds/paper/<file>.json
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";

/** Tables that only ever gain rows once an account has actually run
 *  (docs/council-paper-portfolios.md §8.6: paper_orders is append-only and
 *  never deleted). A pristine, never-run seed has none of these; the moment
 *  it does, that history is real and --force-reseed / --undo must refuse to
 *  touch the account rather than let the paper_accounts cascade take it out
 *  silently. CodeRabbit review, PR #127. */
const HISTORY_TABLES = ["paper_runs", "paper_positions", "paper_orders", "paper_nav"];

/** Which of `ids` have any row in any HISTORY_TABLES table — i.e. which
 *  accounts are no longer safe to delete-and-reseed or undo. */
async function accountsWithHistory(sql, ids) {
  const found = new Set();
  for (const table of HISTORY_TABLES) {
    const rows = await sql.query(
      `SELECT DISTINCT account FROM ${table} WHERE account = ANY($1::text[])`,
      [ids],
    );
    for (const r of rows) found.add(r.account);
  }
  return [...found];
}

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
  //
  // CodeRabbit (PR #127) flagged this as fail-open when PRODUCTION_DB_HOST is
  // unset and suggested refusing to run at all in that case. Skipped: this is
  // lib/pipeline-db-guard.ts's own documented, intentional design — "opt-in:
  // with PRODUCTION_DB_HOST unset it allows everything... so it can land
  // before the value is known" — and scripts/local-trigger.mjs's existing
  // inline mirror (which this block is itself modeled on) has the identical
  // behavior. Making this one script uniquely stricter would be inconsistent
  // with every other caller of the same guard, not safer; the real fix, if
  // wanted, is tightening the shared guard itself, not one of its callers.
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
    const ids = accounts.map((a) => a.account);

    // paper_accounts cascades to paper_watchlists/positions/orders/nav/runs —
    // safe ONLY when none of those accounts have actually run since this
    // seed. An account that has is real trading history, not seed leftovers,
    // and undo must refuse rather than let the cascade take it out silently.
    const withHistory = await accountsWithHistory(sql, ids);
    if (withHistory.length > 0) {
      die(
        `${withHistory.length} account(s) named in this manifest have run history ` +
          `(${withHistory.join(", ")}) — undoing this seed would cascade-delete real ` +
          "paper_runs/positions/orders/nav rows, which paper_orders' append-only " +
          "guarantee (design doc §8.6) forbids. This manifest can no longer be undone.",
      );
    }

    if (DRY_RUN) {
      console.log("  --dry-run: nothing written.");
      return;
    }
    const wlRows = await sql`
      DELETE FROM paper_watchlists
      WHERE account = ANY(${ids}::text[]) AND watchlist_version = ${watchlistVersion}
      RETURNING account
    `;
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
  // --force-reseed's archive-then-delete only ever touches paper_accounts and
  // paper_watchlists (see the archive step below); the paper_accounts cascade
  // would ALSO take out paper_runs/positions/orders/nav, none of which get
  // archived. That's fine for a pristine seed with no run history — it is not
  // fine for an account that has actually traded, so refuse outright rather
  // than silently destroy real orders. CodeRabbit review, PR #127.
  if (existingAccounts.length > 0 && FORCE_RESEED) {
    const existingIds = existingAccounts.map((r) => r.account);
    const withHistory = await accountsWithHistory(sql, existingIds);
    if (withHistory.length > 0) {
      die(
        `${withHistory.length} existing account(s) have run history ` +
          `(${withHistory.join(", ")}) — --force-reseed would cascade-delete real ` +
          "paper_runs/positions/orders/nav rows, which paper_orders' append-only " +
          "guarantee (design doc §8.6) forbids. Reseeding a trading account is not " +
          "supported by this script; that needs a deliberate decision, not a flag.",
      );
    }
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

  // ── archive existing rows on --force-reseed (read-only snapshot; the actual
  //    delete happens inside the transaction below, alongside the insert) ──
  let archiveManifestPath = null;
  if (existingAccounts.length > 0) {
    const archiveStamp = new Date().toISOString().replace(/[:.]/g, "-");
    archiveManifestPath = join(MANIFEST_DIR, `archived-before-reseed-${archiveStamp}.json`);
    const existingWatchlists = await sql`SELECT * FROM paper_watchlists`;
    const existingAccountRows = await sql`SELECT * FROM paper_accounts`;
    mkdirSync(dirname(archiveManifestPath), { recursive: true });
    writeFileSync(
      archiveManifestPath,
      `${JSON.stringify({ archivedAt: new Date().toISOString(), accounts: existingAccountRows, watchlists: existingWatchlists }, null, 2)}\n`,
    );
    console.log(`✓ Archived ${existingAccountRows.length} existing accounts to ${archiveManifestPath}`);
  }

  // ── build every mutation query up front, run them in one transaction ─────
  // A prior version issued the delete, each account batch, and each watchlist
  // batch as separate round trips and wrote the manifest only after all of
  // them succeeded — a failure partway through left the DB in a partial state
  // with no manifest to undo it by. sql.transaction() (the same primitive
  // app/api/privacy/delete/route.ts uses) makes the whole write atomic.
  // CodeRabbit review, PR #127.
  const wlRows = [];
  for (const id of ACCOUNT_IDS) {
    const core = new Set(CORE_50);
    for (const ticker of ACCOUNTS[id].tickers) {
      wlRows.push({ account: id, ticker, inSeedBook: core.has(ticker) || id === "spy" });
    }
  }

  const queries = [];
  if (existingAccounts.length > 0) {
    queries.push(sql.query(`DELETE FROM paper_accounts WHERE account = ANY($1::text[])`, [ACCOUNT_IDS]));
  }
  for (let i = 0; i < ACCOUNT_IDS.length; i += BATCH_SIZE) {
    const chunk = ACCOUNT_IDS.slice(i, i + BATCH_SIZE);
    queries.push(
      sql.query(
        `INSERT INTO paper_accounts (account, seat, label, policy_version, starting_cash, cash, seeded_on)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::date[])
           AS t(account, seat, label, policy_version, starting_cash, cash, seeded_on)`,
        [
          chunk,
          chunk.map((id) => ACCOUNTS[id].seat),
          chunk.map((id) => ACCOUNTS[id].label),
          chunk.map(() => PAPER_POLICY_VERSION),
          chunk.map(() => STARTING_CASH),
          chunk.map(() => STARTING_CASH),
          chunk.map(() => seededOn),
        ],
      ),
    );
  }
  for (let i = 0; i < wlRows.length; i += BATCH_SIZE) {
    const chunk = wlRows.slice(i, i + BATCH_SIZE);
    queries.push(
      sql.query(
        `INSERT INTO paper_watchlists (account, ticker, watchlist_version, in_seed_book, active)
         SELECT * FROM unnest($1::text[], $2::text[], $3::int[], $4::boolean[], $5::boolean[])
           AS t(account, ticker, watchlist_version, in_seed_book, active)
         ON CONFLICT (account, ticker, watchlist_version) DO NOTHING
         RETURNING account`,
        [
          chunk.map((r) => r.account),
          chunk.map((r) => r.ticker),
          chunk.map(() => watchlistVersion),
          chunk.map((r) => r.inSeedBook),
          chunk.map(() => true),
        ],
      ),
    );
  }

  // Manifest content is fully known up front (ACCOUNTS is a static constant,
  // not derived from any DB response) — write it to a durable temp path
  // BEFORE the transaction runs, and only rename it into place once the
  // transaction has actually committed. A failed transaction leaves the temp
  // file behind, named in the error, instead of losing the undo record.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = join(MANIFEST_DIR, `seed-${stamp}.json`);
  const tempManifestPath = `${manifestPath}.tmp`;
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    tempManifestPath,
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

  let results;
  try {
    results = await sql.transaction(queries);
  } catch (err) {
    console.error(
      `\n✖ Transaction failed — no changes committed (all-or-nothing). ` +
        `Manifest of what would have been seeded is preserved at ${tempManifestPath} for reference.\n` +
        `  ${err.message}`,
    );
    throw err;
  }

  renameSync(tempManifestPath, manifestPath);
  const watchlistResults = results.slice(existingAccounts.length > 0 ? 1 : 0).slice(Math.ceil(ACCOUNT_IDS.length / BATCH_SIZE));
  const wlInserted = watchlistResults.reduce((n, r) => n + r.length, 0);
  console.log(`✓ Inserted ${ACCOUNT_IDS.length} paper_accounts rows and ${wlInserted} paper_watchlists rows.`);
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
