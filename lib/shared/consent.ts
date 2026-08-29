/**
 * consent — the pure consent model shared by the web portal and (mirrored) by
 * gcp3-mobile. Nothing here does I/O. Persistence lives in:
 *   - the `nu_consent` first-party cookie (client + server read; see lib/consent.ts)
 *   - the `consent_records` Neon table for signed-in users (lib/consent-db.ts)
 *   - lib/shared/prefs.ts on mobile (expo-secure-store)
 *
 * Design rules baked in here, straight from docs/todo-auth-cookies-tracking.md §2:
 *   - Four categories. `strictly_necessary` is always on and cannot be refused.
 *     Every other category defaults to DENIED until the user chooses.
 *   - "Reject all" must be exactly as reachable as "Accept all": both are a
 *     single call to buildConsent(). No pre-ticked state anywhere.
 *   - We apply the strictest regime globally — there is no geo branch. A GPC or
 *     DNT signal is an automatic opt-out of `analytics` + `marketing`.
 *   - The stored value is versioned. A bump to CONSENT_VERSION invalidates every
 *     prior record and re-prompts, the same way DISCLAIMER_HASH does.
 */

export const CONSENT_VERSION = "1.0";
export const CONSENT_LAST_UPDATED = "2026-08-29";

/** First-party cookie name. Not HttpOnly — client tag-gating must read it. */
export const CONSENT_COOKIE = "nu_consent";

/** ~13 months, the common cap for consent cookies under EU guidance. */
export const CONSENT_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;

export const CONSENT_CATEGORIES = [
  "strictly_necessary",
  "preferences",
  "analytics",
  "marketing",
] as const;

export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/** The four categories the user can (mostly) toggle. */
export type ConsentChoices = Record<ConsentCategory, boolean>;

export interface ConsentRecord {
  v: string; // CONSENT_VERSION at the time of the choice
  choices: ConsentChoices;
  /** How the choice was made — for the audit trail and UX ("we're honoring your browser setting"). */
  source: "banner_accept_all" | "banner_reject_all" | "preferences" | "gpc" | "dnt" | "default";
  /** ISO 8601. Set by whoever persists the record. */
  ts: string;
}

/** What every category is until the user decides. Necessary on, rest off. */
export const DEFAULT_CHOICES: ConsentChoices = {
  strictly_necessary: true,
  preferences: false,
  analytics: false,
  marketing: false,
};

/** Human-facing copy for the preferences modal. Keep vendor names accurate. */
export const CATEGORY_INFO: Record<
  ConsentCategory,
  { label: string; required: boolean; description: string }
> = {
  strictly_necessary: {
    label: "Strictly necessary",
    required: true,
    description:
      "Keeps you signed in (Clerk session cookies) and protects forms against cross-site request forgery. The site does not work without these, so they cannot be turned off.",
  },
  preferences: {
    label: "Preferences",
    required: false,
    description:
      "Remembers choices you make — theme, watchlist view mode, and email digest frequency — so they persist between visits.",
  },
  analytics: {
    label: "Analytics",
    required: false,
    description:
      "Lets us measure which features are used and where people get stuck, using privacy-respecting product analytics. Events are keyed to a pseudonymous account id and never include your holdings or AI prompts.",
  },
  marketing: {
    label: "Marketing",
    required: false,
    description:
      "Allows conversion measurement and advertising tags (e.g. Meta, Google) so we can tell which campaigns bring in subscribers. No audiences are ever built from your portfolio or financial behavior.",
  },
};

/**
 * Build a complete ConsentRecord from a partial set of desired category values.
 * `strictly_necessary` is always forced on; anything unspecified stays denied.
 * This is the single constructor — "accept all" and "reject all" both call it,
 * which is what keeps them symmetric.
 */
export function buildConsent(
  desired: Partial<ConsentChoices>,
  source: ConsentRecord["source"],
  now: Date = new Date(),
): ConsentRecord {
  return {
    v: CONSENT_VERSION,
    choices: {
      strictly_necessary: true,
      preferences: desired.preferences ?? false,
      analytics: desired.analytics ?? false,
      marketing: desired.marketing ?? false,
    },
    source,
    ts: now.toISOString(),
  };
}

export function acceptAll(now?: Date): ConsentRecord {
  return buildConsent(
    { preferences: true, analytics: true, marketing: true },
    "banner_accept_all",
    now,
  );
}

export function rejectAll(now?: Date): ConsentRecord {
  return buildConsent({}, "banner_reject_all", now);
}

/**
 * Apply a Global Privacy Control / Do Not Track signal. Both force `analytics`
 * and `marketing` off regardless of any prior choice; `preferences` is left
 * untouched (it is not cross-context tracking). California treats GPC as a
 * legally binding opt-out, so this is not optional.
 */
export function applyDoNotTrack(
  base: ConsentRecord | null,
  signal: "gpc" | "dnt",
  now?: Date,
): ConsentRecord {
  const keepPrefs = base?.choices.preferences ?? false;
  return buildConsent({ preferences: keepPrefs }, signal, now);
}

/** Has the user made any choice at all under the current version? */
export function needsPrompt(record: ConsentRecord | null): boolean {
  if (!record) return true;
  if (record.v !== CONSENT_VERSION) return true;
  return false;
}

export function isAllowed(
  record: ConsentRecord | null,
  category: ConsentCategory,
): boolean {
  if (category === "strictly_necessary") return true;
  if (!record || record.v !== CONSENT_VERSION) return false;
  return record.choices[category] === true;
}

/** Serialize for the cookie value. Compact, URL-safe after encodeURIComponent. */
export function serializeConsent(record: ConsentRecord): string {
  return JSON.stringify(record);
}

/**
 * Parse a cookie value back to a ConsentRecord. Returns null on anything
 * malformed or shape-invalid — the caller then treats the user as un-prompted,
 * which fails safe (no non-necessary category is allowed).
 */
export function parseConsent(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.v !== "string" || typeof o.ts !== "string") return null;
  const c = o.choices;
  if (typeof c !== "object" || c === null) return null;
  const cc = c as Record<string, unknown>;
  for (const cat of CONSENT_CATEGORIES) {
    if (typeof cc[cat] !== "boolean") return null;
  }
  const validSources: ConsentRecord["source"][] = [
    "banner_accept_all",
    "banner_reject_all",
    "preferences",
    "gpc",
    "dnt",
    "default",
  ];
  const source = validSources.includes(o.source as ConsentRecord["source"])
    ? (o.source as ConsentRecord["source"])
    : "default";
  return {
    v: o.v,
    ts: o.ts,
    source,
    choices: {
      strictly_necessary: true, // never trust a stored `false` here
      preferences: cc.preferences === true,
      analytics: cc.analytics === true,
      marketing: cc.marketing === true,
    },
  };
}
