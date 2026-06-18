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

/** Trial duration in days. */
export const TRIAL_DAYS = 7;
