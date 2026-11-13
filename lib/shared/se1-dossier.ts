/**
 * se1-dossier — pure logic over dossier rows (plan tracks B, C, D, F, G, J).
 * No I/O and no model calls (all C0). These functions take rows as input; until
 * the se1 results store exists (plan decision D1) nothing feeds them live data.
 */
import {
  FAMILIES, evidenceRank, splitCitations, computeGaps,
  type EvidenceLevel, type FamilyCode, type ScanCard,
} from "./se1-catalog";
import { formatProvenance, type Provenance } from "./ai-features";

export interface ScanRow {
  scan_id: string;
  ticker: string;
  flag: boolean;
  evidence_level: EvidenceLevel;
  provenance: Partial<Provenance>;
}

export interface MissingScan { scan_id: string; reason: string }

export interface Dossier {
  ticker: string;
  as_of: string;
  rows: ScanRow[];
  missing: MissingScan[];
}

/** B7: what changed between two dossiers of the same ticker. Order-independent. */
export interface DossierDiff { added: string[]; removed: string[]; flipped: string[]; unchanged: number }

export function diffDossiers(prev: Dossier, curr: Dossier): DossierDiff {
  const p = new Map(prev.rows.map((r) => [r.scan_id, r.flag]));
  const c = new Map(curr.rows.map((r) => [r.scan_id, r.flag]));
  const added = [...c.keys()].filter((id) => !p.has(id)).sort();
  const removed = [...p.keys()].filter((id) => !c.has(id)).sort();
  const flipped = [...c.keys()].filter((id) => p.has(id) && p.get(id) !== c.get(id)).sort();
  const unchanged = [...c.keys()].filter((id) => p.has(id) && p.get(id) === c.get(id)).length;
  return { added, removed, flipped, unchanged };
}

/** C4: the council's "missing evidence" section, straight from the dossier's `missing` list. */
export function missingEvidenceSection(d: Dossier): string[] {
  if (d.missing.length === 0) return ["No scans are missing from this dossier."];
  return d.missing.map((m) => `Missing ${m.scan_id}: ${m.reason}`);
}

/** B9: markdown export. A row without full provenance is listed as unsourced, never as a sourced claim. */
export function dossierToMarkdown(d: Dossier): string {
  const lines = [`# ${d.ticker} dossier`, `As of ${d.as_of}. Research context only, not advice.`, "", "## Findings"];
  if (d.rows.length === 0) lines.push("No scan rows.");
  for (const r of d.rows) {
    const prov = formatProvenance(r.provenance);
    lines.push(
      `- ${r.scan_id}: ${r.flag ? "flagged" : "not flagged"} [${r.evidence_level}]` +
        (prov ? ` (${prov})` : " (unsourced: missing provenance)"),
    );
  }
  lines.push("", "## Missing evidence", ...missingEvidenceSection(d).map((l) => `- ${l}`));
  return lines.join("\n") + "\n";
}

export interface Contradiction { a: string; b: string }

/** D6: two flagged rows, both at or above `minLevel`, where one card lists the other under `contradicts`. */
export function detectContradictions(d: Dossier, cards: readonly ScanCard[], minLevel: EvidenceLevel = "E3"): Contradiction[] {
  const strong = new Set(
    d.rows.filter((r) => r.flag && evidenceRank(r.evidence_level) >= evidenceRank(minLevel)).map((r) => r.scan_id),
  );
  const out = new Map<string, Contradiction>();
  for (const card of cards) {
    if (!strong.has(card.id)) continue;
    for (const other of card.contradicts) {
      if (!strong.has(other)) continue;
      const [a, b] = [card.id, other].sort();
      out.set(`${a}|${b}`, { a, b });
    }
  }
  return [...out.values()];
}

export interface AlertBudgetConfig {
  /** Hours 0-23 in the user's local time; the window may wrap midnight (e.g. 22 to 7). */
  quietStartHour: number;
  quietEndHour: number;
  maxPerTickerPerDay: number;
}

export type AlertDecision = { send: true } | { send: false; reason: "quiet_hours" | "ticker_budget" };

function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** D9: quiet hours plus a per-ticker daily cap. `sentToday` counts alerts already sent for this ticker today. */
export function decideAlert(localHour: number, sentToday: number, cfg: AlertBudgetConfig): AlertDecision {
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

const NUMERIC = /\d/;

export interface FaithfulnessResult { grounded: string[]; ungrounded: { sentence: string; why: string }[] }

/**
 * J2: every sentence that states a number, or cites a scan, must cite a scan present in the rows.
 * A deterministic check; it never calls a model. Sentences with no figures and no citation are neutral.
 */
export function checkFaithfulness(narration: string, rows: readonly Pick<ScanRow, "scan_id">[]): FaithfulnessResult {
  const have = new Set(rows.map((r) => r.scan_id));
  const sentences = narration.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const result: FaithfulnessResult = { grounded: [], ungrounded: [] };
  for (const sentence of sentences) {
    const cites = splitCitations(sentence).filter((p) => p.type === "scan").map((p) => (p as { id: string }).id);
    if (cites.some((id) => !have.has(id))) result.ungrounded.push({ sentence, why: "cites a scan with no row" });
    else if (NUMERIC.test(sentence) && cites.length === 0) result.ungrounded.push({ sentence, why: "states a figure without a scan citation" });
    else result.grounded.push(sentence);
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
