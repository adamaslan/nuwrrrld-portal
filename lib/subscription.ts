/**
 * Subscription state — single-sourced for app and web.
 * Both surfaces import from here; neither defines its own copy.
 */

export type SubscriptionStatus =
  | 'free'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'paused';

export type SubscriptionTier = 'free' | 'pro';

/** All features that can be gated. Add new ones here when introducing tiers. */
export type Feature =
  | 'signals'
  | 'signals_digest'
  | 'nu_ai'
  | 'portfolio_score'
  | 'portfolio_suggestions'
  | 'watchlist_alerts'
  | 'morning_briefing'
  | 'advanced_ai'
  | 'pro_signals'
  | 'faster_data';

/** Declarative map: feature → minimum tier required. */
const FEATURE_TIER_MAP: Record<Feature, SubscriptionTier> = {
  signals: 'free',
  signals_digest: 'pro',
  nu_ai: 'pro',
  portfolio_score: 'free',
  portfolio_suggestions: 'pro',
  watchlist_alerts: 'pro',
  morning_briefing: 'pro',
  advanced_ai: 'pro',
  pro_signals: 'pro',
  faster_data: 'pro',
};

const TIER_RANK: Record<SubscriptionTier, number> = { free: 0, pro: 1 };

/**
 * The shape stored in Clerk user public metadata.
 * Keys must match exactly what the Stripe webhook writes — prefixed with
 * `subscription_` to avoid collisions with other Clerk metadata.
 */
export interface SubscriptionMetadata {
  stripe_customer_id: string;
  stripe_subscription_id?: string;
  subscription_status: SubscriptionStatus;
  subscription_tier: SubscriptionTier;
  /** Unix timestamp seconds — from Stripe trial_end field. */
  trial_end?: number;
  current_period_end?: number;
}

/** Minimal subscription context passed through the app. */
export interface SubscriptionState {
  status: SubscriptionStatus;
  tier: SubscriptionTier;
  /** ISO string; undefined when not trialing. */
  trialEnd?: string;
  isLoading: boolean;
}

export const DEFAULT_SUBSCRIPTION_STATE: SubscriptionState = {
  status: 'free',
  tier: 'free',
  isLoading: false,
};

/**
 * Check whether a given tier satisfies a feature requirement.
 * Single gating function used everywhere — future tier changes are one-line edits here.
 */
export function hasEntitlement(feature: Feature, tier: SubscriptionTier): boolean {
  const required = FEATURE_TIER_MAP[feature];
  return TIER_RANK[tier] >= TIER_RANK[required];
}

/**
 * Derive the effective tier from a Stripe subscription status.
 * A trialing user gets pro access; past_due retains access; canceled/free gets nothing.
 */
export function tierFromStatus(status: SubscriptionStatus): SubscriptionTier {
  switch (status) {
    case 'active':
    case 'trialing':
    case 'past_due':
      return 'pro';
    default:
      return 'free';
  }
}

/**
 * Returns true if trial has lapsed based on Stripe's trial_end timestamp.
 * Always derived from Stripe's field, never a local timer.
 */
export function isTrialExpired(trialEndSeconds: number | undefined): boolean {
  if (!trialEndSeconds) return false;
  return Date.now() / 1000 > trialEndSeconds;
}

const VALID_STATUSES: readonly SubscriptionStatus[] = [
  'free',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'paused',
];

function isSubscriptionStatus(value: unknown): value is SubscriptionStatus {
  return typeof value === 'string' && (VALID_STATUSES as readonly string[]).includes(value);
}

/**
 * Parse Clerk `publicMetadata` into a SubscriptionState, tolerating malformed
 * or partially-written metadata (e.g. a hand-edited `clerk api PATCH`, or a
 * webhook write that landed mid-migration). Unrecognized status strings and
 * non-numeric timestamps degrade to the safe default rather than propagating
 * garbage — this is the single place all 5 call sites should read metadata
 * through instead of ad-hoc `as` casts.
 */
export function parseSubscriptionMetadata(
  raw: Record<string, unknown> | null | undefined,
): SubscriptionState {
  const rawStatus = raw?.subscription_status;
  const status = isSubscriptionStatus(rawStatus) ? rawStatus : 'free';

  const rawTrialEnd = raw?.trial_end;
  const trialEndSeconds =
    typeof rawTrialEnd === 'number' && Number.isFinite(rawTrialEnd) ? rawTrialEnd : undefined;

  // Only serialize trialEnd while actually trialing (matches the
  // SubscriptionState contract: "undefined when not trialing") — a stale
  // trial_end left over from a prior trial shouldn't resurface once a user
  // has converted, lapsed, or canceled. Number.isFinite alone doesn't rule
  // out values outside the Date range (e.g. 1e100), which throw a
  // RangeError from toISOString() — validate the constructed Date itself.
  let trialEnd: string | undefined;
  if (status === 'trialing' && trialEndSeconds !== undefined) {
    const date = new Date(trialEndSeconds * 1000);
    trialEnd = Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }

  return {
    status,
    tier: tierFromStatus(status),
    trialEnd,
    isLoading: false,
  };
}

/** Trial duration in days. */
export const TRIAL_DAYS = 7;
