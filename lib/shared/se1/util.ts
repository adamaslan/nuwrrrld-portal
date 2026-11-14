/**
 * se1/util — small pure helpers shared by the se1 track modules. No I/O.
 */

export const DAY_MS = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch ms for a strict ISO date (YYYY-MM-DD, read as UTC midnight) or ISO timestamp with a zone; else null. */
export function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  if (!ISO_DATE.test(value) && !ISO_STAMP.test(value)) return null;
  const t = Date.parse(ISO_DATE.test(value) ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(t)) return null;
  // Reject calendar overflow such as 2026-02-31, which Date.parse silently rolls forward.
  if (new Date(t).toISOString().slice(0, 10) !== value.slice(0, 10) && ISO_DATE.test(value)) return null;
  return t;
}

/** Whole days from a to b (b - a), or null when either date is invalid. */
export function daysBetween(a: string, b: string): number | null {
  const ta = parseIso(a);
  const tb = parseIso(b);
  if (ta === null || tb === null) return null;
  return Math.floor((tb - ta) / DAY_MS);
}

const TICKER_RE = /^[A-Z0-9.\-]{1,10}$/;

export function isTicker(value: unknown): value is string {
  return typeof value === "string" && TICKER_RE.test(value);
}

/** Non-empty identifier without whitespace or control characters. */
export function isId(value: unknown, max = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:\-]+$/.test(value);
}

/** 32-bit FNV-1a over a string, as 8 hex characters. Deterministic, not a security hash. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** JSON with object keys sorted at every depth, so equal values give equal strings. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Pearson correlation of two equal-length finite series; null when too short, mismatched, non-finite or flat. */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length || a.length < 3) return null;
  if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) return null;
  const n = a.length;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

/** YYYY-MM-DD of an instant in an IANA time zone, or null for an invalid date or zone. */
export function localDate(at: Date, timeZone: string): string | null {
  if (!Number.isFinite(at.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return null;
  }
}

export function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/** Strip control characters and collapse whitespace in free text before it reaches a surface. */
export function cleanText(text: string, max = 500): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
