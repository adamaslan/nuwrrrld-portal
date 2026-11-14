/**
 * se1/explain — track G (explainability) items not yet live: G3, G4, G8. Pure logic; no I/O, no model call.
 */
import { isScanId, type ScanCard } from "../se1-catalog";
import { extractFigures, type ScanRow } from "../se1-dossier";
import { parseIso } from "./util";

// ── G3 ────────────────────────────────────────────────────────────────────────

export interface HowWeKnow {
  scan_id: string;
  source: string;
  feed: string;
  as_of: string;
  scan_version: string;
  evidence_level: string;
}

const UNAVAILABLE = "unavailable";

/** G3: the drawer's fields, each a value or "unavailable". The result has these six fields and nothing else,
 *  so row values and anything private never reach the drawer. */
export function howWeKnow(row: ScanRow): HowWeKnow {
  const p = row.provenance ?? {};
  const field = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : UNAVAILABLE);
  return {
    scan_id: row.scan_id,
    source: field(p.source),
    feed: field(p.feed),
    as_of: parseIso(p.as_of) === null ? UNAVAILABLE : String(p.as_of),
    scan_version: field(p.scan_version),
    evidence_level: field(row.evidence_level),
  };
}

// ── G4 ────────────────────────────────────────────────────────────────────────

/** Wilson score interval for a binomial rate, z = 1.96 (95%). */
export function wilsonInterval(hits: number, n: number, z = 1.96): [number, number] {
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** G4: chart data only with enough samples and a baseline; always with n and an interval. */
export function hitRateChartData(hits: number, n: number, baseline: number | null, minN = 30):
  { available: true; rate: number; n: number; interval: [number, number]; baseline: number }
  | { available: false; reason: string } {
  if (!Number.isInteger(n) || !Number.isInteger(hits) || hits < 0 || hits > n) return { available: false, reason: "invalid counts" };
  if (n < minN) return { available: false, reason: `only ${n} samples, needs ${minN}` };
  if (baseline === null || !Number.isFinite(baseline) || baseline < 0 || baseline > 1) return { available: false, reason: "no baseline" };
  return { available: true, rate: hits / n, n, interval: wilsonInterval(hits, n), baseline };
}

// ── G8 ────────────────────────────────────────────────────────────────────────

export interface GlossaryEntry { card_id: string; card_version: string; text: string }

/** G8: a generated glossary entry may not add figures or scan IDs the card does not contain, and is versioned with it. */
export function glossaryEntryCheck(entry: GlossaryEntry, card: ScanCard, maxChars = 400): { ok: true; key: string } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (entry.card_id !== card.id || entry.card_version !== card.version) errors.push("entry does not match the card id and version");
  if (entry.text.length === 0 || entry.text.length > maxChars) errors.push(`text must be 1 to ${maxChars} characters`);
  const cardText = [card.title, card.question, card.prose, ...card.caveats].join(" ");
  const cardFigures = new Set(extractFigures(cardText).map((f) => f.value));
  for (const f of extractFigures(entry.text)) {
    if (!cardFigures.has(f.value)) errors.push(`figure ${f.value} is not on the card`);
  }
  for (const word of entry.text.split(/[^A-Za-z0-9_.]+/)) {
    const id = word.replace(/\.$/, "");
    if (isScanId(id) && id !== card.id && !card.composes_with.includes(id) && !card.contradicts.includes(id)) {
      errors.push(`scan ID ${id} is not referenced by the card`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, key: `${card.id}@${card.version}` };
}
