/**
 * attribution — the pure first-party acquisition-attribution model, shared by
 * the web portal and (mirrored) by gcp3-mobile. No I/O here.
 *
 * docs/todo-auth-cookies-tracking.md Phase 4.1. This is deliberately the FIRST
 * attribution work because it is entirely first-party: UTM params, click ids
 * and the referrer the browser already sent us, stored in our own `nu_attrib`
 * cookie. No third-party pixel, no ad-platform SDK. It belongs to the
 * `analytics` consent category, NOT `marketing` — nothing is shared with anyone.
 *
 * Persistence:
 *   - `nu_attrib` first-party cookie (90 days), first-touch only — never
 *     overwritten once set, so the original acquisition source survives later
 *     visits.
 *   - `user_attribution` Neon row written once at first authenticated load,
 *     capturing first-touch (from the cookie) + last-touch (current visit).
 */

export const ATTRIB_COOKIE = "nu_attrib";
export const ATTRIB_COOKIE_MAX_AGE = 60 * 60 * 24 * 90; // 90 days
export const ATTRIB_VERSION = "1.0";

export const UTM_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;
export const CLICK_ID_PARAMS = ["gclid", "fbclid"] as const;

export type UtmParam = (typeof UTM_PARAMS)[number];
export type ClickIdParam = (typeof CLICK_ID_PARAMS)[number];

export interface AttributionTouch {
  v: string;
  utm: Partial<Record<UtmParam, string>>;
  click_ids: Partial<Record<ClickIdParam, string>>;
  referrer: string | null;
  landing_path: string | null;
  /** ISO 8601, set by whoever captures the touch. */
  ts: string;
}

const MAX_VALUE_LEN = 256;

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_VALUE_LEN);
}

/** Drop a same-origin referrer — internal navigation is not acquisition. */
export function normaliseReferrer(
  referrer: string | null | undefined,
  selfHost?: string,
): string | null {
  const r = clean(referrer);
  if (!r) return null;
  try {
    const host = new URL(r).host;
    if (selfHost && host === selfHost) return null;
  } catch {
    return null; // not a URL — ignore
  }
  return r;
}

/**
 * Build an AttributionTouch from a URL's query string plus optional referrer /
 * landing path. Returns null when there is nothing attributable at all (no UTM,
 * no click id, no external referrer) — an organic direct visit gets no row.
 */
export function buildTouch(
  params: URLSearchParams,
  opts: {
    referrer?: string | null;
    landingPath?: string | null;
    selfHost?: string;
    now?: Date;
  } = {},
): AttributionTouch | null {
  const utm: Partial<Record<UtmParam, string>> = {};
  for (const key of UTM_PARAMS) {
    const v = clean(params.get(key));
    if (v) utm[key] = v;
  }

  const clickIds: Partial<Record<ClickIdParam, string>> = {};
  for (const key of CLICK_ID_PARAMS) {
    const v = clean(params.get(key));
    if (v) clickIds[key] = v;
  }

  const referrer = normaliseReferrer(opts.referrer, opts.selfHost);
  const landingPath = clean(opts.landingPath);

  const hasSomething =
    Object.keys(utm).length > 0 || Object.keys(clickIds).length > 0 || referrer !== null;
  if (!hasSomething) return null;

  return {
    v: ATTRIB_VERSION,
    utm,
    click_ids: clickIds,
    referrer,
    landing_path: landingPath,
    ts: (opts.now ?? new Date()).toISOString(),
  };
}

export function serialiseTouch(touch: AttributionTouch): string {
  return JSON.stringify(touch);
}

export function parseTouch(raw: string | null | undefined): AttributionTouch | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<AttributionTouch>;
    if (!o || typeof o !== "object" || o.v !== ATTRIB_VERSION) return null;
    return {
      v: ATTRIB_VERSION,
      utm: (o.utm ?? {}) as Partial<Record<UtmParam, string>>,
      click_ids: (o.click_ids ?? {}) as Partial<Record<ClickIdParam, string>>,
      referrer: typeof o.referrer === "string" ? o.referrer : null,
      landing_path: typeof o.landing_path === "string" ? o.landing_path : null,
      ts: typeof o.ts === "string" ? o.ts : new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}
