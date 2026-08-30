/**
 * analytics — the consent-gated event sink.
 *
 * docs/analytics-event-taxonomy.md is the contract; this enforces it. There is
 * NO vendor attached yet: `track()` validates the event against EVENT_SCHEMA
 * and then drops it. Phase 3.1 (pick a vendor, sign a DPA) turns the drop into
 * a real send inside `deliver()`. Building the interface and the taxonomy first
 * means the vendor swap is one function, not a retrofit across every call site.
 *
 * Guarantees, straight from the taxonomy:
 *   - No event is emitted unless `analytics` consent is granted. The caller
 *     passes the resolved consent; a GPC/DNT signal has already forced it off
 *     upstream (lib/consent.ts resolveConsent).
 *   - Unknown event names, unknown properties, and forbidden keys are rejected
 *     in dev (throw) and dropped in prod (logged once), so a typo never
 *     silently ships a malformed event.
 *   - Identity is the Clerk user_id only. There is no parameter for anything
 *     else.
 */
import type { ConsentRecord } from "@/lib/shared/consent";

type PropType = "string" | "int" | "enum";

interface PropSpec {
  type: PropType;
  values?: readonly string[];
  optional?: boolean;
}

/** The allowed events and their property shapes. Mirror of the taxonomy doc. */
export const EVENT_SCHEMA = {
  signal_viewed: {
    ticker: { type: "string" },
    horizon: { type: "enum", values: ["intraday", "short", "medium", "long"] },
    direction: { type: "enum", values: ["bullish", "bearish", "neutral"], optional: true },
  },
  signal_shared: {
    ticker: { type: "string" },
    surface: { type: "enum", values: ["card", "link"] },
  },
  verdict_requested: {
    ticker: { type: "string" },
    horizon: { type: "enum", values: ["intraday", "short", "medium", "long"] },
  },
  council_session_started: {
    ticker: { type: "string", optional: true },
    seat_count: { type: "int" },
  },
  nuai_prompt_submitted: {
    prompt_len_bucket: { type: "enum", values: ["0-100", "100-500", "500+"] },
  },
  watchlist_item_added: {
    ticker: { type: "string" },
    watchlist_size_after: { type: "int" },
  },
  portfolio_health_run: {
    holdings_count_bucket: { type: "enum", values: ["0", "1-5", "6-15", "16+"] },
  },
  backtest_viewed: {
    ticker: { type: "string" },
    range: { type: "string" },
  },
  paywall_hit: {
    feature: { type: "string" },
    plan: { type: "enum", values: ["free", "monthly", "annual"] },
  },
  trial_started: {
    plan: { type: "enum", values: ["free", "monthly", "annual"] },
  },
  subscription_started: {
    plan: { type: "enum", values: ["free", "monthly", "annual"] },
    value: { type: "int" },
  },
  referral_code_copied: {},
  disclaimer_acknowledged: {
    surface: { type: "enum", values: ["web", "mobile"] },
    version: { type: "string" },
  },
} as const satisfies Record<string, Record<string, PropSpec>>;

export type EventName = keyof typeof EVENT_SCHEMA;

/**
 * Keys that must never appear in a payload, whatever the event. This is the
 * line between "product analytics" and "we shipped our users' portfolios to a
 * vendor" — enforced here rather than trusted to call sites.
 */
const FORBIDDEN_KEYS = new Set([
  "holdings",
  "positions",
  "position_size",
  "amount",
  "dollar_amount",
  "portfolio_value",
  "prompt",
  "prompt_text",
  "response",
  "email",
  "name",
  "ip",
]);

let warnedInProd = false;

function reject(reason: string): void {
  if (process.env.NODE_ENV !== "production") {
    throw new Error(`analytics.track: ${reason}`);
  }
  if (!warnedInProd) {
    console.error("analytics.track dropped a malformed event: %s", reason);
    warnedInProd = true;
  }
}

function validate(event: string, props: Record<string, unknown>): boolean {
  if (!(event in EVENT_SCHEMA)) {
    reject(`unknown event "${event}"`);
    return false;
  }
  const spec = EVENT_SCHEMA[event as EventName] as Record<string, PropSpec>;

  for (const key of Object.keys(props)) {
    if (FORBIDDEN_KEYS.has(key)) {
      reject(`forbidden property "${key}" on "${event}"`);
      return false;
    }
    if (!(key in spec)) {
      reject(`unknown property "${key}" on "${event}"`);
      return false;
    }
  }
  for (const [key, ps] of Object.entries(spec)) {
    const v = props[key];
    if (v === undefined || v === null) {
      if (ps.optional) continue;
      reject(`missing property "${key}" on "${event}"`);
      return false;
    }
    if (ps.type === "int" && (typeof v !== "number" || !Number.isInteger(v))) {
      reject(`property "${key}" must be an integer`);
      return false;
    }
    if ((ps.type === "string" || ps.type === "enum") && typeof v !== "string") {
      reject(`property "${key}" must be a string`);
      return false;
    }
    if (ps.type === "enum" && ps.values && !ps.values.includes(v as string)) {
      reject(`property "${key}"="${String(v)}" not in [${ps.values.join(", ")}]`);
      return false;
    }
  }
  return true;
}

/**
 * The only sink. No vendor yet — this is where Phase 3.1 plugs one in.
 * Deliberately swallows everything: analytics delivery must never surface to
 * the caller.
 */
function deliver(_userId: string, _event: EventName, _props: Record<string, unknown>): void {
  // Phase 3.1: e.g. posthog.capture({ distinctId: _userId, event: _event,
  // properties: _props }) against the EU cloud instance. Until then: drop.
}

export interface TrackArgs {
  userId: string;
  event: EventName;
  props?: Record<string, unknown>;
  consent: ConsentRecord | null;
}

/**
 * Record one product-analytics event. Returns false (no-op) when analytics
 * consent is not granted or the event fails taxonomy validation.
 */
export function track({ userId, event, props = {}, consent }: TrackArgs): boolean {
  if (!consent?.choices.analytics) return false;
  if (!validate(event, props)) return false;
  deliver(userId, event, props);
  return true;
}
