/**
 * paper-core-books — each trading account's persona starter book (policy v4,
 * docs/paper-trading-v3.md §3.1, docs/council-paper-portfolios.md §2.2).
 *
 * On 2026-09-29 production held 0–4 names per account. A three-ticker book is
 * one bet, not a strategy: every account's P&L became a function of whichever
 * single name crossed its buy threshold, and that name was the same for all
 * six (UNH). v4 gives every account a holdings floor (`PaperPolicy.minHoldings`,
 * 15–20) and this module says *what* fills it — a list chosen from the
 * account's own watchlist to express its mandate, not a shared seed book.
 *
 * Rules every book obeys (enforced by __tests__/paper-core-books.test.ts):
 *   • ⊆ the account's own §2.1 watchlist — paper_orders' watchlist trigger
 *     would reject anything else;
 *   • at least `minHoldings` names;
 *   • `count(sector) * coreWeight <= sectorCapPct` for every sector, so the
 *     full book is buyable without a single CLIP;
 *   • `minHoldings * coreWeight <= 1 - cashFloor`.
 *
 * Order within a list is not a ranking — the planner orders floor fills by
 * card score, then the persona tie-break, then the date-seeded hash
 * (`fillHoldingsFloor` in paper-engine-core.ts). A book longer than
 * `minHoldings` gives the floor spares, so a stopped-out name does not have
 * to be the one that refills it.
 *
 * Pure and DB-free, same rationale as paper-policy.ts.
 */
import type { TradingAccount } from "./paper-policy";

/** QUANT has no curated list on purpose: its mandate is "numbers only", so a
 *  hand-picked book would be exactly the narrative it exists to exclude. Its
 *  floor fills from the whole watchlist, ranked by card score then
 *  data_quality — the same ordering QUANT uses for every other decision. */
export const BY_SCORE = "by-score" as const;

export type CoreBook = readonly string[] | typeof BY_SCORE;

export const PAPER_CORE_BOOK: Record<TradingAccount, CoreBook> = {
  // T1 "The Tactician" — high beta, catalyst-rich, where a 1–60 day card
  // actually moves. 6 Technology at 4% = 24%, under its 25% sector cap.
  t1: [
    "NVDA", "AMD", "PLTR", "CRWD", "NET", "MU", // Technology
    "COIN", "HOOD", "AFRM", // Financial Services (crypto / fintech beta)
    "TSLA", "DASH", "ABNB", // Consumer Cyclical
    "UBER", // Industrials
    "META", "NFLX", "RBLX", // Communication Services
  ],
  // T2 "The Compounder" — toll booths and wide moats with multi-year theses.
  // Fully invested (cash floor 0); nothing here is in the book for momentum.
  t2: [
    "MSFT", "ASML", "TSM", "TXN", // Technology
    "V", "MA", "SPGI", "MCO", "BRK.B", // Financial Services (networks, ratings)
    "LLY", "ISRG", "SYK", "TMO", // Healthcare
    "WM", "ROP", "ADP", "ETN", // Industrials
    "COST", "PG", // Consumer Defensive
    "EQIX", // Real Estate
  ],
  // RISK "The Survivor" — low realized vol, 3% each, at most 4 per sector
  // (12% vs its 15% cap) so no single sector can sink it and there is still
  // headroom for a score-driven buy in every sector it owns.
  risk: [
    "PG", "KO", "CL", "KMB", // Consumer Defensive
    "DUK", "SO", "ED", "AEP", // Utilities
    "JNJ", "MRK", "ABT", // Healthcare
    "BRK.B", "CB", "AJG", // Financial Services (insurers / brokers)
    "VZ", "TMUS", "T", // Communication Services (telecom)
    "MCD", // Consumer Cyclical (defensive franchise)
    "HON", "UNP", // Industrials
  ],
  // MACRO "The Rotator" — views expressed through sectors, rates, metals and
  // ex-US, plus one bellwether per cyclical sector. 8 ETFs at 4% = 32%,
  // under the 35% cap on the ETF bucket.
  macro: [
    "XLU", "XLE", "XLI", "SMH", // sector ETFs
    "TLT", // rates
    "GLD", // dollar / real rates
    "EEM", // ex-US
    "RSP", // breadth (equal-weight S&P)
    "XOM", "CCJ", // Energy (oil, uranium)
    "FCX", "NUE", // Basic Materials (copper, steel)
    "JPM", // Financials bellwether
    "CAT", // Industrials bellwether
    "NEE", // Utilities bellwether
  ],
  // QUANT "The Control Inside the Council" — see BY_SCORE above.
  quant: BY_SCORE,
  // CHAIR "The Consensus" — a seat-weighted sample: 3–4 names from each
  // sibling's starter book (QUANT's from its own numeric-breadth pool, since
  // it has no curated book), every one inside CHAIR's own watchlist.
  chair: [
    "NVDA", "PLTR", "META", // from T1
    "MSFT", "TSM", "SPGI", "ISRG", // from T2
    "JNJ", "PG", "DUK", "VZ", // from RISK
    "XOM", "JPM", "CAT", "NEE", // from MACRO
    "NOW", "LMT", "EOG", // from QUANT's pool
  ],
};

/** The book the floor fills from, for one trading account. */
export function coreBookFor(account: TradingAccount): CoreBook {
  return PAPER_CORE_BOOK[account];
}
