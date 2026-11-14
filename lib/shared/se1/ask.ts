/**
 * se1/ask — track A (Nu AI grounded in se1). Pure logic over fixtures; no I/O, no model call.
 * A model call (C1) may sit on top of these at integration, behind the J2 check.
 */
import { isScanId, splitCitations, type ScanCard } from "../se1-catalog";
import type { Dossier, ScanRow } from "../se1-dossier";
import { isTicker, parseIso } from "./util";

// ── A1 ────────────────────────────────────────────────────────────────────────

export interface NewsItem { id: string; published_at: string; headline: string }
export interface NewsCutoffResult {
  kept: NewsItem[];
  excluded: { id: string; reason: "after_cutoff" | "no_timestamp" }[];
  /** Fixed wording: news and price moves are shown side by side, never as cause and effect. */
  causation_note: string;
}

export const NO_CAUSATION_NOTE = "These items were published before the cutoff. They are context, not a proven cause of the price move.";

/** A1: keep only news published at or before the cutoff. An item with no valid timestamp is excluded. */
export function newsBeforeCutoff(items: readonly NewsItem[], cutoff: string): NewsCutoffResult | { error: string } {
  const c = parseIso(cutoff);
  if (c === null) return { error: "invalid cutoff" };
  const kept: NewsItem[] = [];
  const excluded: NewsCutoffResult["excluded"] = [];
  for (const item of items) {
    const t = parseIso(item.published_at);
    if (t === null) excluded.push({ id: item.id, reason: "no_timestamp" });
    else if (t > c) excluded.push({ id: item.id, reason: "after_cutoff" });
    else kept.push(item);
  }
  return { kept, excluded, causation_note: NO_CAUSATION_NOTE };
}

// ── A2 ────────────────────────────────────────────────────────────────────────

export type ScanMatch =
  | { kind: "match"; card: string; score: number }
  | { kind: "clarify"; candidates: string[] }
  | { kind: "none"; reason: string };

const STOP = new Set(["a", "an", "the", "is", "it", "of", "to", "in", "on", "for", "and", "or", "what", "does", "do", "my", "this", "that", "has", "have", "with", "be", "are"]);

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)));
}

/** A2: match a plain-language question to one card. A tie at the top asks the user to choose. */
export function matchScanQuestion(question: string, cards: readonly ScanCard[], minScore = 2): ScanMatch {
  const q = tokens(question);
  if (q.size === 0) return { kind: "none", reason: "question has no searchable words" };
  const scored = cards
    .filter((c) => c.status !== "retired")
    .map((c) => {
      const words = tokens(`${c.title} ${c.question} ${c.id.replace(/[._]/g, " ")}`);
      let score = 0;
      for (const t of q) if (words.has(t)) score++;
      return { id: c.id, score };
    })
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (scored.length === 0) return { kind: "none", reason: "no scan matches this question" };
  const top = scored.filter((s) => s.score === scored[0].score);
  if (top.length > 1) return { kind: "clarify", candidates: top.map((s) => s.id) };
  return { kind: "match", card: scored[0].id, score: scored[0].score };
}

export type ScanParams = Record<string, unknown>;
export const ALLOWED_SCAN_PARAMS = ["ticker", "as_of", "lookback_bars"] as const;

/** A2: parameters a scan run may take. Anything unknown or malformed is an error, and nothing runs. */
export function validateScanParams(card: ScanCard, params: ScanParams): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const key of Object.keys(params)) {
    if (!(ALLOWED_SCAN_PARAMS as readonly string[]).includes(key)) errors.push(`unsupported parameter: ${key}`);
  }
  if (!isTicker(params.ticker)) errors.push("ticker is required and must be an uppercase symbol");
  if (params.as_of !== undefined && parseIso(params.as_of) === null) errors.push("as_of must be an ISO date");
  if (params.lookback_bars !== undefined) {
    const n = params.lookback_bars;
    if (typeof n !== "number" || !Number.isInteger(n) || n < (card.min_bars ?? 1) || n > 5000) {
      errors.push(`lookback_bars must be an integer from ${card.min_bars ?? 1} to 5000`);
    }
  }
  if (card.status === "retired") errors.push("scan is retired");
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ── A3 ────────────────────────────────────────────────────────────────────────

export type ResolvedPart =
  | { type: "text"; text: string }
  | { type: "scan"; id: string; version: string }
  | { type: "unknown_scan"; id: string };

/** A3 (audit R10): a well-formed ID that is not a known card is marked unknown, never turned into a link. */
export function resolveCitations(text: string, cards: readonly Pick<ScanCard, "id" | "version">[]): ResolvedPart[] {
  const known = new Map(cards.map((c) => [c.id, c.version]));
  return splitCitations(text).map((p) => {
    if (p.type === "text") return p;
    const version = known.get(p.id);
    return version === undefined ? { type: "unknown_scan", id: p.id } : { type: "scan", id: p.id, version };
  });
}

// ── A4 ────────────────────────────────────────────────────────────────────────

export interface CounterEvidence {
  pairs: { supports: string; against: string }[];
  /** Set when pairs is empty: why there is no counter-evidence. */
  gap?: "no_flagged_rows" | "no_contradicts_relation" | "contrary_scans_not_run" | "contrary_scans_did_not_flag";
}

/** A4: flagged rows that a flagged row's card lists under `contradicts`. No pair yields a stated gap. */
export function counterEvidence(d: Dossier, cards: readonly ScanCard[]): CounterEvidence {
  const rowById = new Map(d.rows.filter((r) => r.ticker === d.ticker).map((r) => [r.scan_id, r]));
  const flagged = [...rowById.values()].filter((r) => r.flag);
  if (flagged.length === 0) return { pairs: [], gap: "no_flagged_rows" };
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const relations = flagged.flatMap((r) => (cardById.get(r.scan_id)?.contradicts ?? []).map((o) => ({ supports: r.scan_id, against: o })));
  if (relations.length === 0) return { pairs: [], gap: "no_contradicts_relation" };
  const ran = relations.filter((p) => rowById.has(p.against));
  if (ran.length === 0) return { pairs: [], gap: "contrary_scans_not_run" };
  const pairs = ran.filter((p) => rowById.get(p.against)?.flag === true);
  if (pairs.length === 0) return { pairs: [], gap: "contrary_scans_did_not_flag" };
  return { pairs };
}

// ── A5 ────────────────────────────────────────────────────────────────────────

export type RecipeComparison =
  | { ok: false; error: string }
  | {
      ok: true;
      comparable: { scan_id: string; a: ScanRow; b: ScanRow }[];
      notComparable: { scan_id: string; reason: "missing_in_a" | "missing_in_b" | "missing_in_both" | "version_differs" }[];
      /** True only when every recipe scan is comparable. */
      likeForLike: boolean;
    };

/** A5: compare two tickers on the same recipe. Different dates are refused outright. */
export function compareOnRecipe(a: Dossier, b: Dossier, recipe: readonly string[]): RecipeComparison {
  if (a.as_of !== b.as_of) return { ok: false, error: `dates differ: ${a.as_of} vs ${b.as_of}` };
  if (recipe.length === 0) return { ok: false, error: "empty recipe" };
  if (!recipe.every(isScanId)) return { ok: false, error: "recipe contains an invalid scan ID" };
  const ra = new Map(a.rows.map((r) => [r.scan_id, r]));
  const rb = new Map(b.rows.map((r) => [r.scan_id, r]));
  const comparable: { scan_id: string; a: ScanRow; b: ScanRow }[] = [];
  const notComparable: Extract<RecipeComparison, { ok: true }>["notComparable"] = [];
  for (const id of [...new Set(recipe)]) {
    const x = ra.get(id), y = rb.get(id);
    if (!x && !y) notComparable.push({ scan_id: id, reason: "missing_in_both" });
    else if (!x) notComparable.push({ scan_id: id, reason: "missing_in_a" });
    else if (!y) notComparable.push({ scan_id: id, reason: "missing_in_b" });
    else if (x.provenance.scan_version !== y.provenance.scan_version) notComparable.push({ scan_id: id, reason: "version_differs" });
    else comparable.push({ scan_id: id, a: x, b: y });
  }
  return { ok: true, comparable, notComparable, likeForLike: notComparable.length === 0 };
}

// ── A6 ────────────────────────────────────────────────────────────────────────

export type ScreenOp = "lt" | "lte" | "gt" | "gte" | "eq";
export interface ScreenFilter { field: string; op: string; value: unknown }
export interface CompiledFilter { field: string; op: ScreenOp; value: number }

/** Fields a screen may filter on, with the valid value range. */
export const SCREEN_FIELDS: Record<string, { min: number; max: number }> = {
  rsi_14: { min: 0, max: 100 },
  pct_above_sma200: { min: -100, max: 1000 },
  sma200_slope_pct: { min: -100, max: 100 },
  market_cap_usd: { min: 0, max: 1e14 },
  return_20d_pct: { min: -100, max: 1000 },
};
const OPS: readonly ScreenOp[] = ["lt", "lte", "gt", "gte", "eq"];

/** A6: compile structured filters (from a model or a form). Any unsupported filter rejects the whole screen. */
export function compileScreen(filters: readonly ScreenFilter[], maxFilters = 8):
  { ok: true; query: CompiledFilter[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (filters.length === 0) errors.push("no filters");
  if (filters.length > maxFilters) errors.push(`at most ${maxFilters} filters`);
  const query: CompiledFilter[] = [];
  filters.forEach((f, i) => {
    const spec = SCREEN_FIELDS[f.field];
    if (!spec) { errors.push(`filter ${i}: unsupported field ${JSON.stringify(f.field)}`); return; }
    if (!(OPS as readonly string[]).includes(f.op)) { errors.push(`filter ${i}: unsupported operator ${JSON.stringify(f.op)}`); return; }
    if (typeof f.value !== "number" || !Number.isFinite(f.value) || f.value < spec.min || f.value > spec.max) {
      errors.push(`filter ${i}: ${f.field} value must be a number from ${spec.min} to ${spec.max}`); return;
    }
    query.push({ field: f.field, op: f.op as ScreenOp, value: f.value });
  });
  return errors.length ? { ok: false, errors } : { ok: true, query };
}

// ── A8 ────────────────────────────────────────────────────────────────────────

export type ContextScope = "followed" | "holdings" | "conversation";
const SCOPES: readonly ContextScope[] = ["followed", "holdings", "conversation"];

/** A8: every private-context cache key carries the user. A missing user or unknown scope throws. */
export function contextCacheKey(userId: string, scope: ContextScope): string {
  if (typeof userId !== "string" || userId.trim() === "") throw new TypeError("contextCacheKey: user id is required");
  if (!SCOPES.includes(scope)) throw new TypeError(`contextCacheKey: unknown scope ${String(scope)}`);
  return `ctx:${encodeURIComponent(userId)}:${scope}`;
}

/** A8: on logout or user switch, return a copy of the store with none of that user's keys. */
export function clearUserContext<V>(store: ReadonlyMap<string, V>, userId: string): Map<string, V> {
  const prefix = `ctx:${encodeURIComponent(userId)}:`;
  return new Map([...store].filter(([k]) => !k.startsWith(prefix)));
}
