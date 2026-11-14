/**
 * se1/ops — track J (self-improving operations). Pure logic; no I/O, no model call.
 * J2 (checkFaithfulness) lives in ../se1-dossier.ts. J9 is live on /scans/gaps.
 */
import { EVIDENCE_LEVELS, evidenceRank, type EvidenceLevel } from "../se1-catalog";
import { fnv1a, isId, localDate, parseIso, pearson, round } from "./util";

// ── J1 ────────────────────────────────────────────────────────────────────────

export interface EvidenceEntry { version: string; level: EvidenceLevel; at: string; event: string; reason?: string }
export type EvidenceEvent =
  | { type: "new_version"; version: string; at: string }
  | { type: "promote"; level: EvidenceLevel; at: string }
  | { type: "demote"; level: EvidenceLevel; at: string; reason: string }
  | { type: "invalidate"; at: string; reason: string };

/** J1: append-only evidence history. A new version starts at E0; invalidation drops to E0; history is never rewritten. */
export function nextEvidenceState(history: readonly EvidenceEntry[], event: EvidenceEvent):
  { ok: true; history: EvidenceEntry[]; current: EvidenceEntry } | { ok: false; error: string } {
  if (parseIso(event.at) === null) return { ok: false, error: "invalid event time" };
  const cur = history[history.length - 1];
  if (cur && event.at < cur.at) return { ok: false, error: "event is older than the latest entry" };
  let entry: EvidenceEntry;
  if (event.type === "new_version") {
    if (!event.version || (cur && event.version === cur.version)) return { ok: false, error: "new_version needs a different version" };
    entry = { version: event.version, level: "E0", at: event.at, event: "new_version" };
  } else {
    if (!cur) return { ok: false, error: "no version exists yet" };
    if (event.type === "promote") {
      if (!EVIDENCE_LEVELS.includes(event.level) || evidenceRank(event.level) <= evidenceRank(cur.level)) return { ok: false, error: "promotion must raise the level" };
      entry = { version: cur.version, level: event.level, at: event.at, event: "promote" };
    } else if (event.type === "demote") {
      if (!EVIDENCE_LEVELS.includes(event.level) || evidenceRank(event.level) >= evidenceRank(cur.level)) return { ok: false, error: "demotion must lower the level" };
      entry = { version: cur.version, level: event.level, at: event.at, event: "demote", reason: event.reason };
    } else {
      entry = { version: cur.version, level: "E0", at: event.at, event: "invalidate", reason: event.reason };
    }
  }
  return { ok: true, history: [...history, entry], current: entry };
}

// ── J3 ────────────────────────────────────────────────────────────────────────

export interface Arm { name: string; model: string; version: string }
export interface AbRecord { key: string; arm: string; model: string; version: string; reason: "assigned" | "over_budget"; fallback: string | null }

/** J3: the same key always lands on the same arm. Over budget, everyone gets the control arm (arms[0]). */
export function abAssignment(key: string, arms: readonly Arm[], spentUsd: number, budgetUsd: number): AbRecord | { error: string } {
  if (!key || arms.length === 0) return { error: "key and at least one arm are required" };
  if (!Number.isFinite(spentUsd) || !Number.isFinite(budgetUsd) || budgetUsd < 0) return { error: "invalid budget" };
  const over = spentUsd >= budgetUsd;
  const arm = over ? arms[0] : arms[parseInt(fnv1a(key), 16) % arms.length];
  return { key, arm: arm.name, model: arm.model, version: arm.version, reason: over ? "over_budget" : "assigned", fallback: null };
}

/** J3: record that the call was served by a fallback model, so quality is not credited to the wrong arm. */
export function withFallback(record: AbRecord, servedBy: string): AbRecord {
  return servedBy === record.model ? record : { ...record, fallback: servedBy };
}

// ── J4 ────────────────────────────────────────────────────────────────────────

export interface FlagRate { flagged: number; n: number }
export type DriftDecision =
  | { alert: true; key: string; z: number }
  | { alert: false; reason: "insufficient_sample" | "input_outage" | "duplicate" | "no_drift" | "invalid_input"; z?: number };

/** J4: two-proportion z-test on flag rates. Small samples and input outages are never reported as drift;
 *  the same (scan, week, direction) alerts once. */
export function driftDecision(scanId: string, week: string, prev: FlagRate, curr: FlagRate, opts: {
  minN: number; zThreshold?: number; inputOutage: boolean; alreadyAlerted: ReadonlySet<string>;
}): DriftDecision {
  const ok = (r: FlagRate) => Number.isInteger(r.n) && Number.isInteger(r.flagged) && r.flagged >= 0 && r.flagged <= r.n;
  if (!ok(prev) || !ok(curr)) return { alert: false, reason: "invalid_input" };
  if (opts.inputOutage) return { alert: false, reason: "input_outage" };
  if (prev.n < opts.minN || curr.n < opts.minN) return { alert: false, reason: "insufficient_sample" };
  const p1 = prev.flagged / prev.n, p2 = curr.flagged / curr.n;
  const pooled = (prev.flagged + curr.flagged) / (prev.n + curr.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / prev.n + 1 / curr.n));
  const z = se === 0 ? 0 : round((p2 - p1) / se, 2);
  if (Math.abs(z) < (opts.zThreshold ?? 3)) return { alert: false, reason: "no_drift", z };
  const key = `${scanId}|${week}|${z > 0 ? "up" : "down"}`;
  if (opts.alreadyAlerted.has(key)) return { alert: false, reason: "duplicate", z };
  return { alert: true, key, z };
}

// ── J5 (audit R8) ─────────────────────────────────────────────────────────────

export type UnassessableReason = "too_short" | "length_mismatch" | "flat" | "non_finite";

/** J5: near-duplicate proposals plus every pair that could not be assessed, with the reason.
 *  The output is a review list; nothing may delete or merge a scan from it. */
export function assessDuplicates(series: Readonly<Record<string, readonly number[]>>, threshold = 0.9, minLength = 3) {
  const ids = Object.keys(series).sort();
  const pairs: { a: string; b: string; r: number; action: "review_merge" }[] = [];
  const unassessable: { a: string; b: string; reason: UnassessableReason }[] = [];
  const flat = (s: readonly number[]) => s.every((x) => x === s[0]);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = series[ids[i]], b = series[ids[j]];
      let reason: UnassessableReason | null = null;
      if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) reason = "non_finite";
      else if (a.length !== b.length) reason = "length_mismatch";
      else if (a.length < minLength) reason = "too_short";
      else if (flat(a) || flat(b)) reason = "flat";
      if (reason) { unassessable.push({ a: ids[i], b: ids[j], reason }); continue; }
      const r = pearson(a, b);
      if (r === null) { unassessable.push({ a: ids[i], b: ids[j], reason: "flat" }); continue; }
      if (r > threshold) pairs.push({ a: ids[i], b: ids[j], r: round(r, 3), action: "review_merge" });
    }
  }
  return { pairs, unassessable };
}

// ── J6 ────────────────────────────────────────────────────────────────────────

const TELEMETRY_SURFACES = new Set(["web", "mobile", "api", "mcp"]);

/** J6: a usage event keeps recipe id, surface and UTC day only. Any other input field is dropped. */
export function telemetryEvent(input: Readonly<Record<string, unknown>>): { recipe_id: string; surface: string; day: string } | null {
  const recipe = input.recipe_id, surface = input.surface, at = input.at;
  if (!isId(recipe, 64) || typeof surface !== "string" || !TELEMETRY_SURFACES.has(surface)) return null;
  const t = parseIso(at);
  if (t === null) return null;
  const day = localDate(new Date(t), "UTC");
  return day ? { recipe_id: recipe, surface, day } : null;
}

/** J6: low-usage recipes become review proposals. This function removes nothing. */
export function pruneProposals(counts: Readonly<Record<string, number>>, threshold: number) {
  return Object.entries(counts)
    .filter(([, n]) => Number.isFinite(n) && n < threshold)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([recipe_id, count]) => ({ recipe_id, count, action: "review" as const }));
}

// ── J7 ────────────────────────────────────────────────────────────────────────

export interface Vote { user: string; finding: string; vote: 1 | -1; day: string; at: string }

/** J7: one counted vote per user per finding (the latest), at most dailyCap counted votes per user per day.
 *  The output is a priority score per finding and has no evidence level. */
export function applyFeedback(votes: readonly Vote[], dailyCap: number): Record<string, number> {
  const latest = new Map<string, Vote>();
  for (const v of votes) {
    if (v.vote !== 1 && v.vote !== -1) continue;
    const k = `${v.user}|${v.finding}`;
    const cur = latest.get(k);
    if (!cur || v.at > cur.at) latest.set(k, v);
  }
  const perUserDay = new Map<string, number>();
  const out: Record<string, number> = {};
  for (const v of [...latest.values()].sort((a, b) => a.at.localeCompare(b.at))) {
    const k = `${v.user}|${v.day}`;
    const used = perUserDay.get(k) ?? 0;
    if (used >= dailyCap) continue;
    perUserDay.set(k, used + 1);
    out[v.finding] = (out[v.finding] ?? 0) + v.vote;
  }
  return out;
}

// ── J8 ────────────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, /\bsk_(live|test)_[A-Za-z0-9]{10,}\b/g, /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b(postgres(ql)?|mongodb(\+srv)?|redis):\/\/\S+/g, /\b[A-Fa-f0-9]{40,}\b/g,
];
const CAUSE = /\b(because|caused|due to|root cause|failed when|triggered by)\b/i;

/** J8: every cause sentence must quote a run ID or a log line from the input; otherwise it is replaced with
 *  "Cause unknown." Secret-shaped strings are redacted before anything is returned. */
export function checkIncidentNote(note: string, run: { ids: readonly string[]; log_lines: readonly string[] }) {
  let redacted = 0;
  let text = note;
  for (const re of SECRET_PATTERNS) text = text.replace(re, () => { redacted++; return "[redacted]"; });
  const evidence = [...run.ids, ...run.log_lines.map((l) => l.trim()).filter((l) => l.length >= 12)];
  const unsupported: string[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => {
    if (!CAUSE.test(s)) return s;
    if (evidence.some((e) => s.includes(e) || (e.length > 40 && s.includes(e.slice(0, 40))))) return s;
    unsupported.push(s);
    return "Cause unknown.";
  });
  return { text: sentences.join(" "), redacted, unsupportedCauses: unsupported };
}
