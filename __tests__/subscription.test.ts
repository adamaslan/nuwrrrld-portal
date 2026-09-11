import { describe, expect, it } from "vitest";
import {
  hasEntitlement,
  isTrialExpired,
  parseSubscriptionMetadata,
  tierFromStatus,
  type Feature,
  type SubscriptionStatus,
} from "@/lib/subscription";

describe("tierFromStatus", () => {
  it.each([
    ["active", "pro"],
    ["trialing", "pro"],
    ["past_due", "pro"],
    ["canceled", "free"],
    ["paused", "free"],
    ["free", "free"],
  ] as [SubscriptionStatus, "pro" | "free"][])("%s -> %s", (status, expected) => {
    expect(tierFromStatus(status)).toBe(expected);
  });
});

describe("hasEntitlement", () => {
  const freeFeatures: Feature[] = ["signals", "portfolio_score"];
  const proFeatures: Feature[] = [
    "signals_digest",
    "nu_ai",
    "portfolio_suggestions",
    "watchlist_alerts",
    "morning_briefing",
    "advanced_ai",
    "pro_signals",
    "faster_data",
  ];

  it.each(freeFeatures)("free tier can access %s", (feature) => {
    expect(hasEntitlement(feature, "free")).toBe(true);
  });

  it.each(proFeatures)("free tier cannot access %s", (feature) => {
    expect(hasEntitlement(feature, "free")).toBe(false);
  });

  it.each([...freeFeatures, ...proFeatures])("pro tier can access %s", (feature) => {
    expect(hasEntitlement(feature, "pro")).toBe(true);
  });
});

describe("isTrialExpired", () => {
  it("returns false when trial_end is undefined", () => {
    expect(isTrialExpired(undefined)).toBe(false);
  });

  it("returns false for a future trial_end", () => {
    const future = Date.now() / 1000 + 3600;
    expect(isTrialExpired(future)).toBe(false);
  });

  it("returns true for a past trial_end", () => {
    const past = Date.now() / 1000 - 3600;
    expect(isTrialExpired(past)).toBe(true);
  });
});

describe("parseSubscriptionMetadata", () => {
  it("defaults to free when metadata is null/undefined", () => {
    expect(parseSubscriptionMetadata(null)).toMatchObject({ status: "free", tier: "free" });
    expect(parseSubscriptionMetadata(undefined)).toMatchObject({ status: "free", tier: "free" });
  });

  it("defaults to free when subscription_status is missing", () => {
    const result = parseSubscriptionMetadata({});
    expect(result.status).toBe("free");
    expect(result.tier).toBe("free");
  });

  it("falls back to free for an unrecognized status string", () => {
    const result = parseSubscriptionMetadata({ subscription_status: "not_a_real_status" });
    expect(result.status).toBe("free");
    expect(result.tier).toBe("free");
  });

  it("parses a valid active status into the pro tier", () => {
    const result = parseSubscriptionMetadata({ subscription_status: "active" });
    expect(result.status).toBe("active");
    expect(result.tier).toBe("pro");
  });

  it("converts a numeric trial_end into an ISO string", () => {
    const seconds = 1_800_000_000;
    const result = parseSubscriptionMetadata({ subscription_status: "trialing", trial_end: seconds });
    expect(result.trialEnd).toBe(new Date(seconds * 1000).toISOString());
  });

  it("ignores a non-numeric trial_end instead of throwing", () => {
    const result = parseSubscriptionMetadata({ subscription_status: "trialing", trial_end: "not-a-number" });
    expect(result.trialEnd).toBeUndefined();
  });

  it("ignores an out-of-range numeric trial_end instead of throwing a RangeError", () => {
    const result = parseSubscriptionMetadata({ subscription_status: "trialing", trial_end: 1e100 });
    expect(result.trialEnd).toBeUndefined();
  });

  it("preserves a zero trial_end instead of treating it as falsy", () => {
    const result = parseSubscriptionMetadata({ subscription_status: "trialing", trial_end: 0 });
    expect(result.trialEnd).toBe(new Date(0).toISOString());
  });

  it("does not surface trialEnd for a non-trialing status even if trial_end is present", () => {
    const result = parseSubscriptionMetadata({ subscription_status: "active", trial_end: 1_800_000_000 });
    expect(result.status).toBe("active");
    expect(result.trialEnd).toBeUndefined();
  });
});
