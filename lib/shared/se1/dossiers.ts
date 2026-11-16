/**
 * se1/dossiers — track B (deep dives and dossiers). Pure logic over fixtures; no I/O, no model call.
 * B7 (diffDossiers) and B9 (dossierToMarkdown) live in ../se1-dossier.ts.
 */
import { diffDossiers, type Dossier, type DossierDiff } from "../se1-dossier";
import { canonicalJson, fnv1a, parseIso, round } from "./util";

// ── B1 ────────────────────────────────────────────────────────────────────────

export interface RecipeSection { name: string; scans: readonly string[] }
export type SectionStatus = "complete" | "partial" | "unavailable";
export interface DeepDiveSection {
  name: string;
  status: SectionStatus;
  present: string[];
  /** Scans this section needs that the dossier lacks, with the reason. */
  absent: { scan_id: string; reason: string }[];
}

/** B1: per-section coverage. Overall coverage is "full" only when every section is complete. */
export function deepDiveSections(d: Dossier, recipe: readonly RecipeSection[]):
  { sections: DeepDiveSection[]; coverage: "full" | "partial" | "none" } {
  const rowIds = new Set(d.rows.filter((r) => r.ticker === d.ticker).map((r) => r.scan_id));
  const missingReason = new Map(d.missing.map((m) => [m.scan_id, m.reason]));
  const sections = recipe.map((s): DeepDiveSection => {
    const present = s.scans.filter((id) => rowIds.has(id));
    const absent = s.scans.filter((id) => !rowIds.has(id))
      .map((id) => ({ scan_id: id, reason: missingReason.get(id) ?? "not run" }));
    const status: SectionStatus = s.scans.length === 0 || present.length === 0 ? "unavailable"
      : absent.length === 0 ? "complete" : "partial";
    return { name: s.name, status, present, absent };
  });
  const coverage = sections.length > 0 && sections.every((s) => s.status === "complete") ? "full"
    : sections.some((s) => s.status !== "unavailable") ? "partial" : "none";
  return { sections, coverage };
}

// ── B2 ────────────────────────────────────────────────────────────────────────

export interface Bar { date: string; close: number }
export type MomentumDossier =
  | { status: "missing"; reason: string }
  | {
      status: "ok";
      as_of: string;
      bars_used: number;
      findings: { pct_above_sma200: number; sma50_above_sma200: boolean; return_20d_pct: number };
    };

const MOMENTUM_MIN_BARS = 200;

function sma(closes: readonly number[], n: number): number {
  const tail = closes.slice(-n);
  return tail.reduce((s, x) => s + x, 0) / n;
}

/** B2: momentum-entry findings from daily closes. Short or malformed history is missing, never a guess.
 *  The same bars always return the same findings (rounded to 4 places). */
export function momentumEntryDossier(bars: readonly Bar[], minBars = MOMENTUM_MIN_BARS): MomentumDossier {
  const need = Math.max(MOMENTUM_MIN_BARS, Math.floor(minBars));
  if (bars.length < need) return { status: "missing", reason: `needs ${need} daily bars, has ${bars.length}` };
  let prev = -Infinity;
  for (const b of bars) {
    const t = parseIso(b.date);
    if (t === null) return { status: "missing", reason: `invalid bar date ${JSON.stringify(b.date)}` };
    if (t <= prev) return { status: "missing", reason: "bars are not in strictly ascending date order" };
    if (!Number.isFinite(b.close) || b.close <= 0) return { status: "missing", reason: `invalid close on ${b.date}` };
    prev = t;
  }
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const s200 = sma(closes, 200);
  const s50 = sma(closes, 50);
  const close20 = closes[closes.length - 21];
  return {
    status: "ok",
    as_of: bars[bars.length - 1].date,
    bars_used: bars.length,
    findings: {
      pct_above_sma200: round(((last - s200) / s200) * 100),
      sma50_above_sma200: s50 > s200,
      return_20d_pct: round(((last - close20) / close20) * 100),
    },
  };
}

// ── B3 ────────────────────────────────────────────────────────────────────────

export interface EarningsEvent { ticker: string; date: string; status: "scheduled" | "cancelled" }

/** B3: a pre-earnings dossier is valid only for the event date it was built for. */
export function preEarningsValidity(builtFor: { ticker: string; event_date: string }, event: EarningsEvent | null):
  { valid: true } | { valid: false; reason: string } {
  if (!event || event.ticker !== builtFor.ticker) return { valid: false, reason: "no current earnings event for this ticker" };
  if (event.status === "cancelled") return { valid: false, reason: "earnings event cancelled" };
  if (parseIso(event.date) === null) return { valid: false, reason: "earnings date is not a valid date" };
  if (event.date !== builtFor.event_date) return { valid: false, reason: `earnings moved from ${builtFor.event_date} to ${event.date}` };
  return { valid: true };
}

// ── B4 ────────────────────────────────────────────────────────────────────────

export type DipVerdict =
  | { verdict: "inconclusive"; reason: string; missing: string[] }
  | { verdict: "review_candidate" | "no_dip_signal"; flagged: number; total: number };

/** B4: price signals alone never produce a dip conclusion. Every required fundamental must be present. */
export function dipCheckVerdict(
  priceSignals: readonly { flag: boolean }[],
  fundamentals: Readonly<Record<string, number | null | undefined>> | null,
  required: readonly string[],
): DipVerdict {
  const missing = required.filter((k) => !fundamentals || typeof fundamentals[k] !== "number" || !Number.isFinite(fundamentals[k] as number));
  if (!fundamentals || missing.length > 0) return { verdict: "inconclusive", reason: "fundamentals unavailable", missing: fundamentals ? missing : [...required] };
  if (priceSignals.length === 0) return { verdict: "inconclusive", reason: "no price signals", missing: [] };
  const flagged = priceSignals.filter((s) => s.flag).length;
  return { verdict: flagged * 2 > priceSignals.length ? "review_candidate" : "no_dip_signal", flagged, total: priceSignals.length };
}

// ── B5 ────────────────────────────────────────────────────────────────────────

export interface FrozenSnapshot { id: string; hash: string; dossier: Dossier }

export function snapshotHash(d: Dossier): string {
  return fnv1a(canonicalJson(d));
}

/** Freeze a dossier as a thesis snapshot. */
export function freezeSnapshot(id: string, d: Dossier): FrozenSnapshot {
  const copy = JSON.parse(JSON.stringify(d)) as Dossier;
  return Object.freeze({ id, hash: snapshotHash(copy), dossier: copy });
}

/** B5: compare a holding to its frozen thesis snapshot. A missing id or an altered snapshot is an error. */
export function thesisBreak(snapshot: FrozenSnapshot, current: Dossier):
  { ok: false; error: string } | ({ ok: true; changed: boolean; snapshot_id: string } & DossierDiff) {
  if (!snapshot.id) return { ok: false, error: "snapshot has no id" };
  if (snapshotHash(snapshot.dossier) !== snapshot.hash) return { ok: false, error: "snapshot content does not match its hash" };
  const diff = diffDossiers(snapshot.dossier, current);
  if (!diff.ok) return diff;
  const { ok: _ok, ...rest } = diff;
  void _ok;
  const changed = rest.flipped.length + rest.added.length + rest.removed.length + rest.newlyMissing.length
    + rest.versionChanged.length + rest.evidenceChanged.length > 0;
  return { ok: true, changed, snapshot_id: snapshot.id, ...rest };
}

// ── B6 ────────────────────────────────────────────────────────────────────────

export type RatioResult =
  | { available: true; value: number }
  | { available: false; reason: "missing" | "non_finite" | "zero_denominator" | "negative_denominator" };

/** B6: a ratio, or the reason it cannot be computed. Never divides into a misleading number. */
export function safeRatio(numerator: number | null | undefined, denominator: number | null | undefined): RatioResult {
  if (numerator == null || denominator == null) return { available: false, reason: "missing" };
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return { available: false, reason: "non_finite" };
  if (denominator === 0) return { available: false, reason: "zero_denominator" };
  if (denominator < 0) return { available: false, reason: "negative_denominator" };
  return { available: true, value: numerator / denominator };
}

/** B6: the ratios that can be computed, the ones that cannot, and how many of each. No blended score. */
export function qualityValueRatios(inputs: Readonly<Record<string, { num: number | null; den: number | null }>>) {
  const available: Record<string, number> = {};
  const unavailable: { name: string; reason: string }[] = [];
  for (const name of Object.keys(inputs).sort()) {
    const r = safeRatio(inputs[name].num, inputs[name].den);
    if (r.available) available[name] = round(r.value);
    else unavailable.push({ name, reason: r.reason });
  }
  const total = Object.keys(inputs).length;
  return { available, unavailable, coverage: `${Object.keys(available).length} of ${total} ratios available` };
}

// ── B8 ────────────────────────────────────────────────────────────────────────

export interface ShareLink { id: string; ticker: string; revoked: boolean; expires_at: string | null }
export interface PublicDossierView {
  ticker: string;
  as_of: string;
  findings: { scan_id: string; flag: boolean; evidence_level: string }[];
  missing_count: number;
}

/** B8: the only fields a public link or OG image may show. Unknown, revoked, expired or mismatched links show nothing. */
export function publicDossierView(d: Dossier, link: ShareLink | undefined, now: Date): PublicDossierView | null {
  if (!link || link.revoked || link.ticker !== d.ticker) return null;
  if (link.expires_at !== null) {
    const exp = parseIso(link.expires_at);
    if (exp === null || exp <= now.getTime()) return null;
  }
  return {
    ticker: d.ticker,
    as_of: d.as_of,
    findings: d.rows.filter((r) => r.ticker === d.ticker)
      .map((r) => ({ scan_id: r.scan_id, flag: r.flag, evidence_level: r.evidence_level })),
    missing_count: d.missing.length,
  };
}
