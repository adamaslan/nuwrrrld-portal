#!/usr/bin/env node --experimental-strip-types
/**
 * paper-sim — run the paper-trading planner locally, against a local SQLite
 * snapshot or read-only Neon, and print what each bot WOULD do.
 *
 * Why this exists (docs/paper-trading-v3.md §7): every question about this
 * feature so far ("why did only RISK trade?", "what will v3 thresholds
 * change?", "do the bots actually differ?") needed either a production run or
 * a hand-rolled scratch script. A production run is four-times-a-day, writes
 * the real book, and takes a deploy. This takes ~1 second and writes nothing.
 *
 * It imports the SAME pure planner the production route uses
 * (lib/shared/paper-engine-core.ts + paper-policy.ts), so a plan printed here
 * is the plan the engine would produce from the same inputs — not a
 * reimplementation that can drift. Everything this script adds is I/O:
 * loading state, optionally refreshing prices, and formatting.
 *
 * READ-ONLY BY CONTRACT. It opens SQLite with `readOnly: true`, only ever
 * SELECTs from Neon, and has no code path that writes to either. Refreshed
 * prices are held in memory for the simulation and never persisted.
 *
 *   # local, no credentials needed once a snapshot exists
 *   npx tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite
 *
 *   # straight off production, read-only
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/paper-sim.ts --neon
 *
 *   # what v3's proposed thresholds would change
 *   npx tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --policy=v3
 *
 *   # live prices instead of the snapshot's (in memory only)
 *   npx tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --prices=alpaca
 *
 *   # paste-into-Claude bundle for the arbitration / diary narrative layer
 *   npx tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --prompt=diary --account=risk
 */
import { DatabaseSync } from "node:sqlite";
import {
  planRun,
  planChairConsensus,
  fillOrders,
  selectArbitrationCandidates,
  type ConsensusVote,
  type EngineCandidate,
  type EnginePosition,
  type ProposedOrder,
} from "../lib/shared/paper-engine-core";
import {
  PAPER_POLICY,
  TRADING_ACCOUNTS,
  PAPER_POLICY_VERSION,
  type PaperPolicy,
  type TradingAccount,
} from "../lib/shared/paper-policy";
import { buildTieBreak } from "../lib/shared/paper-persona";
import { sectorFor } from "../lib/shared/paper-sectors";

/** `TRADING_ACCOUNTS` is declared `PaperAccount[]` (it lives alongside the
 *  non-trading controls), but every entry is a TradingAccount by construction
 *  and `PAPER_POLICY` is keyed on the narrower type. Narrowed once here rather
 *  than cast at each of the four use sites. */
const TRADING: TradingAccount[] = TRADING_ACCOUNTS as TradingAccount[];

/** This repo's `@types/node` predates `node:sqlite`'s options bag and
 *  `StatementSync.get()`, both of which exist at runtime on Node 22.5+. Typed
 *  structurally here so the file compiles under the pinned types instead of
 *  forcing a dependency bump for a read-only dev script. */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const ReadOnlyDatabase = DatabaseSync as unknown as new (
  path: string,
  options?: { readOnly?: boolean },
) => SqliteDb;

// ── args ────────────────────────────────────────────────────────────────────

interface Args {
  db?: string;
  neon: boolean;
  json: boolean;
  narrate: boolean;
  policy: "current" | "v3";
  prices: "db" | "alpaca";
  account?: TradingAccount;
  prompt?: "diary" | "arbitration";
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    const eq = hit.indexOf("=");
    return eq === -1 ? "true" : hit.slice(eq + 1);
  };
  const policy = get("policy") ?? "current";
  if (policy !== "current" && policy !== "v3") throw new Error(`--policy must be current|v3`);
  const prices = get("prices") ?? "db";
  if (prices !== "db" && prices !== "alpaca") throw new Error(`--prices must be db|alpaca`);
  const prompt = get("prompt");
  if (prompt != null && prompt !== "diary" && prompt !== "arbitration") {
    throw new Error(`--prompt must be diary|arbitration`);
  }
  const account = get("account") as TradingAccount | undefined;
  if (account != null && !TRADING.includes(account)) {
    throw new Error(`--account must be one of ${TRADING.join("|")}`);
  }
  return {
    db: get("db"),
    neon: get("neon") === "true",
    json: get("json") === "true",
    narrate: get("narrate") === "true",
    policy,
    prices,
    account,
    prompt: prompt as Args["prompt"],
  };
}

// ── the state the planner needs, from either source ─────────────────────────

interface AccountState {
  account: TradingAccount;
  cash: number;
  positions: EnginePosition[];
  watchlist: string[];
  /** ticker -> card score for this account's horizon, already gated on data_quality. */
  cards: Map<string, { score: number; dataQuality: number; tokens: Record<string, string> }>;
}

interface Source {
  label: string;
  barDate: string;
  accounts: Map<TradingAccount, AccountState>;
  prices: Map<string, { price: number; tradedAt: string }>;
  close(): void;
}

/**
 * v3's proposed thresholds (docs/paper-trading-v3.md §5.3). Applied as an
 * overlay rather than edited into paper-policy.ts so this script can show the
 * before/after without the repo's own policy constant changing underneath it.
 * CHAIR's consensus rule is NOT modeled here — it needs the other five plans
 * first (§3), which is PR D's work.
 */
const V3_OVERLAY: Partial<Record<TradingAccount, Partial<PaperPolicy>>> = {
  t1: { buyThreshold: 45 },
  t2: { buyThreshold: 45, sellThreshold: -35, maxTurnoverPerRun: 0.06 },
  risk: { buyThreshold: 55 },
  macro: { buyThreshold: 45, maxTurnoverPerRun: 0.1 },
  quant: { buyThreshold: 50 },
  chair: { buyThreshold: 45 },
};

function policyFor(account: TradingAccount, mode: "current" | "v3"): PaperPolicy {
  const base = PAPER_POLICY[account];
  return mode === "v3" ? { ...base, ...V3_OVERLAY[account] } : base;
}

/** `date`/`timestamptz` arrive as a Date from Neon and as an ISO string from
 *  SQLite; both must reduce to YYYY-MM-DD for a parameterized date filter. */
function toIsoDate(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function loadFromSqlite(path: string): Source {
  const db = new ReadOnlyDatabase(path, { readOnly: true });
  // SQLite stores dates as ISO strings (lib/db/schema.sqlite.sql), so max()
  // returns e.g. "2026-09-29T04:00:00.000Z"; the card rows carry that same
  // literal, so the equality filter below must use it unsliced.
  const barDateRaw = (db.prepare(`SELECT max(bar_date) AS d FROM ticker_cards`).get() as { d: string }).d;
  const barDate = String(barDateRaw).slice(0, 10);

  const prices = new Map<string, { price: number; tradedAt: string }>();
  for (const r of db.prepare(`SELECT ticker, price, traded_at FROM live_prices`).all() as {
    ticker: string;
    price: number;
    traded_at: string;
  }[]) {
    prices.set(r.ticker, { price: Number(r.price), tradedAt: r.traded_at });
  }

  const accounts = new Map<TradingAccount, AccountState>();
  for (const account of TRADING) {
    const acct = db.prepare(`SELECT cash FROM paper_accounts WHERE account = ?`).get(account) as
      | { cash: number }
      | undefined;
    if (!acct) continue;
    const watchlist = (
      db.prepare(`SELECT ticker FROM paper_watchlists WHERE account = ? AND active = 1`).all(account) as {
        ticker: string;
      }[]
    ).map((r) => r.ticker);
    const positions = (
      db
        .prepare(`SELECT ticker, quantity, avg_cost, runs_held, high_water FROM paper_positions WHERE account = ?`)
        .all(account) as {
        ticker: string;
        quantity: number;
        avg_cost: number;
        runs_held: number;
        high_water: number;
      }[]
    ).map((r) => ({
      ticker: r.ticker,
      quantity: Number(r.quantity),
      avgCost: Number(r.avg_cost),
      runsHeld: Number(r.runs_held),
      highWater: Number(r.high_water),
    }));

    // The engine screens on the account's own cardHorizon; `both` takes the
    // higher of the two, matching reduceToScorePerTicker in lib/paper-engine.ts.
    const horizon = PAPER_POLICY[account].cardHorizon;
    const horizons = horizon === "both" ? ["t1", "t2"] : [horizon];
    const cards = new Map<string, { score: number; dataQuality: number; tokens: Record<string, string> }>();
    for (const r of db
      .prepare(
        `SELECT ticker, score, data_quality, tokens FROM ticker_cards
         WHERE bar_date = ? AND horizon IN (${horizons.map(() => "?").join(",")})`,
      )
      .all(barDateRaw, ...horizons) as {
      ticker: string;
      score: number;
      data_quality: number;
      tokens: string;
    }[]) {
      const prev = cards.get(r.ticker);
      if (prev && prev.score >= Number(r.score)) continue;
      cards.set(r.ticker, {
        score: Number(r.score),
        dataQuality: Number(r.data_quality),
        tokens: JSON.parse(r.tokens ?? "{}"),
      });
    }

    accounts.set(account, { account, cash: Number(acct.cash), positions, watchlist, cards });
  }

  return { label: `sqlite:${path}`, barDate, accounts, prices, close: () => db.close() };
}

async function loadFromNeon(): Promise<Source> {
  const { neon } = await import("@neondatabase/serverless");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — pass --env-file=.env.local, or use --db=<snapshot>");
  const sql = neon(url);

  // The pg driver hands back `date` as a JS Date, so String() would yield
  // "Tue Sep 29 …" and the parameterized filter below would reject it.
  const barDate = toIsoDate(((await sql`SELECT max(bar_date) AS d FROM ticker_cards`) as { d: unknown }[])[0].d);
  const prices = new Map<string, { price: number; tradedAt: string }>();
  for (const r of (await sql`SELECT ticker, price, traded_at FROM live_prices`) as {
    ticker: string;
    price: string;
    traded_at: string;
  }[]) {
    prices.set(r.ticker, { price: Number(r.price), tradedAt: new Date(r.traded_at).toISOString() });
  }

  const accounts = new Map<TradingAccount, AccountState>();
  for (const account of TRADING) {
    const acct = (await sql`SELECT cash FROM paper_accounts WHERE account = ${account}`) as { cash: string }[];
    if (acct.length === 0) continue;
    const watchlist = (
      (await sql`SELECT ticker FROM paper_watchlists WHERE account = ${account} AND active`) as { ticker: string }[]
    ).map((r) => r.ticker);
    const positions = (
      (await sql`SELECT ticker, quantity, avg_cost, runs_held, high_water FROM paper_positions WHERE account = ${account}`) as {
        ticker: string;
        quantity: string;
        avg_cost: string;
        runs_held: number;
        high_water: string;
      }[]
    ).map((r) => ({
      ticker: r.ticker,
      quantity: Number(r.quantity),
      avgCost: Number(r.avg_cost),
      runsHeld: Number(r.runs_held),
      highWater: Number(r.high_water),
    }));

    const horizon = PAPER_POLICY[account].cardHorizon;
    const horizons = horizon === "both" ? ["t1", "t2"] : [horizon];
    const cards = new Map<string, { score: number; dataQuality: number; tokens: Record<string, string> }>();
    for (const r of (await sql`
      SELECT ticker, score, data_quality, tokens FROM ticker_cards
      WHERE bar_date = ${barDate} AND horizon = ANY(${horizons}::text[])
    `) as { ticker: string; score: string; data_quality: string; tokens: Record<string, string> }[]) {
      const prev = cards.get(r.ticker);
      if (prev && prev.score >= Number(r.score)) continue;
      cards.set(r.ticker, {
        score: Number(r.score),
        dataQuality: Number(r.data_quality),
        tokens: r.tokens ?? {},
      });
    }

    accounts.set(account, { account, cash: Number(acct[0].cash), positions, watchlist, cards });
  }

  return { label: "neon:read-only", barDate, accounts, prices, close: () => {} };
}

/**
 * Replace the snapshot's prices with Alpaca latest trades, in memory only.
 * Reuses scripts/lib/alpaca-live-prices.mjs so symbology and the stale-trade
 * rule stay identical to the production price writer (§5.1.2).
 */
async function refreshPricesFromAlpaca(source: Source): Promise<void> {
  // Plain .mjs helper with no type declarations — shaped here rather than
  // suppressed, so a rename in that file is still a type error.
  const alpaca = (await import("./lib/alpaca-live-prices.mjs")) as unknown as {
    ALPACA_TRADES_URL: string;
    ALPACA_FEED: string;
    SYMBOLS_PER_REQUEST: number;
    chunk: <T>(items: T[], size: number) => T[][];
    toAlpacaSymbol: (ticker: string) => string;
    tradesToLivePrices: (
      tickers: string[],
      trades: Record<string, unknown>,
    ) => { ticker: string; price: number; tradedAt: string }[];
  };
  const { ALPACA_TRADES_URL, ALPACA_FEED, SYMBOLS_PER_REQUEST, chunk, toAlpacaSymbol, tradesToLivePrices } =
    alpaca;
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set — omit --prices=alpaca");
  const headers = { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret };

  const tickers = [...new Set([...source.accounts.values()].flatMap((a) => a.watchlist))].sort();
  let refreshed = 0;
  for (const group of chunk(tickers, SYMBOLS_PER_REQUEST)) {
    const url = new URL(ALPACA_TRADES_URL);
    url.searchParams.set("symbols", group.map(toAlpacaSymbol).join(","));
    url.searchParams.set("feed", ALPACA_FEED);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      process.stderr.write(`alpaca HTTP ${res.status} for ${group.length} symbols — keeping snapshot prices\n`);
      continue;
    }
    for (const row of tradesToLivePrices(group, (await res.json()).trades ?? {})) {
      source.prices.set(row.ticker, { price: row.price, tradedAt: row.tradedAt });
      refreshed++;
    }
  }
  process.stderr.write(`prices: refreshed ${refreshed}/${tickers.length} from alpaca (in memory, not persisted)\n`);
}

// ── planning + narration ────────────────────────────────────────────────────

interface Ticket {
  ticker: string;
  side: "buy" | "sell";
  reason: string;
  pctNav: number;
  fillPrice: number;
  slippageBps: number;
  score: number | null;
  sector: string;
  tokens: Record<string, string>;
  stopPrice: number;
  tiedWith: string[];
  arbitrated: string | null;
  priceAgeHours: number | null;
}

interface BotPlan {
  account: TradingAccount;
  nav: number;
  cash: number;
  buyThreshold: number;
  eligible: { ticker: string; score: number }[];
  tickets: Ticket[];
  turnoverPct: number;
  arbitrationCalls: number;
  stalePrices: string[];
}

function hoursOld(tradedAt: string | undefined, now: number): number | null {
  if (!tradedAt) return null;
  const ms = Date.parse(tradedAt);
  return Number.isFinite(ms) ? (now - ms) / 3_600_000 : null;
}

function planFor(
  state: AccountState,
  source: Source,
  mode: "current" | "v3",
  now: number,
  chairVotes?: ConsensusVote[],
): BotPlan {
  const policy = policyFor(state.account, mode);
  const activeWatchlist = new Set(state.watchlist);
  const prices: Record<string, number> = {};
  for (const ticker of new Set([...state.watchlist, ...state.positions.map((p) => p.ticker)])) {
    const row = source.prices.get(ticker);
    if (row) prices[ticker] = row.price;
  }

  const candidates: EngineCandidate[] = state.watchlist
    .map((ticker) => ({ ticker, card: state.cards.get(ticker) }))
    .filter((c) => c.card != null && c.card.dataQuality >= policy.dataQualityGate)
    .map((c) => ({ ticker: c.ticker, score: c.card!.score, tokens: c.card!.tokens, dataQuality: c.card!.dataQuality }));

  // MARK, as lib/paper-engine.ts does it before planning.
  const marked: EnginePosition[] = state.positions.map((p) => ({
    ...p,
    runsHeld: p.runsHeld + 1,
    highWater: Math.max(p.highWater, prices[p.ticker] ?? p.avgCost),
  }));
  const positionsMv = marked.reduce((sum, p) => sum + p.quantity * (prices[p.ticker] ?? p.avgCost), 0);
  const nav = state.cash + positionsMv;

  // CodeRabbit review, PR #204: CHAIR is planned through planChairConsensus in
  // production, never planRun — its buyThreshold field is unused for
  // decisions (lib/shared/paper-policy.ts's own comment on it). Printing a
  // planRun-with-threshold result for CHAIR was not the engine's actual plan.
  // Every other account gets its persona tie-break (lib/shared/paper-persona.ts)
  // and the same trade_date-seeded hash fallback production uses, instead of
  // the plain alphabetical order this script fell back to before.
  const plan =
    state.account === "chair"
      ? planChairConsensus(policy, nav, state.cash, marked, chairVotes ?? [], activeWatchlist, prices)
      : planRun({
          policy,
          nav,
          cash: state.cash,
          positions: marked,
          candidates,
          activeWatchlist,
          prices,
          tieBreak: buildTieBreak(state.account, candidates),
          tieBreakSeed: source.barDate,
        });

  const scores = new Map(candidates.map((c) => [c.ticker, c.score]));
  const arbitration = selectArbitrationCandidates(
    plan.orders,
    policy,
    new Map(marked.map((p) => [p.ticker, p])),
    scores,
    prices,
    policy.maxModelCallsPerRun,
  );
  const arbitratedBy = new Map(arbitration.map((a) => [a.order.ticker, a.flagReason]));

  const avgCost = new Map(marked.map((p) => [p.ticker, p.avgCost]));
  const filled = fillOrders(plan.orders, avgCost);

  const tickets: Ticket[] = filled.map((o: ProposedOrder & { fillPrice: number; slippageBps: number; notional: number }) => {
    const score = scores.get(o.ticker) ?? null;
    const tied =
      score == null
        ? []
        : candidates
            .filter((c) => c.score === score && c.ticker !== o.ticker && c.score >= policy.buyThreshold)
            .map((c) => c.ticker)
            .sort();
    const basis = policy.stopRule.kind === "fixed" ? o.fillPrice : o.fillPrice;
    return {
      ticker: o.ticker,
      side: o.side,
      reason: o.reason,
      pctNav: (o.notional / nav) * 100,
      fillPrice: o.fillPrice,
      slippageBps: o.slippageBps,
      score,
      sector: sectorFor(o.ticker) ?? "?",
      tokens: state.cards.get(o.ticker)?.tokens ?? {},
      stopPrice: basis * (1 - policy.stopRule.pct),
      tiedWith: tied,
      arbitrated: arbitratedBy.get(o.ticker) ?? null,
      priceAgeHours: hoursOld(source.prices.get(o.ticker)?.tradedAt, now),
    };
  });

  const eligible = candidates
    .filter((c) => c.score >= policy.buyThreshold)
    .sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));

  const stalePrices = state.watchlist.filter((t) => {
    const age = hoursOld(source.prices.get(t)?.tradedAt, now);
    return age == null || age > 24;
  });

  return {
    account: state.account,
    nav,
    cash: state.cash,
    buyThreshold: policy.buyThreshold,
    eligible,
    tickets,
    turnoverPct: plan.turnoverUsed * 100,
    arbitrationCalls: arbitration.length,
    stalePrices,
  };
}

/** §4.1's deterministic trade ticket. No model involved — every value here is
 *  read from the card, the policy, or the fill. */
function ticketText(account: TradingAccount, t: Ticket, policy: PaperPolicy): string {
  const tok = t.tokens;
  const card = `card ${t.score} (${tok.direction ?? "?"}/${tok.confluence ?? "?"} confluence; MACD ${tok.macd ?? "?"}; RSI ${tok.rsi ?? "?"}; ADX ${tok.adx ?? "?"}; vol ${tok.vol ?? "?"})`;
  // The order's own reason outranks the card: a stop-out is a stop-out even
  // when the card still reads 100, and saying "card 100" there is misleading.
  const why =
    t.reason === "stop"
      ? `STOP HIT — ${policy.stopRule.kind} ${(policy.stopRule.pct * 100).toFixed(0)}% breached (card still reads ${t.score})`
      : t.reason === "void"
        ? "forced exit — no longer on the active watchlist"
        : t.reason === "score_exit"
          ? `signal exit — ${card}`
          : t.score == null
            ? "no card"
            : card;
  const tie =
    t.tiedWith.length > 0
      ? `Picked over ${t.tiedWith.length} name(s) tied at ${t.score}: ${t.tiedWith.slice(0, 6).join(", ")}${t.tiedWith.length > 6 ? "…" : ""} — tie-break: this seat's persona rule, then a trade_date-seeded hash (lib/shared/paper-persona.ts).`
      : "No tie at this score.";
  return [
    `${account.toUpperCase()} ${t.side}s ${t.ticker} — ${t.pctNav.toFixed(1)}% of NAV at $${t.fillPrice.toFixed(2)} (${t.slippageBps} bps).`,
    `Why: ${why}.`,
    tie,
    `Stop: ${policy.stopRule.kind} ${(policy.stopRule.pct * 100).toFixed(0)}% → $${t.stopPrice.toFixed(2)}. Exit on signal if card < ${policy.sellThreshold} after ${policy.minHoldingPeriodRuns} runs.`,
    t.arbitrated ? `Arbitration: flagged (${t.arbitrated}) — a model gets a veto/downsize/confirm on this one.` : `Arbitration: not flagged — rule-only.`,
    t.priceAgeHours != null && t.priceAgeHours > 1
      ? `⚠️ Reference price is ${t.priceAgeHours.toFixed(1)}h old.`
      : "",
  ]
    .filter(Boolean)
    .join("\n  ");
}

/** §4.3/§4.2: a paste-into-Claude bundle. Facts only — the chat supplies the
 *  voice, and the number lint in §4.3 is what keeps it honest. */
function promptBundle(kind: "diary" | "arbitration", plans: BotPlan[], source: Source, args: Args): string {
  const out: string[] = [];
  out.push(`# paper-sim facts — source ${source.label}, bar_date ${source.barDate}`);
  out.push(
    `\nThese are the ONLY numbers you may use. Do not introduce any number that does not appear below.\n`,
  );
  for (const p of plans) {
    const policy = policyFor(p.account, args.policy);
    out.push(`\n## ${p.account.toUpperCase()}  (NAV $${p.nav.toFixed(2)}, cash $${p.cash.toFixed(2)})`);
    out.push(
      `- buy threshold ${p.buyThreshold}; ${p.eligible.length} names eligible; turnover ${p.turnoverPct.toFixed(1)}% of a ${(policy.maxTurnoverPerRun * 100).toFixed(0)}% cap`,
    );
    if (p.tickets.length === 0) out.push(`- no trades this slot`);
    for (const t of p.tickets) out.push(`- ${ticketText(p.account, t, policy).replace(/\n\s+/g, " ")}`);
    if (p.stalePrices.length > 0) out.push(`- ${p.stalePrices.length} watchlist names have no fresh price`);
  }
  out.push(
    kind === "diary"
      ? `\n---\nTASK: for each bot above, write its settle diary entry — at most 120 words, in that bot's voice (see docs/paper-trading-v3.md §3). Every number you write must appear above verbatim. If you have nothing to report, say so plainly; a no-trade day is a legitimate entry.`
      : `\n---\nTASK: for each trade marked "Arbitration: flagged", answer as that seat with a single-line JSON object: {"action":"veto|downsize|confirm","downsize_pct":0.0,"why":"<=25 words"}. You may not change the ticker or propose a size. An unparseable answer is treated as confirm.`,
  );
  return out.join("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.db && !args.neon) {
    throw new Error("pass --db=<snapshot.sqlite> or --neon (see this file's header for examples)");
  }

  const source = args.db ? loadFromSqlite(args.db) : await loadFromNeon();
  try {
    if (args.prices === "alpaca") await refreshPricesFromAlpaca(source);

    const now = Date.now();
    const wanted = args.account ? [args.account] : TRADING;

    // CHAIR always reads the other five seats' own fills (planChairConsensus
    // in lib/shared/paper-engine-core.ts) — production gets this from
    // committed orders for the exact slot; this simulator has no run to read
    // back, so it computes the five siblings' plans first, regardless of
    // `wanted`, the same way production always has all five committed by the
    // time CHAIR's turn comes in PAPER_ACCOUNTS order.
    const siblingAccounts = TRADING.filter((a) => a !== "chair");
    const siblingPlans = siblingAccounts
      .map((a) => source.accounts.get(a))
      .filter((s): s is AccountState => s != null)
      .map((s) => planFor(s, source, args.policy, now));
    const buyVotes = new Map<string, Set<string>>();
    const sellVotes = new Map<string, Set<string>>();
    for (const sp of siblingPlans) {
      for (const t of sp.tickets) {
        const bucket = t.side === "buy" ? buyVotes : sellVotes;
        if (!bucket.has(t.ticker)) bucket.set(t.ticker, new Set());
        bucket.get(t.ticker)!.add(sp.account);
      }
    }
    const chairTickers = new Set([...buyVotes.keys(), ...sellVotes.keys()]);
    const chairVotes: ConsensusVote[] = [...chairTickers].map((ticker) => ({
      ticker,
      buyVotes: buyVotes.get(ticker)?.size ?? 0,
      sellVotes: sellVotes.get(ticker)?.size ?? 0,
      totalSeats: siblingAccounts.length,
    }));

    const plans = wanted
      .map((a) => {
        if (a === "chair") {
          const chairState = source.accounts.get(a);
          return chairState ? planFor(chairState, source, args.policy, now, chairVotes) : undefined;
        }
        // Reuse the already-computed sibling plan instead of recomputing it.
        return siblingPlans.find((sp) => sp.account === a);
      })
      .filter((p): p is BotPlan => p != null);

    if (args.prompt) {
      process.stdout.write(promptBundle(args.prompt, plans, source, args) + "\n");
      return;
    }
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ source: source.label, barDate: source.barDate, policy: args.policy, plans }, null, 2) + "\n",
      );
      return;
    }

    process.stdout.write(
      `source ${source.label} · bar_date ${source.barDate} · policy ${args.policy === "v3" ? "v3 (proposed)" : PAPER_POLICY_VERSION} · prices ${args.prices}\n\n`,
    );
    const overlap = new Map<string, string[]>();
    for (const p of plans) {
      const orders =
        p.tickets.length === 0
          ? "—"
          : p.tickets.map((t) => `${t.side} ${t.ticker} ${t.pctNav.toFixed(1)}%`).join(", ");
      process.stdout.write(
        `${p.account.padEnd(6)} buy≥${String(p.buyThreshold).padStart(3)}  eligible ${String(p.eligible.length).padStart(3)}  turnover ${p.turnoverPct.toFixed(1).padStart(5)}%  arb ${p.arbitrationCalls}  ${orders}\n`,
      );
      for (const t of p.tickets.filter((x) => x.side === "buy")) {
        overlap.set(t.ticker, [...(overlap.get(t.ticker) ?? []), p.account]);
      }
    }

    // A ticker both sold and bought in one plan is F13 — the stop-out is
    // undone in the same run. Worth shouting about: it silently defeats a stop.
    for (const p of plans) {
      const sold = new Set(p.tickets.filter((t) => t.side === "sell").map((t) => t.ticker));
      const churned = p.tickets.filter((t) => t.side === "buy" && sold.has(t.ticker)).map((t) => t.ticker);
      if (churned.length > 0) {
        process.stdout.write(
          `\n⚠️  ${p.account}: sold AND re-bought ${churned.join(", ")} in the same run (F13 — the exit is undone immediately)\n`,
        );
      }
    }

    const shared = [...overlap.entries()].filter(([, who]) => who.length > 1).sort((a, b) => b[1].length - a[1].length);
    if (shared.length > 0) {
      process.stdout.write(`\nOverlap — the same name bought by several bots:\n`);
      for (const [ticker, who] of shared) {
        process.stdout.write(`  ${ticker.padEnd(6)} ${who.length}/${plans.length} bots: ${who.join(", ")}\n`);
      }
    }

    if (args.narrate) {
      process.stdout.write(`\n── trade tickets ──\n`);
      for (const p of plans) {
        for (const t of p.tickets) {
          process.stdout.write(`\n  ${ticketText(p.account, t, policyFor(p.account, args.policy))}\n`);
        }
      }
    }
  } finally {
    source.close();
  }
}

main().catch((err) => {
  process.stderr.write(`paper-sim failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
