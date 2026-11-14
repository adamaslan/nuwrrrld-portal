/**
 * se1/mobile — track H (mobile-native) decision logic. Pure; no device APIs, no storage.
 * Kept in the shared folder so gcp3-mobile can copy it byte-identical; the device wiring lives in mobile.
 */
import { evidenceRank, type EvidenceLevel } from "../se1-catalog";
import { isTicker, parseIso } from "./util";

// ── H1 ────────────────────────────────────────────────────────────────────────

export interface WidgetSnapshot { refreshed_at: string; flags: readonly { ticker: string; scan_id: string }[] }
export type WidgetState =
  | { state: "locked"; refreshed_at: string | null }
  | { state: "unavailable"; reason: string }
  | { state: "stale" | "fresh"; refreshed_at: string; flags: WidgetSnapshot["flags"] };

/** H1: the widget always shows its refresh time. A locked device shows no ticker names. */
export function widgetState(snapshot: WidgetSnapshot | null, now: Date, maxAgeMs: number, locked: boolean): WidgetState {
  const t = snapshot ? parseIso(snapshot.refreshed_at) : null;
  if (locked) return { state: "locked", refreshed_at: t === null || !snapshot ? null : snapshot.refreshed_at };
  if (!snapshot || t === null) return { state: "unavailable", reason: "no data has been loaded" };
  return { state: now.getTime() - t > maxAgeMs ? "stale" : "fresh", refreshed_at: snapshot.refreshed_at, flags: snapshot.flags };
}

// ── H2 ────────────────────────────────────────────────────────────────────────

/** H2: a voice query runs only with one candidate and an explicit confirmation. */
export function voiceRunDecision(candidates: readonly string[], confirmed: boolean):
  { run: true; query: string } | { run: false; reason: "no_candidate" | "choose" | "confirm"; choices: string[] } {
  const unique = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))];
  if (unique.length === 0) return { run: false, reason: "no_candidate", choices: [] };
  if (unique.length > 1) return { run: false, reason: "choose", choices: unique };
  if (!confirmed) return { run: false, reason: "confirm", choices: unique };
  return { run: true, query: unique[0] };
}

// ── H3 ────────────────────────────────────────────────────────────────────────

export interface TriageAction { id: string; finding: string; action: "keep" | "dismiss" | "deep_dive"; at: string }
export type TriageState = Readonly<Record<string, TriageAction>>;

/** H3: the latest action per finding wins, ordered by time and then action id. Replays are idempotent and
 *  order-independent, so two devices converge on the same state. */
export function applyTriage(state: TriageState, actions: readonly TriageAction[]): TriageState {
  const next: Record<string, TriageAction> = { ...state };
  for (const a of actions) {
    if (parseIso(a.at) === null || !a.id) continue;
    const cur = next[a.finding];
    if (!cur || a.at > cur.at || (a.at === cur.at && a.id > cur.id)) next[a.finding] = a;
  }
  return next;
}

// ── H4 ────────────────────────────────────────────────────────────────────────

export const OFFLINE_CACHE_MAX = 10;
export interface CachedDossier { user_id: string; ticker: string; cached_at: string; payload: unknown }

/** H4: insert or replace, newest first, at most 10 entries, none older than maxAgeMs. */
export function cachePut(cache: readonly CachedDossier[], entry: CachedDossier, now: Date, maxAgeMs: number): CachedDossier[] {
  const rest = cache.filter((c) => !(c.user_id === entry.user_id && c.ticker === entry.ticker));
  return cacheEvict([entry, ...rest], now, maxAgeMs);
}

export function cacheEvict(cache: readonly CachedDossier[], now: Date, maxAgeMs: number): CachedDossier[] {
  return cache
    .filter((c) => { const t = parseIso(c.cached_at); return t !== null && now.getTime() - t <= maxAgeMs; })
    .sort((a, b) => b.cached_at.localeCompare(a.cached_at))
    .slice(0, OFFLINE_CACHE_MAX);
}

/** H4: logout or revocation leaves nothing of that user in the cache. */
export function clearForUser(cache: readonly CachedDossier[], userId: string): CachedDossier[] {
  return cache.filter((c) => c.user_id !== userId);
}

// ── H5 ────────────────────────────────────────────────────────────────────────

/** H5: a ticker read from an image is used directly only when exactly one valid candidate exists.
 *  The result carries no image data. */
export function tickerFromExtraction(candidates: readonly string[]):
  { ticker: string } | { confirm: true; choices: string[] } {
  const valid = [...new Set(candidates.map((c) => c.trim().toUpperCase()).filter(isTicker))];
  return valid.length === 1 ? { ticker: valid[0] } : { confirm: true, choices: valid };
}

// ── H6 ────────────────────────────────────────────────────────────────────────

/** H6: unsupported devices get a notification fallback. A cancelled event stops the activity with a
 *  payload that carries no position data. */
export function liveActivityPlan(deviceSupports: boolean, event: { ticker: string; status: "scheduled" | "cancelled" }, position?: { value: number }):
  | { action: "fallback_notification"; ticker: string }
  | { action: "stop"; payload: { ticker: string } }
  | { action: "start"; payload: { ticker: string; position_value?: number } } {
  if (event.status === "cancelled") return { action: "stop", payload: { ticker: event.ticker } };
  if (!deviceSupports) return { action: "fallback_notification", ticker: event.ticker };
  return { action: "start", payload: position ? { ticker: event.ticker, position_value: position.value } : { ticker: event.ticker } };
}

// ── H7 ────────────────────────────────────────────────────────────────────────

export type HapticTier = "none" | "light" | "medium" | "strong";
const TIER_BY_LEVEL: Record<EvidenceLevel, HapticTier> = { E0: "none", E1: "light", E2: "light", E3: "medium", E4: "strong" };

/** H7: haptic strength rises with evidence and never with demotion. No consent or quiet hours is "none". */
export function hapticTier(level: EvidenceLevel, consent: boolean, inQuietHours: boolean): HapticTier {
  if (!consent || inQuietHours) return "none";
  return TIER_BY_LEVEL[level] ?? "none";
}

export function hapticRank(t: HapticTier): number {
  return ["none", "light", "medium", "strong"].indexOf(t);
}

/** True when a level change would raise urgency on a demotion (always false with this table; tested). */
export function demotionRaisesUrgency(from: EvidenceLevel, to: EvidenceLevel): boolean {
  return evidenceRank(to) < evidenceRank(from) && hapticRank(TIER_BY_LEVEL[to]) > hapticRank(TIER_BY_LEVEL[from]);
}

// ── H8 ────────────────────────────────────────────────────────────────────────

/** H8: share only an active public link. The URL has no query string or fragment, so no token rides along. */
export function shareUrl(link: { url: string; public: boolean; revoked: boolean }, allowedHost: string): { url: string } | { error: string } {
  if (!link.public || link.revoked) return { error: "link is not an active public link" };
  let u: URL;
  try { u = new URL(link.url); } catch { return { error: "invalid URL" }; }
  if (u.protocol !== "https:" || u.hostname !== allowedHost) return { error: "link is not on the public host" };
  if (u.search || u.hash || u.username || u.password) return { error: "link carries a query, fragment or credentials" };
  return { url: u.toString() };
}

// ── H9 ────────────────────────────────────────────────────────────────────────

export interface Suggestion { ticker: string; rationale: string; uncertainty: string }
const CERTAINTY = /\b(guarantee[ds]?|certain(ly)?|sure (thing|bet)|can't lose|risk[- ]free|will (rise|go up|double))\b/i;
const HOLDS = /\b(you (own|hold|have)|your (position|holding|shares))\b/i;

/** H9: at most five suggestions, each with a rationale and an uncertainty note, and no certainty or
 *  inferred-holdings language. */
export function validateSuggestions(list: readonly Suggestion[]): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (list.length > 5) errors.push("at most 5 suggestions");
  list.forEach((s, i) => {
    if (!isTicker(s.ticker)) errors.push(`${i}: invalid ticker`);
    if (!s.rationale?.trim()) errors.push(`${i}: rationale is required`);
    if (!s.uncertainty?.trim()) errors.push(`${i}: uncertainty note is required`);
    const text = `${s.rationale} ${s.uncertainty}`;
    if (CERTAINTY.test(text)) errors.push(`${i}: states certainty`);
    if (HOLDS.test(text)) errors.push(`${i}: assumes the user holds it`);
  });
  return errors.length ? { ok: false, errors } : { ok: true };
}
