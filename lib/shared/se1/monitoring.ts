/**
 * se1/monitoring — track D (proactive monitoring). Pure logic over fixtures; no I/O, no sends.
 * D6 (detectContradictions) and D9 (decideAlert) live in ../se1-dossier.ts. D4 is in PR #352.
 * Delivery dedupe still needs a conditional write at integration; these functions decide, they do not store.
 */
import { evidenceRank, type ScanCard } from "../se1-catalog";
import { localDate, parseIso } from "./util";

// ── D1 ────────────────────────────────────────────────────────────────────────

export function digestKey(userId: string, runId: string): string {
  return `${encodeURIComponent(userId)}|${encodeURIComponent(runId)}`;
}

/** D1: one digest per user per run. A retry of the same run is a duplicate. */
export function digestSendDecision(userId: string, runId: string, alreadySent: ReadonlySet<string>):
  { send: true; key: string } | { send: false; reason: "duplicate_run" | "invalid_input" } {
  if (!userId || !runId) return { send: false, reason: "invalid_input" };
  const key = digestKey(userId, runId);
  return alreadySent.has(key) ? { send: false, reason: "duplicate_run" } : { send: true, key };
}

// ── D2 ────────────────────────────────────────────────────────────────────────

export interface FlagObs { as_of: string; flag: boolean | null }

/** D2: one crossing per false→true transition. Repeated true rows, and unknown (null) rows, never re-fire.
 *  A first-ever true row is not a crossing: there is no known prior state. */
export function flagCrossings(history: readonly FlagObs[]): string[] {
  const sorted = history
    .map((o) => ({ ...o, t: parseIso(o.as_of) }))
    .filter((o): o is FlagObs & { t: number } => o.t !== null)
    .sort((a, b) => a.t - b.t);
  const out: string[] = [];
  let known: boolean | null = null;
  for (const o of sorted) {
    if (o.flag === null) continue;
    if (known === false && o.flag === true) out.push(o.as_of);
    known = o.flag;
  }
  return out;
}

// ── D3 ────────────────────────────────────────────────────────────────────────

export interface QueuedAlert { id: string; ticker: string }

/** D3: drop queued alerts for positions the user no longer holds. */
export function filterQueuedAlerts(queue: readonly QueuedAlert[], currentHoldings: readonly string[]) {
  const held = new Set(currentHoldings.map((t) => t.toUpperCase()));
  const keep: QueuedAlert[] = [];
  const dropped: { alert: QueuedAlert; reason: "no_longer_held" }[] = [];
  for (const a of queue) {
    if (held.has(a.ticker.toUpperCase())) keep.push(a); else dropped.push({ alert: a, reason: "no_longer_held" });
  }
  return { keep, dropped };
}

// ── D5 ────────────────────────────────────────────────────────────────────────

export interface Reminder { ticker: string; event_date: string }
export interface ScheduledEvent { ticker: string; date: string; status: "scheduled" | "cancelled" }

/** D5: after a reschedule, exactly one reminder per consented, scheduled event; everything else is removed. */
export function reconcileReminders(existing: readonly Reminder[], events: readonly ScheduledEvent[], consent: boolean) {
  const target = new Map<string, string>();
  if (consent) {
    for (const e of events) if (e.status === "scheduled" && parseIso(e.date) !== null) target.set(e.ticker, e.date);
  }
  const keep: Reminder[] = [];
  const remove: Reminder[] = [];
  const kept = new Set<string>();
  for (const r of existing) {
    const want = target.get(r.ticker);
    if (want === r.event_date && !kept.has(r.ticker)) { keep.push(r); kept.add(r.ticker); } else remove.push(r);
  }
  const add: Reminder[] = [...target].filter(([t]) => !kept.has(t)).map(([ticker, event_date]) => ({ ticker, event_date }));
  return { keep, remove, add };
}

// ── D7 ────────────────────────────────────────────────────────────────────────

export interface EvidenceMove {
  id: string;
  from: string;
  to: string;
  kind: "promotion" | "demotion" | "retired" | "new_version";
  /** Demotions, retirements and version resets are corrections and are listed first. */
  correction: boolean;
}

/** D7: what moved between two catalog snapshots. Corrections are never hidden behind promotions. */
export function evidenceMoves(prev: readonly ScanCard[], curr: readonly ScanCard[]): EvidenceMove[] {
  const before = new Map(prev.map((c) => [c.id, c]));
  const moves: EvidenceMove[] = [];
  for (const c of curr) {
    const p = before.get(c.id);
    if (!p) continue;
    if (c.status === "retired" && p.status !== "retired") {
      moves.push({ id: c.id, from: p.evidence_level, to: c.evidence_level, kind: "retired", correction: true });
    } else if (c.version !== p.version && c.evidence_level !== p.evidence_level) {
      moves.push({ id: c.id, from: p.evidence_level, to: c.evidence_level, kind: "new_version", correction: evidenceRank(c.evidence_level) < evidenceRank(p.evidence_level) });
    } else if (evidenceRank(c.evidence_level) > evidenceRank(p.evidence_level)) {
      moves.push({ id: c.id, from: p.evidence_level, to: c.evidence_level, kind: "promotion", correction: false });
    } else if (evidenceRank(c.evidence_level) < evidenceRank(p.evidence_level)) {
      moves.push({ id: c.id, from: p.evidence_level, to: c.evidence_level, kind: "demotion", correction: true });
    }
  }
  return moves.sort((a, b) => Number(b.correction) - Number(a.correction) || a.id.localeCompare(b.id));
}

// ── D8 ────────────────────────────────────────────────────────────────────────

/** D8: the brief's freshness label always carries the real build time. A failed run is never "today". */
export function briefFreshness(lastBuiltAt: string | null, now: Date, lastRunFailed: boolean, timeZone: string):
  { state: "current" | "stale" | "unavailable"; label: string; built_at: string | null } {
  const t = lastBuiltAt === null ? null : parseIso(lastBuiltAt);
  if (t === null || lastBuiltAt === null) return { state: "unavailable", label: "No brief is available.", built_at: null };
  const builtDay = localDate(new Date(t), timeZone);
  const today = localDate(now, timeZone);
  if (builtDay === null || today === null) return { state: "unavailable", label: "No brief is available.", built_at: lastBuiltAt };
  if (lastRunFailed || builtDay !== today) {
    return { state: "stale", label: `Stale: last built ${lastBuiltAt}${lastRunFailed ? " (today's run failed)" : ""}.`, built_at: lastBuiltAt };
  }
  return { state: "current", label: `Built today at ${lastBuiltAt}.`, built_at: lastBuiltAt };
}
