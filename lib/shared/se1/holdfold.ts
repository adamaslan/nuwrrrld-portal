/**
 * se1/holdfold — track F (Hold/Fold and paper trading). Pure logic over fixtures; no I/O.
 * Nothing in this module can place an order: it imports no broker client and no route (tested).
 * F1 is in PR #352.
 */
import { EVIDENCE_LEVELS, evidenceRank, type EvidenceLevel } from "../se1-catalog";
import type { Dossier, ScanRow } from "../se1-dossier";
import { DAY_MS, isTicker, parseIso } from "./util";

// ── F2 (audit R7) ─────────────────────────────────────────────────────────────

export type HoldFoldEvidence =
  | { ok: true; level: EvidenceLevel; counts: Record<EvidenceLevel, number>; flagged: number; mixed: boolean; text: string }
  | { ok: false; error: string };

/** F2: the evidence level of a call is the highest level that at least half the flagged backing rows reach.
 *  One strong scan cannot lift nine weak ones. An unknown level is an error. Never a percentage. */
export function holdFoldEvidence(backing: readonly Pick<ScanRow, "flag" | "evidence_level">[]): HoldFoldEvidence {
  const unknown = backing.find((r) => !(EVIDENCE_LEVELS as readonly string[]).includes(r.evidence_level));
  if (unknown) return { ok: false, error: `unknown evidence level ${JSON.stringify(unknown.evidence_level)}` };
  const counts = Object.fromEntries(EVIDENCE_LEVELS.map((l) => [l, 0])) as Record<EvidenceLevel, number>;
  const flagged = backing.filter((r) => r.flag);
  for (const r of flagged) counts[r.evidence_level]++;
  if (flagged.length === 0) return { ok: true, level: "E0", counts, flagged: 0, mixed: false, text: "No scan evidence backs this call." };
  let level: EvidenceLevel = "E0";
  for (const l of EVIDENCE_LEVELS) {
    const atOrAbove = flagged.filter((r) => evidenceRank(r.evidence_level) >= evidenceRank(l)).length;
    if (atOrAbove * 2 >= flagged.length) level = l;
  }
  const present = EVIDENCE_LEVELS.filter((l) => counts[l] > 0);
  const mixed = evidenceRank(present[present.length - 1]) - evidenceRank(present[0]) >= 2;
  const n = flagged.length;
  const text = mixed
    ? `Evidence is mixed: ${[...present].reverse().map((l, i) => `${counts[l]}${i === 0 ? ` of ${n} backing scans` : ""} ${counts[l] === 1 ? "is" : "are"} ${l}`).join(", ")}.`
    : `Evidence level ${level}: ${n} backing scan${n === 1 ? "" : "s"}.`;
  return { ok: true, level, counts, flagged: n, mixed, text };
}

// ── F3 ────────────────────────────────────────────────────────────────────────

export interface PaperEntry { id: string; ticker: string; opened_at: string }
export type TaggedPaperEntry = Readonly<PaperEntry & { recipe_id: string; recipe_version: string; input_hash: string }>;

/** F3: tag a paper entry with the recipe identity that suggested it. The tag is a frozen copy. */
export function tagPaperEntry(entry: PaperEntry, recipe: { id: string; version: string }, inputHash: string): TaggedPaperEntry {
  if (!recipe.id || !recipe.version || !inputHash) throw new TypeError("tagPaperEntry: recipe id, version and input hash are required");
  return Object.freeze({ ...entry, recipe_id: String(recipe.id), recipe_version: String(recipe.version), input_hash: String(inputHash) });
}

// ── F4 ────────────────────────────────────────────────────────────────────────

function isScanRow(x: unknown): x is ScanRow {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.scan_id === "string" && isTicker(r.ticker) && typeof r.flag === "boolean"
    && (EVIDENCE_LEVELS as readonly unknown[]).includes(r.evidence_level) && !!r.provenance && typeof r.provenance === "object";
}

/** F4: arbitration reads only well-formed rows. Anything malformed or empty makes it abstain. */
export function arbitrationInputs(rows: unknown): { rows: ScanRow[] } | { abstain: true; reason: string } {
  if (!Array.isArray(rows)) return { abstain: true, reason: "rows are not a list" };
  if (rows.length === 0) return { abstain: true, reason: "no se1 rows" };
  const bad = rows.findIndex((r) => !isScanRow(r));
  if (bad >= 0) return { abstain: true, reason: `row ${bad} is malformed` };
  return { rows: rows as ScanRow[] };
}

// ── F5 ────────────────────────────────────────────────────────────────────────

export interface ClosedTrade { id: string; pnl: number | null; costs: number }

/** F5: wins, losses and unknowns, net of costs. A trade with no outcome is unknown, never a win. */
export function postMortemStats(trades: readonly ClosedTrade[]) {
  let wins = 0, losses = 0, unknown = 0, net = 0;
  for (const t of trades) {
    if (t.pnl === null || !Number.isFinite(t.pnl) || !Number.isFinite(t.costs)) { unknown++; continue; }
    const n = t.pnl - Math.abs(t.costs);
    net += n;
    if (n > 0) wins++; else losses++;
  }
  return { wins, losses, unknown, net, winRate: wins + losses > 0 ? wins / (wins + losses) : null };
}

// ── F6 ────────────────────────────────────────────────────────────────────────

/** F6: fold reasons are listed only when every Trim-gate member has a row. */
export function foldReasons(gateMembers: readonly string[], rows: readonly ScanRow[]):
  { complete: true; reasons: ScanRow[] } | { complete: false; missing: string[] } {
  const byId = new Map(rows.map((r) => [r.scan_id, r]));
  const missing = gateMembers.filter((m) => !byId.has(m));
  if (gateMembers.length === 0 || missing.length) return { complete: false, missing: gateMembers.length ? missing : ["(gate has no members)"] };
  return { complete: true, reasons: gateMembers.map((m) => byId.get(m) as ScanRow).filter((r) => r.flag) };
}

// ── F7 ────────────────────────────────────────────────────────────────────────

export interface BacktestCosts { fee_bps: number; slippage_bps: number }
export interface BacktestEntry { date: string; cost_bps: number; window: "train" | "gap" | "evaluation" }

/** F7: entries are made on a false→true flag transition using only rows up to that date, so adding later rows
 *  never changes earlier entries. Costs are required; there is no zero-cost default. */
export function backtestEntries(
  rows: readonly { date: string; flag: boolean }[],
  costs: BacktestCosts,
  windows: { train_end: string; eval_start: string },
): BacktestEntry[] {
  if (!costs || !Number.isFinite(costs.fee_bps) || !Number.isFinite(costs.slippage_bps) || costs.fee_bps < 0 || costs.slippage_bps < 0) {
    throw new TypeError("backtestEntries: fee_bps and slippage_bps are required non-negative numbers");
  }
  const te = parseIso(windows.train_end), es = parseIso(windows.eval_start);
  if (te === null || es === null || es <= te) throw new TypeError("backtestEntries: eval_start must be a valid date after train_end");
  const out: BacktestEntry[] = [];
  let prev = false;
  for (const r of rows) {
    const t = parseIso(r.date);
    if (t === null) continue;
    if (r.flag && !prev) out.push({ date: r.date, cost_bps: costs.fee_bps + costs.slippage_bps, window: t <= te ? "train" : t < es ? "gap" : "evaluation" });
    prev = r.flag;
  }
  return out;
}

// ── F8 ────────────────────────────────────────────────────────────────────────

export interface FamilyOutcome { family: string; call_date: string; horizon_days: number; status: "hit" | "miss" | "pending" }

/** F8: accuracy per family. Pending outcomes, and outcomes whose window overlaps one already counted, are excluded. */
export function familyAccuracy(outcomes: readonly FamilyOutcome[]) {
  const out: Record<string, { hits: number; n: number; pending: number; overlapping: number; accuracy: number | null }> = {};
  const sorted = [...outcomes].sort((a, b) => a.call_date.localeCompare(b.call_date));
  const lastEnd = new Map<string, number>();
  for (const o of sorted) {
    const f = (out[o.family] ??= { hits: 0, n: 0, pending: 0, overlapping: 0, accuracy: null });
    if (o.status === "pending") { f.pending++; continue; }
    const t = parseIso(o.call_date);
    if (t === null || !Number.isInteger(o.horizon_days) || o.horizon_days < 1) continue;
    if (t < (lastEnd.get(o.family) ?? -Infinity)) { f.overlapping++; continue; }
    lastEnd.set(o.family, t + o.horizon_days * DAY_MS);
    f.n++;
    if (o.status === "hit") f.hits++;
  }
  for (const f of Object.values(out)) f.accuracy = f.n > 0 ? f.hits / f.n : null;
  return out;
}

// ── F9 ────────────────────────────────────────────────────────────────────────

export type HoldFoldChat =
  | { kind: "abstain"; gaps: string[] }
  | { kind: "evidence"; ticker: string; as_of: string; rows: ScanRow[]; evidence: Extract<HoldFoldEvidence, { ok: true }> };

/** F9: "hold or fold X?" answers only with real rows. The direction itself comes from the Hold/Fold engine. */
export function holdFoldAnswer(ticker: string, dossier: Dossier | null, supported: ReadonlySet<string>): HoldFoldChat {
  const t = ticker.trim().toUpperCase();
  if (!isTicker(t) || !supported.has(t)) return { kind: "abstain", gaps: [`${JSON.stringify(ticker)} is not a supported ticker`] };
  if (!dossier || dossier.ticker !== t) return { kind: "abstain", gaps: ["no dossier exists for this ticker"] };
  const rows = dossier.rows.filter((r) => r.ticker === t);
  if (rows.length === 0) return { kind: "abstain", gaps: ["no scans were run", ...dossier.missing.map((m) => `${m.scan_id}: ${m.reason}`)] };
  const evidence = holdFoldEvidence(rows);
  if (!evidence.ok) return { kind: "abstain", gaps: [evidence.error] };
  return { kind: "evidence", ticker: t, as_of: dossier.as_of, rows, evidence };
}
