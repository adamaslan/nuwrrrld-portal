/**
 * se1-catalog — pure, dependency-free types and data for the se1 scan encyclopedia
 * contract (docs/signals-app/se1-200-scan-plan-2026-10-30.md in homebase, §3-§5).
 *
 * Nothing here does I/O. The family table mirrors the plan's §3 allocation; the
 * seed cards are the scans the plan names explicitly, shipped as `spec`/E0 until
 * the evaluation harness (plan §5) writes real evidence. No hit rate, event
 * count or other measurement is ever filled in by hand.
 */

/** Evidence ladder, plan §5. A card's level only rises when the harness says so. */
export type EvidenceLevel = "E0" | "E1" | "E2" | "E3" | "E4";

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = ["E0", "E1", "E2", "E3", "E4"];

export interface EvidenceInfo {
  level: EvidenceLevel;
  label: string;
  /** What a surface may say about a finding at this level (plan §5). */
  mayClaim: string;
}

export const EVIDENCE_INFO: Record<EvidenceLevel, EvidenceInfo> = {
  E0: { level: "E0", label: "Spec only", mayClaim: "A planned scan would check this. No result is shown." },
  E1: { level: "E1", label: "Runs", mayClaim: "The scan flags this. No claim about edge." },
  E2: { level: "E2", label: "Verified output", mayClaim: "The scan flags this, and its output was checked by hand on 5+ tickers." },
  E3: { level: "E3", label: "Beats baseline", mayClaim: "Historically it beat a random-entry baseline (state the numbers, n and window)." },
  E4: { level: "E4", label: "Corrected edge", mayClaim: "It beat the baseline after multiple-testing correction on an untuned holdout." },
};

export type CardStatus = "spec" | "built" | "measured" | "retired";
export type CardRole = "screen" | "explain" | "confirm" | "risk" | "value" | "context";
export type FeedKey = "alpaca_bars" | "alpaca_news" | "corp_actions" | "edgar" | "fred" | "options_short_interest" | "calibration_store";

/** Feeds that exist today. Everything else is a gap (plan §3 "Feed needed"). */
export const BUILT_FEEDS: readonly FeedKey[] = ["alpaca_bars"];

export const FEED_LABEL: Record<FeedKey, string> = {
  alpaca_bars: "Alpaca daily bars",
  alpaca_news: "Alpaca news",
  corp_actions: "Alpaca corporate actions and earnings calendar",
  edgar: "SEC EDGAR filings and fundamentals",
  fred: "FRED macro series",
  options_short_interest: "Options chain and short interest",
  calibration_store: "Calibration store",
};

export type FamilyCode =
  | "trend" | "mom" | "vol" | "vola" | "lvl" | "xs" | "eng" | "regime"
  | "news" | "event" | "fund" | "valu" | "own" | "macro" | "risk" | "cmp";

export type Phase = "P0" | "P1" | "P2" | "P3" | "P4";

export interface FamilySpec {
  code: FamilyCode;
  name: string;
  /** Planned scan count from plan §3. */
  planned: number;
  feeds: readonly FeedKey[];
  phase: Phase;
}

/** Plan §3 allocation. Sums to 200. */
export const FAMILIES: readonly FamilySpec[] = [
  { code: "trend", name: "Trend and moving averages", planned: 18, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "mom", name: "Momentum and oscillators", planned: 18, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "vol", name: "Volume and flow", planned: 14, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "vola", name: "Volatility and squeeze", planned: 12, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "lvl", name: "Structure, levels, Fibonacci, Ichimoku", planned: 14, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "xs", name: "Cross-sectional and relative strength", planned: 14, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "eng", name: "Engine, calibration, and evidence", planned: 12, feeds: ["alpaca_bars", "calibration_store"], phase: "P0" },
  { code: "regime", name: "Regime and market context", planned: 10, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "news", name: "News, sentiment, and text", planned: 14, feeds: ["alpaca_news"], phase: "P2" },
  { code: "event", name: "Corporate actions and events", planned: 8, feeds: ["corp_actions"], phase: "P2" },
  { code: "fund", name: "Earnings and financial reports", planned: 22, feeds: ["edgar"], phase: "P3" },
  { code: "valu", name: "Valuation", planned: 14, feeds: ["edgar", "alpaca_bars"], phase: "P3" },
  { code: "own", name: "Ownership, short interest, options", planned: 10, feeds: ["edgar", "options_short_interest"], phase: "P4" },
  { code: "macro", name: "Macro and rates", planned: 6, feeds: ["fred"], phase: "P4" },
  { code: "risk", name: "Risk and portfolio fit", planned: 8, feeds: ["alpaca_bars"], phase: "P1" },
  { code: "cmp", name: "Decision composites", planned: 6, feeds: [], phase: "P3" },
];

export interface ScanCard {
  id: string;
  version: string;
  title: string;
  family: FamilyCode;
  role: CardRole;
  question: string;
  status: CardStatus;
  evidence_level: EvidenceLevel;
  source_ref: string;
  feed: FeedKey;
  min_bars?: number;
  /** Output field names with their types, e.g. { days_since_cross: "int" }. */
  output_fields: Record<string, string>;
  caveats: string[];
  composes_with: string[];
  contradicts: string[];
  /** One paragraph a person can read: what the scan does and how to read it. */
  prose: string;
}

/**
 * Seed cards: only scans the se1 plan names explicitly (the §4 example card and
 * the IDs it references). All are spec/E0 — nothing here has been run.
 */
export const SEED_CARDS: readonly ScanCard[] = [
  {
    id: "se1.trend.golden_cross_recency",
    version: "1.0.0",
    title: "Golden-cross recency with 200DMA slope",
    family: "trend",
    role: "screen",
    question: "Did this ticker's 50DMA cross above its 200DMA recently, and is the 200DMA rising?",
    status: "spec",
    evidence_level: "E0",
    source_ref: "scan-encyclopedia-2026-10.md §16 #2",
    feed: "alpaca_bars",
    min_bars: 210,
    output_fields: { days_since_cross: "int", ma200_slope_20d: "float", flag: "bool" },
    caveats: ["Whipsaw filter needs 10 bars, so crosses in the last 10 bars show as pending."],
    composes_with: ["se1.trend.ma_distance_atr", "se1.vol.breakout_volume_confirm"],
    contradicts: ["se1.trend.exit_close_under_200"],
    prose:
      "Counts the days since the 50-day average crossed above the 200-day average and measures how steeply the 200-day average has risen over the last 20 days. A recent cross with a rising 200-day line is the flag. Read it as a candidate for review, not a signal to act on.",
  },
  {
    id: "se1.trend.ma_distance_atr",
    version: "1.0.0",
    title: "Distance from the moving average in ATR units",
    family: "trend",
    role: "context",
    question: "How far is price from its moving average, measured in average true ranges?",
    status: "spec",
    evidence_level: "E0",
    source_ref: "named as composes_with in se1 plan §4",
    feed: "alpaca_bars",
    output_fields: {},
    caveats: ["Spec only. Output fields and parameters are not defined yet."],
    composes_with: ["se1.trend.golden_cross_recency"],
    contradicts: [],
    prose: "A planned scan that puts a ticker's stretch from its moving average on a volatility-adjusted scale, so a 5% gap means something different for a calm stock and a wild one.",
  },
  {
    id: "se1.vol.breakout_volume_confirm",
    version: "1.0.0",
    title: "Breakout volume confirmation",
    family: "vol",
    role: "confirm",
    question: "Did a recent breakout come with unusually heavy volume?",
    status: "spec",
    evidence_level: "E0",
    source_ref: "named as composes_with in se1 plan §4",
    feed: "alpaca_bars",
    output_fields: {},
    caveats: ["Spec only. Volume signals must record which Alpaca feed (iex or sip) supplied the bars."],
    composes_with: ["se1.trend.golden_cross_recency"],
    contradicts: [],
    prose: "A planned scan that checks whether a breakout was backed by volume well above the ticker's normal level. It confirms or weakens a trend flag; it does not create one.",
  },
  {
    id: "se1.trend.exit_close_under_200",
    version: "1.0.0",
    title: "Close under the 200-day average",
    family: "trend",
    role: "risk",
    question: "Has the ticker closed below its 200-day average, breaking the long-term trend?",
    status: "spec",
    evidence_level: "E0",
    source_ref: "named as contradicts in se1 plan §4",
    feed: "alpaca_bars",
    output_fields: {},
    caveats: ["Spec only. Close-based trigger, so an intraday dip under the line does not count."],
    composes_with: [],
    contradicts: ["se1.trend.golden_cross_recency"],
    prose: "A planned exit-side scan. When it fires on a ticker that a golden-cross flag also marks, the two disagree, and a surface should show that disagreement instead of picking a side.",
  },
];

/** `se1.<family>.<name>`; family is one of the known codes. Matches IDs inside prose. */
const SCAN_ID_SOURCE = "se1\\.(?:trend|mom|vol|vola|lvl|xs|eng|regime|news|event|fund|valu|own|macro|risk|cmp)\\.[a-z0-9_]+";

export function isScanId(value: string): boolean {
  return new RegExp(`^${SCAN_ID_SOURCE}$`).test(value);
}

export type TextPart = { type: "text"; text: string } | { type: "scan"; id: string };

/** Split text into plain runs and scan-ID citations (A3: tap a citation to open its card). */
export function splitCitations(text: string): TextPart[] {
  const re = new RegExp(SCAN_ID_SOURCE, "g");
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ type: "text", text: text.slice(last, start) });
    parts.push({ type: "scan", id: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ type: "text", text: text.slice(last) });
  return parts;
}

export function findCard(cards: readonly ScanCard[], id: string): ScanCard | undefined {
  return cards.find((c) => c.id === id);
}

export interface CardFilter {
  family?: FamilyCode;
  role?: CardRole;
  /** Show only cards at this evidence level or higher (A7). */
  minEvidence?: EvidenceLevel;
  query?: string;
}

export function evidenceRank(level: EvidenceLevel): number {
  return EVIDENCE_LEVELS.indexOf(level);
}

export function filterCards(cards: readonly ScanCard[], f: CardFilter): ScanCard[] {
  const q = f.query?.trim().toLowerCase();
  return cards.filter((c) => {
    if (f.family && c.family !== f.family) return false;
    if (f.role && c.role !== f.role) return false;
    if (f.minEvidence && evidenceRank(c.evidence_level) < evidenceRank(f.minEvidence)) return false;
    if (q && !`${c.id} ${c.title} ${c.question}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

export interface Gap {
  family: FamilySpec;
  /** Feeds this family needs that are not built. Empty means bars-only and unblocked. */
  missingFeeds: FeedKey[];
  /** Planned scans minus seed cards written so far. */
  cardsWritten: number;
  cardsPlanned: number;
}

/**
 * G6: what we can't answer yet, and why. A family is blocked when any feed it
 * needs is not built. Families that need only built feeds report no missing feeds
 * but still show how many cards remain unwritten.
 */
export function computeGaps(
  cards: readonly ScanCard[] = SEED_CARDS,
  builtFeeds: readonly FeedKey[] = BUILT_FEEDS,
): Gap[] {
  return FAMILIES.map((family) => ({
    family,
    missingFeeds: family.feeds.filter((f) => !builtFeeds.includes(f)),
    cardsWritten: cards.filter((c) => c.family === family.code).length,
    cardsPlanned: family.planned,
  }));
}

/**
 * Provenance for a card's own page. A card that has never been run has no as-of
 * date, so `as_of` stays empty and the footer fails closed (review finding F1).
 */
export function cardProvenance(card: ScanCard): { source: string; feed: string; as_of: string; scan_version: string } {
  const runAt = card.status === "measured" || card.status === "built" ? "run" : "";
  return { source: card.source_ref, feed: FEED_LABEL[card.feed], as_of: runAt, scan_version: card.version };
}

export function totalPlanned(): number {
  return FAMILIES.reduce((n, f) => n + f.planned, 0);
}
