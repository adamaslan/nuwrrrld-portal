/**
 * paper-sectors — ticker -> sector, for the paper-portfolio engine's sector-cap
 * enforcement (docs/council-paper-portfolios.md §3's `sectorCapPct`, CLIP step
 * §4.2.7).
 *
 * The design doc's §2.1 gives an exact, verbatim ticker list per account and,
 * for each account's 25 extras, only an aggregate "sector mix" count (e.g. "t1
 * extras: Technology 12, Financial Services 7, ..."), not a per-ticker sector.
 * This map is a best-effort GICS-style classification of every ticker that
 * appears anywhere in §2.1 — close to, but not a guaranteed exact match for,
 * those aggregate counts. It exists so the engine has *some* sector to cap
 * against; it is not a transcription of anything verbatim in the design doc,
 * unlike CORE_50 / EXTRAS in scripts/seed-paper-portfolios.mjs.
 *
 * ETFs (macro's rotation extras, plus `spy`'s IVV) get the pseudo-sector
 * `"ETF"` rather than an underlying-fund lookup — sector rotation is macro's
 * whole thesis, so those need their own cap bucket rather than being folded
 * into equity sectors they don't belong to.
 */

export type PaperSector =
  | "Technology"
  | "Financial Services"
  | "Healthcare"
  | "Consumer Cyclical"
  | "Industrials"
  | "Communication Services"
  | "Consumer Defensive"
  | "Energy"
  | "Utilities"
  | "Real Estate"
  | "Basic Materials"
  | "ETF";

/** The Core 50 (docs/council-paper-portfolios.md §2.1 table), verbatim. */
const CORE_50_SECTORS: Record<string, PaperSector> = {
  AAPL: "Technology", MSFT: "Technology", NVDA: "Technology", AVGO: "Technology",
  ORCL: "Technology", CRM: "Technology", ACN: "Technology",
  JPM: "Financial Services", BAC: "Financial Services", "BRK.B": "Financial Services",
  V: "Financial Services", MA: "Financial Services", GS: "Financial Services",
  JNJ: "Healthcare", LLY: "Healthcare", ABBV: "Healthcare", UNH: "Healthcare",
  TMO: "Healthcare", ABT: "Healthcare",
  AMZN: "Consumer Cyclical", TSLA: "Consumer Cyclical", HD: "Consumer Cyclical",
  MCD: "Consumer Cyclical", NKE: "Consumer Cyclical",
  CAT: "Industrials", HON: "Industrials", UNP: "Industrials", GE: "Industrials",
  RTX: "Industrials",
  GOOGL: "Communication Services", META: "Communication Services",
  NFLX: "Communication Services", DIS: "Communication Services", TMUS: "Communication Services",
  PG: "Consumer Defensive", KO: "Consumer Defensive", COST: "Consumer Defensive",
  WMT: "Consumer Defensive", PEP: "Consumer Defensive",
  XOM: "Energy", CVX: "Energy", COP: "Energy", SLB: "Energy",
  NEE: "Utilities", SO: "Utilities", DUK: "Utilities",
  PLD: "Real Estate", AMT: "Real Estate",
  LIN: "Basic Materials", SHW: "Basic Materials",
};

/** Best-effort classification of every per-account extra in §2.1 (see module
 *  doc above — not a verbatim transcription of the design doc). */
const EXTRA_SECTORS: Record<string, PaperSector> = {
  // t1 — tactical extras
  PLTR: "Technology", SMCI: "Technology", COIN: "Financial Services",
  HOOD: "Financial Services", MSTR: "Financial Services", AMD: "Technology",
  MU: "Technology", ARM: "Technology", CRWD: "Technology", NET: "Technology",
  SHOP: "Technology", RBLX: "Communication Services", DASH: "Consumer Cyclical",
  ABNB: "Consumer Cyclical", UBER: "Industrials", RIVN: "Consumer Cyclical",
  LCID: "Consumer Cyclical", MARA: "Financial Services", RIOT: "Financial Services",
  CLSK: "Financial Services", AFRM: "Financial Services", UPST: "Financial Services",
  SOUN: "Technology", IONQ: "Technology", APP: "Technology",
  // t2 — compounder extras
  ADBE: "Technology", ASML: "Technology", TSM: "Technology", TXN: "Technology",
  ADI: "Technology", ISRG: "Healthcare", SYK: "Healthcare", REGN: "Healthcare",
  VRTX: "Healthcare", DHR: "Healthcare", MCO: "Financial Services",
  SPGI: "Financial Services", ICE: "Financial Services", CME: "Financial Services",
  BLK: "Financial Services", AXP: "Financial Services", ADP: "Industrials",
  ROP: "Industrials", ITW: "Industrials", ETN: "Industrials", WM: "Industrials",
  RSG: "Industrials", EQIX: "Real Estate", O: "Real Estate", MDLZ: "Consumer Defensive",
  // risk — defensive extras
  MRK: "Healthcare", PFE: "Healthcare", BMY: "Healthcare", GIS: "Consumer Defensive",
  KMB: "Consumer Defensive", CL: "Consumer Defensive", CLX: "Consumer Defensive",
  MO: "Consumer Defensive", PM: "Consumer Defensive", KR: "Consumer Defensive",
  SYY: "Consumer Defensive", HRL: "Consumer Defensive", MKC: "Consumer Defensive",
  CHD: "Consumer Defensive", KDP: "Consumer Defensive", ED: "Utilities",
  XEL: "Utilities", WEC: "Utilities", AEP: "Utilities", D: "Utilities",
  VZ: "Communication Services", T: "Communication Services", BRO: "Financial Services",
  AJG: "Financial Services", CB: "Financial Services",
  // macro — rotation extras (ETFs, plus a few single names)
  XLE: "ETF", XLI: "ETF", XLU: "ETF", XLB: "ETF", XLC: "ETF", VGT: "ETF",
  VIS: "ETF", VOX: "ETF", KRE: "ETF", SMH: "ETF", QQQ: "ETF", IWM: "ETF",
  RSP: "ETF", DIA: "ETF", TLT: "ETF", GLD: "ETF", SLV: "ETF", URA: "ETF",
  EEM: "ETF", VGK: "ETF", FXI: "ETF", KWEB: "ETF",
  FCX: "Basic Materials", NUE: "Basic Materials", CCJ: "Energy",
  // quant — numeric-breadth extras
  NOW: "Technology", PANW: "Technology", FTNT: "Technology", KLAC: "Technology",
  LRCX: "Technology", AMAT: "Technology", QCOM: "Technology", INTU: "Technology",
  MDT: "Healthcare", CI: "Healthcare", ELV: "Healthcare", CVS: "Healthcare",
  MMM: "Industrials", DE: "Industrials", LMT: "Industrials", NOC: "Industrials",
  FDX: "Industrials", UPS: "Industrials", TGT: "Consumer Defensive", DG: "Consumer Defensive",
  EOG: "Energy", PSX: "Energy", MPC: "Energy", VST: "Utilities", CEG: "Utilities",
  // spy control
  IVV: "ETF",
  // chair's extras are a subset of the above five lists (§2.1) — no new tickers.
};

/** ticker -> sector for every symbol §2.1 seeds anywhere. */
export const PAPER_SECTORS: Record<string, PaperSector> = {
  ...CORE_50_SECTORS,
  ...EXTRA_SECTORS,
};

/** Sector for `ticker`, or `null` if it's outside the fixed §2.1 universe —
 *  which should never happen for a ticker that passed the watchlist join, but
 *  callers must not silently default a sector for cap-enforcement purposes. */
export function sectorFor(ticker: string): PaperSector | null {
  return PAPER_SECTORS[ticker] ?? null;
}

/**
 * True for the Core 50 and every ETF — the fill model's (§4.3) "mega/large
 * cap" bucket that gets 5bps slippage instead of 15. A stated simplification:
 * the Core 50 genuinely are large caps and liquid ETFs genuinely trade tight,
 * but several extras (e.g. `t2`'s ASML/TSM) are also large caps and get the
 * wider 15bps anyway rather than building out a real market-cap lookup for a
 * simulator running $200/position clips.
 */
export function isMegaOrLargeCap(ticker: string): boolean {
  return ticker in CORE_50_SECTORS || PAPER_SECTORS[ticker] === "ETF";
}
