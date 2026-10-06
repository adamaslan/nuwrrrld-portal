/**
 * Policy v4 holdings floor (docs/paper-trading-v3.md §3.1): every trading
 * account's persona starter book must be buyable in full, inside the account's
 * own watchlist and caps, and the planner must actually fill toward it.
 */
import { describe, expect, it } from "vitest";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs script, no type declarations
import { ACCOUNTS } from "@/scripts/seed-paper-portfolios.mjs";
import { BY_SCORE, PAPER_CORE_BOOK } from "@/lib/shared/paper-core-books";
import { PAPER_POLICY, TRADING_ACCOUNTS, type TradingAccount } from "@/lib/shared/paper-policy";
import { sectorFor } from "@/lib/shared/paper-sectors";
import {
  planChairConsensus,
  planRun,
  stopCooldownStart,
  type EngineCandidate,
  type EnginePosition,
} from "@/lib/shared/paper-engine-core";

const MIN_FLOOR = 15;
const watchlistOf = (account: TradingAccount): Set<string> =>
  new Set((ACCOUNTS as Record<string, { tickers: string[] }>)[account].tickers);

describe("PAPER_CORE_BOOK — invariants", () => {
  it.each(TRADING_ACCOUNTS)("%s: floor is at least 15 and fits under the cash floor", (account) => {
    const policy = PAPER_POLICY[account as TradingAccount];
    expect(policy.minHoldings).toBeGreaterThanOrEqual(MIN_FLOOR);
    expect(policy.coreWeight).toBeLessThanOrEqual(policy.maxPositionWeight);
    expect(policy.coreWeight).toBeGreaterThanOrEqual(policy.minPositionWeight);
    expect(policy.minHoldings * policy.coreWeight).toBeLessThanOrEqual(1 - policy.cashFloor + 1e-9);
  });

  const curated = TRADING_ACCOUNTS.filter((a) => PAPER_CORE_BOOK[a as TradingAccount] !== BY_SCORE) as TradingAccount[];

  it.each(curated)("%s: book has >= minHoldings unique names, all on its own watchlist", (account) => {
    const book = PAPER_CORE_BOOK[account] as readonly string[];
    expect(new Set(book).size).toBe(book.length);
    expect(book.length).toBeGreaterThanOrEqual(PAPER_POLICY[account].minHoldings);
    const watchlist = watchlistOf(account);
    expect(book.filter((t) => !watchlist.has(t))).toEqual([]);
  });

  it.each(curated)("%s: the full book at coreWeight never breaches a sector cap", (account) => {
    const { coreWeight, sectorCapPct } = PAPER_POLICY[account];
    const perSector = new Map<string, number>();
    for (const t of PAPER_CORE_BOOK[account] as readonly string[]) {
      const sector = sectorFor(t);
      expect(sector, `${t} has no sector`).not.toBeNull();
      perSector.set(sector!, (perSector.get(sector!) ?? 0) + coreWeight);
    }
    for (const [sector, weight] of perSector) {
      expect(weight, `${account} ${sector}`).toBeLessThanOrEqual(sectorCapPct + 1e-9);
    }
  });

  it("QUANT has no curated list — its floor ranks by numbers alone", () => {
    expect(PAPER_CORE_BOOK.quant).toBe(BY_SCORE);
  });

  it("CHAIR's book only holds names some sibling would hold", () => {
    const siblingNames = new Set<string>();
    for (const a of ["t1", "t2", "risk", "macro"] as const) {
      for (const t of PAPER_CORE_BOOK[a] as readonly string[]) siblingNames.add(t);
    }
    for (const t of (ACCOUNTS as Record<string, { tickers: string[] }>).quant.tickers) siblingNames.add(t);
    const orphans = (PAPER_CORE_BOOK.chair as readonly string[]).filter((t) => !siblingNames.has(t));
    expect(orphans).toEqual([]);
  });
});

/** A fresh $10k account with every name on its book neutral (score 0) and priced at $100. */
function freshAccount(account: TradingAccount, extraCandidates: EngineCandidate[] = []) {
  const watchlist = watchlistOf(account);
  const candidates: EngineCandidate[] = [
    ...[...watchlist].map((ticker) => ({ ticker, score: 0, dataQuality: 1 })),
    ...extraCandidates,
  ];
  const prices = Object.fromEntries([...watchlist].map((t) => [t, 100]));
  return { watchlist, candidates, prices };
}

describe("planRun — holdings floor", () => {
  it.each(["t1", "t2", "risk", "macro", "quant"] as TradingAccount[])(
    "%s: an empty account builds to minHoldings in one run, from its own book",
    (account) => {
      const policy = PAPER_POLICY[account];
      const { watchlist, candidates, prices } = freshAccount(account);
      const plan = planRun({
        policy,
        nav: 10_000,
        cash: 10_000,
        positions: [],
        candidates,
        activeWatchlist: watchlist,
        prices,
        tieBreakSeed: "2026-09-29",
        holdingsFloor: { coreBook: PAPER_CORE_BOOK[account] },
      });
      const fills = plan.orders.filter((o) => o.reason === "core_fill");
      expect(fills).toHaveLength(policy.minHoldings);
      const book = PAPER_CORE_BOOK[account];
      if (book !== BY_SCORE) expect(fills.every((o) => book.includes(o.ticker))).toBe(true);
      for (const o of fills) expect(o.quantity * o.refPrice).toBeCloseTo(policy.coreWeight * 10_000, 6);
    },
  );

  it("does nothing without holdingsFloor (v3 behaviour is opt-out safe)", () => {
    const { watchlist, candidates, prices } = freshAccount("risk");
    const plan = planRun({
      policy: PAPER_POLICY.risk,
      nav: 10_000,
      cash: 10_000,
      positions: [],
      candidates,
      activeWatchlist: watchlist,
      prices,
    });
    expect(plan.orders).toHaveLength(0);
  });

  it("never floor-fills a bearish card, and falls back to the rest of the watchlist", () => {
    const account: TradingAccount = "risk";
    const policy = PAPER_POLICY[account];
    const book = PAPER_CORE_BOOK[account] as readonly string[];
    const watchlist = watchlistOf(account);
    // Every book name bearish; the non-book watchlist neutral.
    const candidates: EngineCandidate[] = [...watchlist].map((ticker) => ({
      ticker,
      score: book.includes(ticker) ? -50 : 0,
    }));
    const prices = Object.fromEntries([...watchlist].map((t) => [t, 100]));
    const plan = planRun({
      policy,
      nav: 10_000,
      cash: 10_000,
      positions: [],
      candidates,
      activeWatchlist: watchlist,
      prices,
      holdingsFloor: { coreBook: book },
    });
    const fills = plan.orders.filter((o) => o.reason === "core_fill");
    expect(fills).toHaveLength(policy.minHoldings);
    expect(fills.some((o) => book.includes(o.ticker))).toBe(false);
  });

  it("only tops up the gap when the account already holds some names", () => {
    const account: TradingAccount = "t1";
    const policy = PAPER_POLICY[account];
    const { watchlist, candidates, prices } = freshAccount(account);
    const positions: EnginePosition[] = ["NVDA", "AMD", "PLTR"].map((ticker) => ({
      ticker,
      quantity: 4,
      avgCost: 100,
      runsHeld: 2,
      highWater: 100,
    }));
    const plan = planRun({
      policy,
      nav: 10_000,
      cash: 8_800,
      positions,
      candidates,
      activeWatchlist: watchlist,
      prices,
      holdingsFloor: { coreBook: PAPER_CORE_BOOK[account] },
    });
    const fills = plan.orders.filter((o) => o.reason === "core_fill");
    expect(fills).toHaveLength(policy.minHoldings - positions.length);
    expect(fills.map((o) => o.ticker)).not.toContain("NVDA");
  });

  it("is not gated by maxTurnoverPerRun, but still respects the cash floor", () => {
    const account: TradingAccount = "t2"; // 6% turnover cap, 20 x 4.5% floor
    const policy = { ...PAPER_POLICY[account], cashFloor: 0.5 };
    const { watchlist, candidates, prices } = freshAccount(account);
    const plan = planRun({
      policy,
      nav: 10_000,
      cash: 10_000,
      positions: [],
      candidates,
      activeWatchlist: watchlist,
      prices,
      holdingsFloor: { coreBook: PAPER_CORE_BOOK[account] },
    });
    const spent = plan.orders.reduce((s, o) => s + o.quantity * o.refPrice, 0);
    expect(spent).toBeGreaterThan(policy.maxTurnoverPerRun * 10_000);
    expect(spent).toBeLessThanOrEqual(5_000 + 1e-6);
  });
});

describe("planChairConsensus — holdings floor", () => {
  it("builds CHAIR to minHoldings from its seat-weighted book with no votes at all", () => {
    const policy = PAPER_POLICY.chair;
    const { watchlist, candidates, prices } = freshAccount("chair");
    const plan = planChairConsensus(policy, 10_000, 10_000, [], [], watchlist, prices, {
      coreBook: PAPER_CORE_BOOK.chair,
      candidates,
      tieBreakSeed: "2026-09-29",
    });
    const fills = plan.orders.filter((o) => o.reason === "core_fill");
    expect(fills).toHaveLength(policy.minHoldings);
    expect(fills.every((o) => (PAPER_CORE_BOOK.chair as readonly string[]).includes(o.ticker))).toBe(true);
  });
});

describe("holdings floor — stop cooldown", () => {
  it("never refills a name the account was stopped out of recently", () => {
    const account: TradingAccount = "risk";
    const { watchlist, candidates, prices } = freshAccount(account);
    const recentlyStopped = new Set(PAPER_CORE_BOOK.risk as readonly string[]);
    const plan = planRun({
      policy: PAPER_POLICY[account],
      nav: 10_000,
      cash: 10_000,
      positions: [],
      candidates,
      activeWatchlist: watchlist,
      prices,
      holdingsFloor: { coreBook: PAPER_CORE_BOOK[account], recentlyStopped },
    });
    const fills = plan.orders.filter((o) => o.reason === "core_fill");
    expect(fills).toHaveLength(PAPER_POLICY[account].minHoldings);
    expect(fills.some((o) => recentlyStopped.has(o.ticker))).toBe(false);
  });

  it("stopCooldownStart is STOP_COOLDOWN_DAYS calendar days back", () => {
    expect(stopCooldownStart("2026-09-29")).toBe("2026-09-22");
    expect(stopCooldownStart("2026-03-02")).toBe("2026-02-23");
  });
});
