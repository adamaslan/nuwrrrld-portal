/**
 * se1/council — track C (council grounded in se1). Pure logic over fixtures; no I/O, no model call.
 * C4 (missingEvidenceSection) lives in ../se1-dossier.ts. C9 is in PR #352.
 */
import type { CardRole, ScanCard } from "../se1-catalog";
import { checkFaithfulness, type ContradictionReport, type Dossier, type ScanRow } from "../se1-dossier";
import { counterEvidence } from "./ask";
import { DAY_MS, parseIso } from "./util";

// ── C1 ────────────────────────────────────────────────────────────────────────

/** C1: the rows a seat may see: only cards whose role is one the seat declares. Empty means abstain. */
export function sliceForSeat(d: Dossier, roles: readonly CardRole[], cards: readonly ScanCard[]):
  { rows: ScanRow[] } | { abstain: true; reason: string } {
  if (roles.length === 0) return { abstain: true, reason: "seat declares no roles" };
  const roleOf = new Map(cards.map((c) => [c.id, c.role]));
  const rows = d.rows.filter((r) => r.ticker === d.ticker && roles.includes(roleOf.get(r.scan_id) as CardRole));
  if (rows.length === 0) return { abstain: true, reason: `no rows for roles: ${roles.join(", ")}` };
  return { rows };
}

// ── C2 ────────────────────────────────────────────────────────────────────────

export interface AgendaItem { a: ScanRow; b: ScanRow }

/** C2: one debate item per qualified contradiction whose two rows are present and flagged. */
export function debateAgenda(report: ContradictionReport, d: Dossier): { items: AgendaItem[]; reason?: string } {
  const byId = new Map(d.rows.filter((r) => r.ticker === d.ticker && r.flag).map((r) => [r.scan_id, r]));
  const items: AgendaItem[] = [];
  for (const p of report.pairs) {
    const a = byId.get(p.a), b = byId.get(p.b);
    if (a && b) items.push({ a, b });
  }
  return items.length ? { items } : { items, reason: "no qualifying contradiction between flagged rows" };
}

// ── C3 ────────────────────────────────────────────────────────────────────────

export type SeatClaimCheck =
  | { verdict: "accept"; sentences: string[] }
  | { verdict: "reject"; problems: { sentence: string; why: string }[]; retry: boolean }
  | { verdict: "abstain"; reason: string };

/** C3: run J2 on a seat's text. Any ungrounded or unverifiable sentence rejects. After maxAttempts, abstain. */
export function checkSeatClaim(text: string, rows: readonly ScanRow[], attempt: number, maxAttempts = 2): SeatClaimCheck {
  if (!Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return { verdict: "abstain", reason: "invalid attempt count" };
  }
  if (attempt > maxAttempts) return { verdict: "abstain", reason: `no grounded answer after ${maxAttempts} attempts` };
  const r = checkFaithfulness(text, rows);
  const problems = [...r.ungrounded, ...r.unverifiable.map((s) => ({ sentence: s, why: "claim cites no row" }))];
  if (problems.length > 0) return { verdict: "reject", problems, retry: attempt < maxAttempts };
  if (r.grounded.length === 0) return { verdict: "reject", problems: [{ sentence: text, why: "no sentences" }], retry: attempt < maxAttempts };
  return { verdict: "accept", sentences: r.grounded };
}

// ── C5 ────────────────────────────────────────────────────────────────────────

/** C5: the contrary rows the devil's advocate may cite. None means it abstains. */
export function advocateInputs(d: Dossier, cards: readonly ScanCard[]):
  { against: ScanRow[] } | { abstain: true; reason: string } {
  const ce = counterEvidence(d, cards);
  if (ce.pairs.length === 0) return { abstain: true, reason: ce.gap ?? "no contrary evidence" };
  const ids = new Set(ce.pairs.map((p) => p.against));
  return { against: d.rows.filter((r) => ids.has(r.scan_id)) };
}

// ── C6 ────────────────────────────────────────────────────────────────────────

export interface VerdictRecord {
  verdict: string;
  as_of: string;
  rows: readonly { scan_id: string; version: string }[];
  models: readonly string[];
}

/** C6: replay keeps the original untouched and labels the rerun, with what changed between them. */
export function replayRecord(original: VerdictRecord, rerun: VerdictRecord) {
  if (parseIso(original.as_of) === null || parseIso(rerun.as_of) === null) return { ok: false as const, error: "invalid as_of" };
  const key = (r: { scan_id: string; version: string }) => `${r.scan_id}@${r.version}`;
  const before = new Set(original.rows.map(key));
  const after = new Set(rerun.rows.map(key));
  return {
    ok: true as const,
    original: Object.freeze(JSON.parse(JSON.stringify(original)) as VerdictRecord),
    rerun: { ...rerun, label: `Rerun on ${rerun.as_of} (original verdict from ${original.as_of} unchanged)` },
    changedRows: [...new Set([...before, ...after])].filter((k) => before.has(k) !== after.has(k)).sort(),
    changedModels: [...new Set([...original.models, ...rerun.models])]
      .filter((m) => original.models.includes(m) !== rerun.models.includes(m)).sort(),
    verdictChanged: original.verdict !== rerun.verdict,
  };
}

// ── C7 ────────────────────────────────────────────────────────────────────────

export interface CouncilCall { id: string; as_of: string; horizon_days: number; direction: "up" | "down" }

/** C7: unmatured calls are pending and outside the denominator; matured calls with no outcome are missing, not misses. */
export function verdictScorecard(
  calls: readonly CouncilCall[],
  outcomes: Readonly<Record<string, { return_pct: number }>>,
  asOf: string,
  baselineHitRate: number,
) {
  const now = parseIso(asOf);
  if (now === null) return { ok: false as const, error: "invalid asOf" };
  if (!Number.isFinite(baselineHitRate) || baselineHitRate < 0 || baselineHitRate > 1) return { ok: false as const, error: "baseline must be a rate from 0 to 1" };
  let hits = 0, n = 0, pending = 0, missing = 0, invalid = 0;
  for (const c of calls) {
    const t = parseIso(c.as_of);
    if (t === null || !Number.isInteger(c.horizon_days) || c.horizon_days < 1) { invalid++; continue; }
    if (t + c.horizon_days * DAY_MS > now) { pending++; continue; }
    const o = outcomes[c.id];
    if (!o || !Number.isFinite(o.return_pct)) { missing++; continue; }
    n++;
    if ((c.direction === "up" && o.return_pct > 0) || (c.direction === "down" && o.return_pct < 0)) hits++;
  }
  return { ok: true as const, hits, n, pending, missing, invalid, hitRate: n > 0 ? hits / n : null, baseline: baselineHitRate };
}

// ── C8 ────────────────────────────────────────────────────────────────────────

export interface SectorClaim { id: string; needs: readonly string[] }

/** C8: claims blocked by a missing or stale input. The recipe is complete only when nothing is blocked. */
export function sectorInputsGate(
  claims: readonly SectorClaim[],
  inputs: Readonly<Record<string, { as_of: string } | null | undefined>>,
  asOf: string,
  maxAgeDays: number,
) {
  const now = parseIso(asOf);
  const bad = (name: string): string | null => {
    const v = inputs[name];
    if (!v) return "missing";
    const t = parseIso(v.as_of);
    if (t === null || now === null || !Number.isFinite(maxAgeDays) || maxAgeDays < 0) return "undated";
    return now - t > maxAgeDays * DAY_MS ? "stale" : null;
  };
  const allowed: string[] = [];
  const blocked: { claim: string; inputs: { name: string; reason: string }[] }[] = [];
  for (const c of claims) {
    const problems = c.needs.map((n) => ({ name: n, reason: bad(n) })).filter((p): p is { name: string; reason: string } => p.reason !== null);
    if (problems.length) blocked.push({ claim: c.id, inputs: problems }); else allowed.push(c.id);
  }
  return { allowed, blocked, complete: blocked.length === 0 };
}
