import { describe, it, expect } from "vitest";
import { track, EVENT_SCHEMA } from "@/lib/analytics";
import { buildConsent } from "@/lib/shared/consent";

const granted = buildConsent({ analytics: true }, "preferences");
const denied = buildConsent({ analytics: false }, "banner_reject_all");

describe("track — consent gate", () => {
  it("no-ops without analytics consent", () => {
    expect(track({ userId: "u1", event: "referral_code_copied", consent: denied })).toBe(false);
    expect(track({ userId: "u1", event: "referral_code_copied", consent: null })).toBe(false);
  });

  it("accepts a valid event when consent is granted", () => {
    expect(
      track({
        userId: "u1",
        event: "signal_viewed",
        props: { ticker: "NVDA", horizon: "short" },
        consent: granted,
      }),
    ).toBe(true);
  });

  it("the consent gate runs before validation — a bad event still no-ops silently", () => {
    expect(() =>
      track({ userId: "u1", event: "made_up" as never, consent: denied }),
    ).not.toThrow();
  });
});

describe("track — taxonomy validation (throws in non-prod)", () => {
  it("rejects an unknown event", () => {
    expect(() => track({ userId: "u1", event: "made_up_event" as never, consent: granted })).toThrow(
      /unknown event/,
    );
  });

  it("rejects an unknown property", () => {
    expect(() =>
      track({
        userId: "u1",
        event: "signal_viewed",
        props: { ticker: "NVDA", horizon: "short", extra: 1 },
        consent: granted,
      }),
    ).toThrow(/unknown property/);
  });

  it("rejects a forbidden property outright", () => {
    expect(() =>
      track({
        userId: "u1",
        event: "portfolio_health_run",
        props: { holdings_count_bucket: "1-5", holdings: ["AAPL"] },
        consent: granted,
      }),
    ).toThrow(/forbidden property "holdings"/);
  });

  it("rejects every forbidden key, not just holdings", () => {
    for (const key of ["prompt", "email", "portfolio_value", "position_size"]) {
      expect(() =>
        track({
          userId: "u1",
          event: "referral_code_copied",
          props: { [key]: "x" },
          consent: granted,
        }),
      ).toThrow(/forbidden property/);
    }
  });

  it("rejects a bad enum value", () => {
    expect(() =>
      track({
        userId: "u1",
        event: "signal_viewed",
        props: { ticker: "NVDA", horizon: "yearly" },
        consent: granted,
      }),
    ).toThrow(/not in \[/);
  });

  it("rejects a missing required property", () => {
    expect(() =>
      track({ userId: "u1", event: "signal_viewed", props: { ticker: "NVDA" }, consent: granted }),
    ).toThrow(/missing property "horizon"/);
  });

  it("rejects a non-integer int property", () => {
    expect(() =>
      track({
        userId: "u1",
        event: "watchlist_item_added",
        props: { ticker: "NVDA", watchlist_size_after: 3.5 },
        consent: granted,
      }),
    ).toThrow(/must be an integer/);
  });

  it("allows an omitted optional property", () => {
    expect(
      track({
        userId: "u1",
        event: "council_session_started",
        props: { seat_count: 3 },
        consent: granted,
      }),
    ).toBe(true);
  });
});

it("EVENT_SCHEMA matches the documented taxonomy", () => {
  expect(Object.keys(EVENT_SCHEMA).sort()).toEqual([
    "backtest_viewed",
    "council_session_started",
    "disclaimer_acknowledged",
    "nuai_prompt_submitted",
    "paywall_hit",
    "portfolio_health_run",
    "referral_code_copied",
    "signal_shared",
    "signal_viewed",
    "subscription_started",
    "trial_started",
    "verdict_requested",
    "watchlist_item_added",
  ]);
});
