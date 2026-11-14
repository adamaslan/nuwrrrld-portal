/**
 * se1-dossier — pure logic over dossier rows (plan tracks B, C, D, F, G, J).
 * No I/O and no model calls (all C0). These functions take rows as input; until
 * the se1 results store exists (plan decision D1) nothing feeds them live data.
 */
import {
  FAMILIES, evidenceRank, isScanId, splitCitations, computeGaps,
  type EvidenceLevel, type FamilyCode, type ScanCard,
} from "./se1-catalog";
import { formatProvenance, type Provenance } from "./ai-features";

export interface ScanRow {
  scan_id: string;
  ticker: string;
  flag: boolean;
  evidence_level: EvidenceLevel;
  provenance: Partial<Provenance>;
  /** The scan's output values for this row (J2): what a narrated figure is checked against. */
  values?: Record<string, number | string | boolean>;
}

export interface MissingScan { scan_id: string; reason: string }

export interface Dossier {
  ticker: string;
  as_of: string;
  rows: ScanRow[];
  missing: MissingScan[];
}

/** B7: what changed between two dossiers of the same ticker. Order-independent. */
export interface DossierDiff {
  added: string[];
  removed: string[];
  /** Flag direction changed and the scan version did not: a market change, not a method change. */
  flipped: string[];
  unchanged: number;
  /** Same scan, different scan_version. Excluded from flipped. */
  versionChanged: string[];
  /** Same scan, different evidence_level. */
  evidenceChanged: string[];
  /** In curr.missing but not prev.missing. */
  newlyMissing: string[];
  /** In prev.missing but not curr.missing. */
  resolvedMissing: string[];
}

export type DossierDiffResult = ({ ok: true } & DossierDiff) | { ok: false; error: string };

export function diffDossiers(prev: Dossier, curr: Dossier): DossierDiffResult {
  if (prev.ticker !== curr.ticker) return { ok: false, error: `ticker mismatch: ${prev.ticker} vs ${curr.ticker}` };
  const dup = (rows: ScanRow[]) => {
    const seen = new Set<string>();
    for (const r of rows) { if (seen.has(r.scan_id)) return r.scan_id; seen.add(r.scan_id); }
    return null;
  };
  const dupId = dup(prev.rows) ?? dup(curr.rows);
  if (dupId) return { ok: false, error: `duplicate scan_id in dossier: ${dupId}` };
  const p = new Map(prev.rows.map((r) => [r.scan_id, r]));
  const c = new Map(curr.rows.map((r) => [r.scan_id, r]));
  const added = [...c.keys()].filter((id) => !p.has(id)).sort();
  const removed = [...p.keys()].filter((id) => !c.has(id)).sort();
  const versionChanged = [...c.keys()]
    .filter((id) => p.has(id) && p.get(id)!.provenance.scan_version != null && c.get(id)!.provenance.scan_version != null
      && p.get(id)!.provenance.scan_version !== c.get(id)!.provenance.scan_version)
    .sort();
  const evidenceChanged = [...c.keys()]
    .filter((id) => p.has(id) && p.get(id)!.evidence_level !== c.get(id)!.evidence_level)
    .sort();
  const flipped = [...c.keys()]
    .filter((id) => p.has(id) && p.get(id)!.flag !== c.get(id)!.flag && !versionChanged.includes(id))
    .sort();
  const unchanged = [...c.keys()].filter((id) => p.has(id) && p.get(id)!.flag === c.get(id)!.flag).length;
  const prevMissing = new Set(prev.missing.map((m) => m.scan_id));
  const currMissing = new Set(curr.missing.map((m) => m.scan_id));
  const newlyMissing = [...currMissing].filter((id) => !prevMissing.has(id)).sort();
  const resolvedMissing = [...prevMissing].filter((id) => !currMissing.has(id)).sort();
  return { ok: true, added, removed, flipped, unchanged, versionChanged, evidenceChanged, newlyMissing, resolvedMissing };
}

/** C4: the council's "missing evidence" section, straight from the dossier's `missing` list. */
export function missingEvidenceSection(d: Dossier): string[] {
  if (d.missing.length === 0 && d.rows.length === 0)
    return ["No scans were run for this dossier. There is no evidence to show."];
  if (d.missing.length === 0) return ["No scans are missing from this dossier."];
  return d.missing.map((m) => `Missing ${m.scan_id}: ${m.reason}`);
}

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

/** Strip line breaks and escape the markdown-significant characters in free text. */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[\\[\]()#*_<>|`]/g, (ch) => `\\${ch}`);
}

export type DossierMarkdownResult = { ok: true; markdown: string } | { ok: false; error: string };

/** B9: markdown export. A row without full provenance is listed as unsourced, never as a sourced claim.
 *  Invalid identifiers are rejected, never rendered: a hostile ticker, scan ID or date cannot inject markup. */
export function dossierToMarkdown(d: Dossier): DossierMarkdownResult {
  if (!TICKER_RE.test(d.ticker)) return { ok: false, error: "invalid ticker" };
  if (!d.as_of || !/^\d{4}-\d{2}-\d{2}([T ][0-9:.Zz+-]*)?$/.test(d.as_of) || Number.isNaN(Date.parse(d.as_of))) return { ok: false, error: "invalid as_of" };
  for (const r of d.rows) if (!isScanId(r.scan_id)) return { ok: false, error: `invalid scan_id: ${r.scan_id.slice(0, 40)}` };
  for (const m of d.missing) if (!isScanId(m.scan_id)) return { ok: false, error: `invalid scan_id: ${m.scan_id.slice(0, 40)}` };
  const lines = [`# ${d.ticker} dossier`, `As of ${escapeMarkdownText(d.as_of)}. Research context only, not advice.`, "", "## Findings"];
  if (d.rows.length === 0) lines.push("No scan rows.");
  for (const r of d.rows) {
    const prov = formatProvenance(r.provenance);
    lines.push(
      `- ${r.scan_id}: ${r.flag ? "flagged" : "not flagged"} [${r.evidence_level}]` +
        (prov ? ` (${escapeMarkdownText(prov)})` : " (unsourced: missing provenance)"),
    );
  }
  lines.push("", "## Missing evidence", ...missingEvidenceSection(d).map((l) => `- ${escapeMarkdownText(l)}`));
  return { ok: true, markdown: lines.join("\n") + "\n" };
}

export interface Contradiction { a: string; b: string }

export interface ContradictionReport {
  pairs: Contradiction[];
  /** Flagged rows at or above minLevel that could not raise an alert, with the reason. */
  disqualified: { scan_id: string; reason: "wrong_ticker" | "no_provenance" | "stale" | "retired_card" }[];
}

/** D6: two flagged rows, both at or above `minLevel`, where one card lists the other under `contradicts`.
 *  A row qualifies only when it belongs to this dossier's ticker, has full provenance, is dated within
 *  `maxAgeDays` of the dossier's as_of, and its card is not retired. `maxAgeDays` is required: there is
 *  no safe default for how old a contradiction may be. */
export function detectContradictions(
  d: Dossier,
  cards: readonly ScanCard[],
  maxAgeDays: number,
  minLevel: EvidenceLevel = "E3",
): ContradictionReport {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return { pairs: [], disqualified: [] };
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const dossierTime = Date.parse(d.as_of);
  const strong = new Set<string>();
  const disqualified: ContradictionReport["disqualified"] = [];
  for (const r of d.rows) {
    if (!r.flag || evidenceRank(r.evidence_level) < evidenceRank(minLevel)) continue;
    if (r.ticker !== d.ticker) { disqualified.push({ scan_id: r.scan_id, reason: "wrong_ticker" }); continue; }
    if (!formatProvenance(r.provenance)) { disqualified.push({ scan_id: r.scan_id, reason: "no_provenance" }); continue; }
    const rowTime = Date.parse(String(r.provenance.as_of));
    if (!Number.isFinite(dossierTime) || !Number.isFinite(rowTime)
        || Math.abs(dossierTime - rowTime) > maxAgeDays * 86_400_000) {
      disqualified.push({ scan_id: r.scan_id, reason: "stale" }); continue;
    }
    const card = cardById.get(r.scan_id);
    if (card && card.status === "retired") { disqualified.push({ scan_id: r.scan_id, reason: "retired_card" }); continue; }
    strong.add(r.scan_id);
  }
  const out = new Map<string, Contradiction>();
  for (const card of cards) {
    if (!strong.has(card.id)) continue;
    for (const other of card.contradicts) {
      if (!strong.has(other)) continue;
      const [a, b] = [card.id, other].sort();
      out.set(`${a}|${b}`, { a, b });
    }
  }
  return { pairs: [...out.values()], disqualified };
}

export interface AlertBudgetConfig {
  /** Hours 0-23 in the user's local time; the window may wrap midnight (e.g. 22 to 7). */
  quietStartHour: number;
  quietEndHour: number;
  maxPerTickerPerDay: number;
}

export type AlertDecision = { send: true } | { send: false; reason: "quiet_hours" | "ticker_budget" | "invalid_input" };

/** The local hour (0-23) for an instant in an IANA timezone, or null when the timezone is unknown. */
export function localHourFor(date: Date, timeZone: string): number | null {
  try {
    const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(date);
    const h = Number(hour);
    return Number.isInteger(h) && h >= 0 && h <= 24 ? h % 24 : null;
  } catch {
    return null;
  }
}

const isHour = (n: number) => Number.isInteger(n) && n >= 0 && n <= 23;
const isCount = (n: number) => Number.isInteger(n) && n >= 0;

function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** D9: quiet hours plus a per-ticker daily cap. `sentToday` counts alerts already sent for this ticker today.
 *  Bad input fails closed: an hour that is not an integer 0-23, a negative or fractional count, or a NaN
 *  anywhere returns invalid_input and never sends. The cap itself needs one conditional write per ticker
 *  per local day at integration time (D1/D2/D3); this pure function cannot enforce atomicity. */
export function decideAlert(localHour: number, sentToday: number, cfg: AlertBudgetConfig): AlertDecision {
  if (!isHour(localHour) || !isHour(cfg.quietStartHour) || !isHour(cfg.quietEndHour)
      || !isCount(sentToday) || !isCount(cfg.maxPerTickerPerDay)) {
    return { send: false, reason: "invalid_input" };
  }
  if (inQuietHours(localHour, cfg.quietStartHour, cfg.quietEndHour)) return { send: false, reason: "quiet_hours" };
  if (sentToday >= cfg.maxPerTickerPerDay) return { send: false, reason: "ticker_budget" };
  return { send: true };
}

export interface ConfidenceLabel { level: EvidenceLevel; text: string }

/**
 * F2: Hold/Fold confidence is the strongest evidence level among the scans that back the call,
 * never a made-up percentage. No backing scans means E0.
 */
export function holdFoldConfidence(backing: readonly Pick<ScanRow, "flag" | "evidence_level">[]): ConfidenceLabel {
  const flagged = backing.filter((r) => r.flag);
  if (flagged.length === 0) return { level: "E0", text: "No scan evidence backs this call." };
  const level = flagged.reduce<EvidenceLevel>(
    (best, r) => (evidenceRank(r.evidence_level) > evidenceRank(best) ? r.evidence_level : best), "E0");
  return { level, text: `Strongest backing scan is ${level}. ${flagged.length} scan(s) flagged.` };
}

export interface GraphEdge { from: string; to: string; kind: "composes" | "contradicts" }

/** G5: scan graph. Edges to unknown cards are dropped; a contradicts edge is stored once per pair. */
export function buildScanGraph(cards: readonly ScanCard[]): { nodes: string[]; edges: GraphEdge[] } {
  const ids = new Set(cards.map((c) => c.id));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const c of cards) {
    for (const [kind, list] of [["composes", c.composes_with], ["contradicts", c.contradicts]] as const) {
      for (const to of list) {
        if (!ids.has(to)) continue;
        const pair = kind === "contradicts" || to < c.id ? [c.id, to].sort() : [c.id, to];
        const key = `${kind}|${pair[0]}|${pair[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: pair[0], to: pair[1], kind });
      }
    }
  }
  return { nodes: [...ids].sort(), edges };
}

export interface FaithfulnessResult {
  /** Sentences that may be narrated: neutral prose, or claims whose figures and polarity check out. */
  grounded: string[];
  /** Sentences contradicted by the rows: unknown citation, unmatched figure, or negation-free cite of a non-flagged row. */
  ungrounded: { sentence: string; why: string }[];
  /** Sentences that make a figure claim but cite nothing a check could run against. */
  unverifiable: string[];
}

const NEGATION = /\b(not|no|never|nothing|without|avoid|avoids|failed|fails|didn\'t|did not|doesn\'t|does not|absent)\b/i;

/** Number words that act as figures in narration (small prose words like "one" are excluded on purpose). */
const UNIT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

const NUMBER_WORDS: Record<string, number> = {
  double: 2, doubled: 2, triple: 3, tripled: 3, quadruple: 4, quadrupled: 4,
  half: 0.5, halved: 0.5, quarter: 0.25,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000,
};

/** Split into sentences without breaking on U.S., e.g., i.e., vs., decimals (97.3) or tickers (BRK.B). */
export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(U\.S\.|e\.g\.|i\.e\.|vs\.)\s/g, (m) => m.replace(/\./g, "\u0000"))
    .replace(/(\d)\.(\d)/g, "$1\u0000$2")
    .replace(/\b([A-Z])\.([A-Z])\b/g, "$1\u0000$2");
  return protectedText
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter(Boolean);
}

/** Every figure a sentence states: digit tokens (with decimals, commas, %) and narration number words. */
export function extractFigures(sentence: string): { value: number; isPercent: boolean }[] {
  const out: { value: number; isPercent: boolean }[] = [];
  for (const m of sentence.matchAll(/(?<![\w.])-?(?:[\d,]+(?:\.\d+)?|\.\d+)\s*%?/g)) {
    const raw = m[0].trim();
    if (!/\d/.test(raw)) continue;
    const isPercent = raw.endsWith("%");
    const value = Number(raw.replace(/[%\s,]/g, ""));
    if (Number.isFinite(value)) out.push({ value, isPercent });
  }
  const lower = sentence.toLowerCase();
  const isPct = /%\b|\bpercent\b/.test(lower);
  // Compound phrases ("ninety-nine", "twenty five") are one figure; their words are consumed here.
  const compoundSpans: [number, number][] = [];
  for (const m of lower.matchAll(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[-\s](one|two|three|four|five|six|seven|eight|nine)\b/g)) {
    compoundSpans.push([m.index!, m.index! + m[0].length]);
    out.push({ value: NUMBER_WORDS[m[1]] + UNIT_WORDS[m[2]], isPercent: isPct });
  }
  for (const m of lower.matchAll(/\b(double|doubled|triple|tripled|quadruple|quadrupled|half|halved|quarter|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/g)) {
    if (compoundSpans.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    out.push({ value: NUMBER_WORDS[m[1]], isPercent: isPct });
  }
  return out;
}

const REL_TOL = 0.005; // stated rounding tolerance: figures match a row value within 0.5% relative

function figureMatches(figure: { value: number; isPercent: boolean }, values: (number | string | boolean)[]): boolean {
  const nums = values.map((v) => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN)).filter(Number.isFinite);
  const candidates = figure.isPercent ? [figure.value, figure.value / 100] : [figure.value];
  return candidates.some((c) => nums.some((v) => Math.abs(c - v) <= Math.max(1e-9, REL_TOL * Math.abs(v))));
}

/**
 * J2: a sentence may state a figure only when the figure equals a value on a scan row it cites
 * (within a stated 0.5% rounding tolerance, percent normalized). A sentence citing a non-flagged
 * row must say so (negation). A figure claim with no citation is unverifiable, not grounded.
 * Deterministic; it never calls a model. Narrated surfaces show only `grounded`.
 */
export function checkFaithfulness(
  narration: string,
  rows: readonly (Pick<ScanRow, "scan_id" | "flag"> & { values?: Record<string, number | string | boolean> })[],
): FaithfulnessResult {
  const byId = new Map(rows.map((r) => [r.scan_id, r]));
  const result: FaithfulnessResult = { grounded: [], ungrounded: [], unverifiable: [] };
  for (const sentence of splitSentences(narration)) {
    const cites = splitCitations(sentence).filter((p) => p.type === "scan").map((p) => (p as { id: string }).id);
    if (cites.some((id) => !byId.has(id))) {
      result.ungrounded.push({ sentence, why: "cites a scan with no row" });
      continue;
    }
    const figures = extractFigures(sentence);
    if (figures.length > 0 && cites.length === 0) {
      result.unverifiable.push(sentence);
      continue;
    }
    const citedRows = cites.map((id) => byId.get(id)!);
    if (figures.length > 0) {
      const values = citedRows.flatMap((r) => Object.values(r.values ?? {}));
      const bad = figures.find((f) => !figureMatches(f, values));
      if (bad) {
        result.ungrounded.push({ sentence, why: "figure not in cited row" });
        continue;
      }
    }
    // Polarity must agree per claim: only flag-specific negation ("did not flag", "unflagged")
    // licenses citing a non-flagged row; any other negated wording is ambiguous, not grounded.
    const flagNeg = /\b(?:not|no|never|didn't|didnt|without)\b[^.;]*?\bflag|\bunflagged\b/i.test(sentence);
    if (flagNeg && citedRows.some((r) => r.flag)) {
      result.ungrounded.push({ sentence, why: "negated flag claim contradicts a flagged row" });
      continue;
    }
    if (citedRows.some((r) => !r.flag)) {
      if (!flagNeg && NEGATION.test(sentence)) {
        result.unverifiable.push(sentence);
        continue;
      }
      if (!NEGATION.test(sentence)) {
        result.ungrounded.push({ sentence, why: "cites a non-flagged row without saying so" });
        continue;
      }
    }
    result.grounded.push(sentence);
  }
  return result;
}

function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = a.length;
  if (n < 5 || n !== b.length) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/** J5: pairs of scans whose output series correlate above `threshold` (plan §3.2: 0.9). Skips short or flat series. */
export function nearDuplicates(series: Record<string, readonly number[]>, threshold = 0.9): { a: string; b: string; r: number }[] {
  const ids = Object.keys(series).sort();
  const out: { a: string; b: string; r: number }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const r = pearson(series[ids[i]], series[ids[j]]);
      if (r !== null && r > threshold) out.push({ a: ids[i], b: ids[j], r: Math.round(r * 1000) / 1000 });
    }
  }
  return out;
}

export interface FamilyCoverage { family: FamilyCode; planned: number; written: number; blocked: boolean }

/** J9: weekly coverage report: cards written vs planned per family, and which families a missing feed blocks. */
export function coverageReport(cards: readonly ScanCard[]): { families: FamilyCoverage[]; written: number; planned: number; blocked: number } {
  const gaps = computeGaps(cards);
  const families = gaps.map((g) => ({
    family: g.family.code, planned: g.cardsPlanned, written: g.cardsWritten, blocked: g.missingFeeds.length > 0,
  }));
  return {
    families,
    written: families.reduce((n, f) => n + f.written, 0),
    planned: FAMILIES.reduce((n, f) => n + f.planned, 0),
    blocked: families.filter((f) => f.blocked).length,
  };
}
