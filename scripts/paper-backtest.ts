#!/usr/bin/env node --experimental-strip-types
/**
 * paper-backtest — replay the paper-trading engine over the last N real
 * trading days, using real historical prices and cards computed the same way
 * production computes them, written ONLY to a local SQLite file.
 *
 * Why this exists (docs/paper-trading-v3.md F12/§8): `ticker_cards` keeps
 * only the latest `bar_date` — there is no historical card series to replay,
 * so "simulate the last month" cannot mean "read what happened." It means
 * *recomputing* a card for every past day from real historical bars, the same
 * way `scripts/hydrate-local.mjs` computes today's card, then feeding that
 * sequence through the same planner production uses. This script does that.
 *
 * What "the same code" means here, concretely:
 *   - Indicators: scripts/lib/hydrate-indicators.mjs (rsi/macdCross/adx/
 *     volatilityPercentile/confluence) — the exact functions
 *     scripts/hydrate-local.mjs calls, pinned against the Python reference
 *     job by __tests__/hydrate-indicators.test.ts.
 *   - Scoring: lib/shared/card-policy.ts's buildCard/scoreCard — the exact
 *     function that turns a card's tokens into `ticker_cards.score`.
 *   - Planning: lib/shared/paper-engine-core.ts's planRun/planChairConsensus/
 *     fillOrders and lib/shared/paper-persona.ts's buildTieBreak — the same
 *     pure functions lib/paper-engine.ts calls in production, imported
 *     directly, not reimplemented.
 *
 * What is NOT the same, and is stated plainly rather than glossed over:
 *   - One decision per day, not four. Alpaca's free daily-bar timeframe is
 *     the only historical granularity available; there is no historical
 *     intraday feed to replay preopen/midday/preclose/settle separately.
 *     Every account's minHoldingPeriodRuns therefore means "this many
 *     trading days" here, not "this many quarter-days."
 *   - No model arbitration calls. Spending real OPENROUTER_API_KEY credits
 *     on ~22 days x 6 accounts of veto/downsize/confirm calls was not
 *     authorized for this run; every flagged candidate is left CONFIRMed
 *     (`selectArbitrationCandidates` output is recorded in `detail` for
 *     inspection, but `arbitrateOne` is never called). A real historical
 *     arbitration replay is a stated follow-up, not something this script
 *     quietly fakes.
 *   - Slippage/fill mechanics are real (`fillOrders`), but the fill price is
 *     the day's close, not an intraday print — there is no historical
 *     intraday tick to fill against either.
 *
 * READ-ONLY against every live system it touches: Alpaca (market data GET
 * only) and the local SQLite file it creates itself. It never touches Neon,
 * never touches production `live_prices`/`ticker_cards`/`paper_*` tables, and
 * refuses to overwrite an existing output file (same convention as
 * scripts/backup-to-sqlite.mjs) so a bad run can't destroy a prior one.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/.bin/tsx scripts/paper-backtest.ts \
 *     --watchlists=backups/paper-local.sqlite --days=22 --out=backups/paper-backtest.sqlite
 */
import { DatabaseSync } from "node:sqlite";

/** This repo's @types/node predates node:sqlite's real API (readOnly option,
 *  StatementSync.get/run's return shapes). Typed structurally, same fix as
 *  scripts/paper-sim.ts, so this compiles under the pinned types instead of
 *  forcing a dependency bump for a dev/backtest script. */
interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
}
interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
const Database = DatabaseSync as unknown as new (path: string, options?: { readOnly?: boolean }) => SqliteDb;
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { rsi, macdCross, adx, volatilityPercentile, confluence } from "./lib/hydrate-indicators.mjs";
import { buildCard, type FrameStats } from "../lib/shared/card-policy";
import type { SignalStateInput } from "../lib/grounding/taxonomy";
import {
  planRun,
  planChairConsensus,
  fillOrders,
  selectArbitrationCandidates,
  type EngineCandidate,
  type EnginePosition,
  type ConsensusVote,
  type ProposedOrder,
} from "../lib/shared/paper-engine-core";
import { PAPER_POLICY, TRADING_ACCOUNTS, PAPER_POLICY_VERSION, type TradingAccount } from "../lib/shared/paper-policy";

// TRADING_ACCOUNTS is declared PaperAccount[] (it lives alongside the
// non-trading equal/spy controls); every entry is a TradingAccount by
// construction and PAPER_POLICY is keyed on the narrower type. Narrowed once
// here rather than cast at each use site (same fix as scripts/paper-sim.ts).
const TRADING: TradingAccount[] = TRADING_ACCOUNTS as TradingAccount[];
import { buildTieBreak } from "../lib/shared/paper-persona";

// ── args ────────────────────────────────────────────────────────────────────

function argVal(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "true" : hit.slice(eq + 1);
}

const argv = process.argv.slice(2);
const WATCHLISTS_DB = argVal(argv, "watchlists");
const OUT_PATH = argVal(argv, "out") ?? "backups/paper-backtest.sqlite";
const DAYS = Number(argVal(argv, "days") ?? "22");
if (!WATCHLISTS_DB) {
  throw new Error("pass --watchlists=<snapshot.sqlite> (a real paper_watchlists snapshot — see scripts/backup-to-sqlite.mjs)");
}
if (!Number.isInteger(DAYS) || DAYS < 1 || DAYS > 250) throw new Error("--days must be an integer in [1, 250]");
if (existsSync(OUT_PATH)) {
  throw new Error(`${OUT_PATH} already exists — pass a fresh --out= path (never overwrites, same as backup-to-sqlite.mjs)`);
}

// ── Alpaca historical bars (read-only) ──────────────────────────────────────

const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_API_SECRET;
if (!ALPACA_KEY || !ALPACA_SECRET) {
  throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set — pass --env-file=.env.local");
}

interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

const SHARE_CLASS_RE = /^([A-Z]+)-([A-Z])$/;
function toAlpacaSymbol(ticker: string): string {
  const m = SHARE_CLASS_RE.exec(ticker);
  return m ? `${m[1]}.${m[2]}` : ticker;
}

/** ~1 trading year of daily bars so every indicator has the history it needs
 *  (ADX wants 28 bars, volatilityPercentile wants 40, MACD wants 35) as of
 *  the OLDEST day this backtest will price, not just the most recent one. */
const LOOKBACK_CALENDAR_DAYS = 400;

async function fetchDailyBars(tickers: string[]): Promise<Map<string, Bar[]>> {
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_CALENDAR_DAYS);
  const startIso = start.toISOString().slice(0, 10);
  const merged = new Map<string, Bar[]>();
  const CHUNK = 100;

  for (let i = 0; i < tickers.length; i += CHUNK) {
    let remaining = tickers.slice(i, i + CHUNK).map(toAlpacaSymbol);
    const dropped: string[] = [];
    while (remaining.length > 0) {
      let pageToken: string | null = null;
      let hadError = false;
      do {
        const url = new URL("https://data.alpaca.markets/v2/stocks/bars");
        url.searchParams.set("symbols", remaining.join(","));
        url.searchParams.set("timeframe", "1Day");
        url.searchParams.set("start", startIso);
        url.searchParams.set("limit", "10000");
        url.searchParams.set("feed", "iex");
        url.searchParams.set("adjustment", "split");
        if (pageToken) url.searchParams.set("page_token", pageToken);
        const res = await fetch(url, {
          headers: { "APCA-API-KEY-ID": ALPACA_KEY!, "APCA-API-SECRET-KEY": ALPACA_SECRET! },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
          const text = await res.text();
          const bad = /invalid symbol:\s*([^"'}\s]+)/i.exec(text)?.[1];
          if (bad && remaining.includes(bad)) {
            dropped.push(bad);
            remaining = remaining.filter((s) => s !== bad);
            hadError = true;
            break;
          }
          throw new Error(`Alpaca bars HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as { bars?: Record<string, Bar[]>; next_page_token?: string | null };
        for (const [sym, bars] of Object.entries(data.bars ?? {})) {
          const ticker = sym.includes(".") ? sym.replace(".", "-") : sym;
          merged.set(ticker, [...(merged.get(ticker) ?? []), ...bars]);
        }
        pageToken = data.next_page_token ?? null;
      } while (pageToken);
      if (!hadError) break;
    }
    if (dropped.length > 0) process.stderr.write(`  skipped ${dropped.length} unusable symbols: ${dropped.join(", ")}\n`);
  }
  for (const bars of merged.values()) bars.sort((a, b) => a.t.localeCompare(b.t));
  return merged;
}

// ── card computation for one ticker as of one historical day ───────────────

type CardResult = { score: number; dataQuality: number; tokens: Record<string, string>; action: string };

/**
 * Cards for BOTH horizons as of one historical day. CodeRabbit review, PR
 * #204: this used to hardcode "t1" regardless of which horizon the calling
 * account actually reads, silently making every account screen on T1 scores
 * — removing the one structural difference between, say, T1 and T2 that this
 * backtest could have shown. (In this codebase's current scoring, `horizon`
 * only labels the card's tokens/state-key — scoreCard() itself never reads
 * it, so t1Card and t2Card are numerically identical today; that is F4, a
 * separate documented production gap, not something to paper over here by
 * only ever computing one of them.)
 */
function cardsAsOf(ticker: string, bars: Bar[], asOfIndex: number): { t1: CardResult | null; t2: CardResult | null } {
  const window = bars.slice(0, asOfIndex + 1);
  if (window.length < 60) return { t1: null, t2: null }; // MIN_USEFUL_BARS from card-policy.ts
  const close = window.map((b) => b.c);
  const high = window.map((b) => b.h);
  const low = window.map((b) => b.l);

  const rsiVal = rsi(close);
  const macdVal = macdCross(close);
  const adxVal = adx(high, low, close);
  const volVal = volatilityPercentile(close);
  const confluenceResult = confluence(rsiVal, macdVal === "missing" ? undefined : macdVal, adxVal) as {
    score: number | null;
    direction: "bullish" | "bearish" | "neutral" | null;
  };

  const input: SignalStateInput = {
    rsi: rsiVal,
    macdCross: macdVal === "missing" ? null : (macdVal as "bullish" | "bearish" | null),
    adx: adxVal,
    volatilityPercentile: volVal,
    confluenceScore: confluenceResult.score,
    direction: confluenceResult.direction,
  };
  const frameStats: FrameStats = { barCount: window.length, nanRatio: 0, staleTradingDays: 0 };
  const toResult = (horizon: "t1" | "t2"): CardResult => {
    const card = buildCard(ticker, "stock", input, horizon, frameStats);
    return { score: card.score, dataQuality: card.dataQuality, tokens: card.tokens as unknown as Record<string, string>, action: card.action };
  };
  return { t1: toResult("t1"), t2: toResult("t2") };
}

/** Select the score an account's own `cardHorizon` would actually read —
 *  same "both -> higher of the two" convention as
 *  lib/paper-engine.ts's reduceToScorePerTicker in production. */
function selectCard(cards: { t1: CardResult | null; t2: CardResult | null }, horizon: "t1" | "t2" | "both"): CardResult | null {
  if (horizon === "t1") return cards.t1;
  if (horizon === "t2") return cards.t2;
  if (cards.t1 && cards.t2) return cards.t1.score >= cards.t2.score ? cards.t1 : cards.t2;
  return cards.t1 ?? cards.t2;
}

// ── local sqlite output ──────────────────────────────────────────────────────

mkdirSync(dirname(OUT_PATH), { recursive: true });
const out = new Database(OUT_PATH);
out.exec(`
  CREATE TABLE accounts (account TEXT PRIMARY KEY, cash REAL NOT NULL, starting_cash REAL NOT NULL);
  CREATE TABLE positions (account TEXT NOT NULL, ticker TEXT NOT NULL, quantity REAL NOT NULL, avg_cost REAL NOT NULL, runs_held INTEGER NOT NULL, high_water REAL NOT NULL, PRIMARY KEY (account, ticker));
  CREATE TABLE orders (id TEXT PRIMARY KEY, trade_date TEXT NOT NULL, account TEXT NOT NULL, ticker TEXT NOT NULL, side TEXT NOT NULL, quantity REAL NOT NULL, ref_price REAL NOT NULL, fill_price REAL NOT NULL, notional REAL NOT NULL, realized_pnl REAL, reason TEXT NOT NULL, card_score REAL, arbitration_flag TEXT);
  CREATE TABLE nav (trade_date TEXT NOT NULL, account TEXT NOT NULL, cash REAL NOT NULL, positions_mv REAL NOT NULL, nav REAL NOT NULL, day_return REAL, total_return REAL, turnover REAL NOT NULL, PRIMARY KEY (trade_date, account));
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const insertOrder = out.prepare(
  `INSERT INTO orders (id, trade_date, account, ticker, side, quantity, ref_price, fill_price, notional, realized_pnl, reason, card_score, arbitration_flag) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
);
const insertNav = out.prepare(
  `INSERT INTO nav (trade_date, account, cash, positions_mv, nav, day_return, total_return, turnover) VALUES (?,?,?,?,?,?,?,?)`,
);
const upsertPosition = out.prepare(
  `INSERT INTO positions (account, ticker, quantity, avg_cost, runs_held, high_water) VALUES (?,?,?,?,?,?)
   ON CONFLICT(account, ticker) DO UPDATE SET quantity=excluded.quantity, avg_cost=excluded.avg_cost, runs_held=excluded.runs_held, high_water=excluded.high_water`,
);
const deletePosition = out.prepare(`DELETE FROM positions WHERE account = ? AND ticker = ?`);
const setCash = out.prepare(`UPDATE accounts SET cash = ? WHERE account = ?`);

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const wl = new Database(WATCHLISTS_DB!, { readOnly: true });
  const watchlistRows = wl.prepare(`SELECT account, ticker FROM paper_watchlists WHERE active = 1`).all() as {
    account: string;
    ticker: string;
  }[];
  wl.close();
  const watchlistByAccount = new Map<TradingAccount, string[]>();
  for (const r of watchlistRows) {
    if (!TRADING.includes(r.account as TradingAccount)) continue;
    const acc = r.account as TradingAccount;
    watchlistByAccount.set(acc, [...(watchlistByAccount.get(acc) ?? []), r.ticker]);
  }
  const allTickers = [...new Set(watchlistRows.map((r) => r.ticker))];
  process.stderr.write(`fetching ${allTickers.length} tickers' daily bars from Alpaca (real, read-only)...\n`);
  const barsByTicker = await fetchDailyBars(allTickers);
  process.stderr.write(`got bars for ${barsByTicker.size}/${allTickers.length} tickers\n`);

  // The N most recent trading days present in the fetched series (naive:
  // whatever days Alpaca actually returned bars for — this already excludes
  // weekends/holidays since Alpaca simply has no bar on those days).
  const allDates = [...new Set([...barsByTicker.values()].flatMap((bars) => bars.map((b) => b.t.slice(0, 10))))].sort();
  const tradingDays = allDates.slice(-DAYS);
  if (tradingDays.length < DAYS) {
    process.stderr.write(`warning: only ${tradingDays.length} trading days available (asked for ${DAYS})\n`);
  }
  process.stderr.write(`replaying ${tradingDays.length} trading days: ${tradingDays[0]} .. ${tradingDays.at(-1)}\n`);

  for (const account of TRADING) {
    out.exec(`INSERT INTO accounts (account, cash, starting_cash) VALUES ('${account}', 10000, 10000)`);
  }
  out.exec(`INSERT INTO meta (key, value) VALUES ('policy_version', '${PAPER_POLICY_VERSION}')`);
  out.exec(`INSERT INTO meta (key, value) VALUES ('days_replayed', '${tradingDays.length}')`);
  out.exec(`INSERT INTO meta (key, value) VALUES ('start_date', '${tradingDays[0]}')`);
  out.exec(`INSERT INTO meta (key, value) VALUES ('end_date', '${tradingDays.at(-1)}')`);

  // In-memory book, mirrored to `out` after each day.
  const cash = new Map<TradingAccount, number>(TRADING.map((a) => [a, 10_000]));
  const positions = new Map<TradingAccount, Map<string, EnginePosition>>(TRADING.map((a) => [a, new Map()]));
  let flaggedTotal = 0;
  let orderTotal = 0;

  for (const tradeDate of tradingDays) {
    // Prices + cards for every ticker as of this day, computed once and
    // shared across every account that watches that ticker.
    const dayIndex = new Map<string, number>(); // ticker -> bar index for tradeDate
    for (const [ticker, bars] of barsByTicker) {
      const idx = bars.findIndex((b) => b.t.slice(0, 10) === tradeDate);
      if (idx >= 0) dayIndex.set(ticker, idx);
    }
    // CodeRabbit review, PR #204 (Major — lookahead): the original code
    // computed each day's card from a window ending in that day's OWN bar,
    // then used that same day's close as the price the plan traded against.
    // That means the "signal" already knew the day's outcome before deciding
    // to trade on it — not a realistic replay of a system that decides once
    // and then executes. Planning (cards, MARK, sizing, stop checks, sector/
    // turnover/cash-floor math — everything `prices` feeds into planRun/
    // planChairConsensus) now uses the PRIOR day's close; only the actual
    // fill (via fillOrders' executionPrices override) and the end-of-day
    // mark-to-market use the trade-date's own close, matching how a
    // real "decide after yesterday's close, execute today" system works.
    // A ticker on its first available bar (idx === 0) has no prior close and
    // is simply not planned that day — the same "no reference price" fallout
    // planRun already has for any ticker with a missing price.
    const executionPriceOf = new Map<string, number>();
    const planningPriceOf = new Map<string, number>();
    const cardsOf = new Map<string, { t1: CardResult | null; t2: CardResult | null }>();
    for (const [ticker, idx] of dayIndex) {
      const bars = barsByTicker.get(ticker)!;
      executionPriceOf.set(ticker, bars[idx].c);
      if (idx > 0) {
        planningPriceOf.set(ticker, bars[idx - 1].c);
        cardsOf.set(ticker, cardsAsOf(ticker, bars, idx - 1));
      }
    }

    // CHAIR reads the other five's fills for this exact day — computed after
    // this loop by re-deriving votes from the orders this day's loop writes.
    const dayOrdersBySibling: { account: TradingAccount; ticker: string; side: "buy" | "sell" }[] = [];

    for (const account of TRADING) {
      const policy = PAPER_POLICY[account];
      const watchlist = new Set(watchlistByAccount.get(account) ?? []);
      const accountPositions = positions.get(account)!;
      const marked: EnginePosition[] = [...accountPositions.values()].map((p) => ({
        ...p,
        runsHeld: p.runsHeld + 1,
        highWater: Math.max(p.highWater, planningPriceOf.get(p.ticker) ?? p.avgCost),
      }));
      const positionsMv = marked.reduce((s, p) => s + p.quantity * (planningPriceOf.get(p.ticker) ?? p.avgCost), 0);
      const nav = cash.get(account)! + positionsMv;
      if (nav <= 0) continue;

      const candidates: EngineCandidate[] = [...watchlist]
        .map((ticker) => ({ ticker, card: selectCard(cardsOf.get(ticker) ?? { t1: null, t2: null }, policy.cardHorizon) }))
        .filter((c) => c.card != null && c.card.dataQuality >= policy.dataQualityGate)
        .map((c) => ({ ticker: c.ticker, score: c.card!.score, tokens: c.card!.tokens, dataQuality: c.card!.dataQuality }));
      const prices = Object.fromEntries(planningPriceOf);

      let plan: { orders: ProposedOrder[]; turnoverUsed: number };
      if (account === "chair") {
        const buyVotes = new Map<string, Set<string>>();
        const sellVotes = new Map<string, Set<string>>();
        for (const o of dayOrdersBySibling) {
          const bucket = o.side === "buy" ? buyVotes : sellVotes;
          if (!bucket.has(o.ticker)) bucket.set(o.ticker, new Set());
          bucket.get(o.ticker)!.add(o.account);
        }
        const tickers = new Set([...buyVotes.keys(), ...sellVotes.keys()]);
        const votes: ConsensusVote[] = [...tickers].map((ticker) => ({
          ticker,
          buyVotes: buyVotes.get(ticker)?.size ?? 0,
          sellVotes: sellVotes.get(ticker)?.size ?? 0,
          totalSeats: TRADING.length - 1,
        }));
        plan = planChairConsensus(policy, nav, cash.get(account)!, marked, votes, watchlist, prices);
      } else {
        const tieBreak = buildTieBreak(account, candidates);
        plan = planRun({
          policy,
          nav,
          cash: cash.get(account)!,
          positions: marked,
          candidates,
          activeWatchlist: watchlist,
          prices,
          tieBreak,
          tieBreakSeed: tradeDate,
        });
      }

      const scores = new Map(candidates.map((c) => [c.ticker, c.score]));
      const flagged = selectArbitrationCandidates(
        plan.orders,
        policy,
        new Map(marked.map((p) => [p.ticker, p])),
        scores,
        prices,
        policy.maxModelCallsPerRun,
      );
      flaggedTotal += flagged.length;
      const flagByTicker = new Map(flagged.map((f) => [f.order.ticker, f.flagReason]));

      const avgCostByTicker = new Map(marked.map((p) => [p.ticker, p.avgCost]));
      // executionPriceOf (trade-date close), not the planningPriceOf the plan
      // was sized against — see the lookahead note above and fillOrders'
      // own doc on this parameter. No arbitration calls — see module doc.
      const filled = fillOrders(plan.orders, avgCostByTicker, Object.fromEntries(executionPriceOf));

      let newCash = cash.get(account)!;
      const newPositions = new Map(marked.map((p) => [p.ticker, { ...p }]));
      for (const o of filled) {
        orderTotal++;
        insertOrder.run(
          randomUUID(),
          tradeDate,
          account,
          o.ticker,
          o.side,
          o.quantity,
          o.refPrice,
          o.fillPrice,
          o.notional,
          o.realizedPnl,
          o.reason,
          scores.get(o.ticker) ?? null,
          flagByTicker.get(o.ticker) ?? null,
        );
        dayOrdersBySibling.push({ account, ticker: o.ticker, side: o.side });
        if (o.side === "sell") {
          newCash += o.notional;
          newPositions.delete(o.ticker);
          deletePosition.run(account, o.ticker);
        } else {
          newCash -= o.notional;
          const existing = newPositions.get(o.ticker);
          if (existing) {
            existing.avgCost = (existing.avgCost * existing.quantity + o.notional) / (existing.quantity + o.quantity);
            existing.quantity += o.quantity;
          } else {
            newPositions.set(o.ticker, { ticker: o.ticker, quantity: o.quantity, avgCost: o.fillPrice, runsHeld: 0, highWater: o.fillPrice });
          }
        }
      }
      cash.set(account, newCash);
      positions.set(account, newPositions);
      for (const p of newPositions.values()) upsertPosition.run(account, p.ticker, p.quantity, p.avgCost, p.runsHeld, p.highWater);
      setCash.run(newCash, account);

      // End-of-day mark-to-market is an honest valuation snapshot taken
      // AFTER today's move, not a planning input — the trade-date close is
      // the correct number here, unlike everywhere above.
      const finalMv = [...newPositions.values()].reduce((s, p) => s + p.quantity * (executionPriceOf.get(p.ticker) ?? p.avgCost), 0);
      const finalNav = newCash + finalMv;
      insertNav.run(tradeDate, account, newCash, finalMv, finalNav, nav > 0 ? finalNav / nav - 1 : null, finalNav / 10_000 - 1, plan.turnoverUsed);
    }
  }

  out.close();
  process.stderr.write(
    `\ndone: ${tradingDays.length} days, ${orderTotal} fills, ${flaggedTotal} candidates would have been arbitrated (no model calls made) -> ${OUT_PATH}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`paper-backtest failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
