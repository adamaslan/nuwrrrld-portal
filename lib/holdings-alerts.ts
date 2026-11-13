/**
 * Pure signal-change detection for a user's holdings or watchlist.
 *
 * Given the signal each ticker had last time and the signal it has now, return
 * the changes worth telling the user about. No database, no delivery channel,
 * no network: storage of the previous snapshot and the delivery of the result
 * are separate pieces (they need a migration and a send path) and are not
 * decided here. This module only answers "what changed, and is it trustworthy
 * enough to say so".
 *
 * Fail-closed rules, each covered by a test:
 *  - a ticker seen for the first time produces nothing (no baseline, no change);
 *  - a stale or unknown-quality current signal produces nothing;
 *  - a current signal that is not newer than the previous one produces nothing;
 *  - only tickers the user holds are considered.
 */
import { normalizeTicker } from "@/lib/shared/signal-policy";
import { hasEntitlement, type SubscriptionTier } from "@/lib/subscription";

export type AlertDirection = "bullish" | "bearish" | "neutral";

export interface SignalSnapshot {
  ticker: string;
  direction: AlertDirection;
  /** ISO timestamp the signal was generated. */
  generatedAt: string;
  isStale: boolean;
  dataQualityScore?: "fresh" | "stale" | "unknown";
}

export type AlertKind = "reversed" | "turned" | "faded";

export interface HoldingsAlert {
  /** Stable key for idempotent delivery: same change, same key. */
  key: string;
  ticker: string;
  kind: AlertKind;
  from: AlertDirection;
  to: AlertDirection;
  /** generatedAt of the current signal. */
  asOf: string;
  message: string;
}

export const DEFAULT_MAX_ALERTS = 20;

const KIND_PRIORITY: Record<AlertKind, number> = { reversed: 0, turned: 1, faded: 2 };

export function canReceiveHoldingsAlerts(tier: SubscriptionTier): boolean {
  return hasEntitlement("watchlist_alerts", tier);
}

function classify(from: AlertDirection, to: AlertDirection): AlertKind | null {
  if (from === to) return null;
  if (to === "neutral") return "faded";
  if (from === "neutral") return "turned";
  return "reversed";
}

function describe(ticker: string, kind: AlertKind, from: AlertDirection, to: AlertDirection): string {
  switch (kind) {
    case "reversed":
      return `$${ticker}: the signal moved from ${from} to ${to}.`;
    case "turned":
      return `$${ticker}: the signal turned ${to}, from neutral.`;
    case "faded":
      return `$${ticker}: the ${from} signal faded to neutral.`;
  }
}

function isTrustworthy(s: SignalSnapshot): boolean {
  if (s.isStale) return false;
  if (s.dataQualityScore === "stale" || s.dataQualityScore === "unknown") return false;
  return Number.isFinite(Date.parse(s.generatedAt));
}

function indexByTicker(snapshots: readonly SignalSnapshot[]): Map<string, SignalSnapshot> {
  const out = new Map<string, SignalSnapshot>();
  for (const s of snapshots) {
    const t = normalizeTicker(s.ticker);
    if (!t) continue;
    const existing = out.get(t);
    // If a ticker appears twice, keep the newest.
    if (!existing || Date.parse(s.generatedAt) > Date.parse(existing.generatedAt)) out.set(t, s);
  }
  return out;
}

export function detectHoldingsAlerts(input: {
  holdings: readonly string[];
  previous: readonly SignalSnapshot[];
  current: readonly SignalSnapshot[];
  maxAlerts?: number;
}): HoldingsAlert[] {
  const max = Math.max(0, input.maxAlerts ?? DEFAULT_MAX_ALERTS);
  const held = new Set<string>();
  for (const h of input.holdings) {
    const t = normalizeTicker(h);
    if (t) held.add(t);
  }
  const prev = indexByTicker(input.previous);
  const curr = indexByTicker(input.current);

  const alerts: HoldingsAlert[] = [];
  for (const ticker of held) {
    const before = prev.get(ticker);
    const now = curr.get(ticker);
    if (!before || !now) continue;
    if (!isTrustworthy(now)) continue;
    if (Date.parse(now.generatedAt) <= Date.parse(before.generatedAt)) continue;
    const kind = classify(before.direction, now.direction);
    if (!kind) continue;
    alerts.push({
      key: `${ticker}:${before.direction}>${now.direction}:${now.generatedAt}`,
      ticker,
      kind,
      from: before.direction,
      to: now.direction,
      asOf: now.generatedAt,
      message: describe(ticker, kind, before.direction, now.direction),
    });
  }

  alerts.sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.ticker.localeCompare(b.ticker),
  );
  return alerts.slice(0, max);
}
