/**
 * The universe-hydration constants must be identical across every compute host
 * (Phase 2.2 of docs/signal-engine-three-phase-plan.md). The values live in
 * lib/shared/hydration-constants.json; the .ts and .mjs files only re-expose
 * them. This test fails if anyone hand-edits one view without the JSON, and
 * pins the agreed values so a change to them is a deliberate, reviewed diff.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import json from "@/lib/shared/hydration-constants.json";
import * as ts from "@/lib/shared/hydration-constants";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs sibling, no type declarations
import * as mjs from "@/lib/shared/hydration-constants.mjs";

const KEYS = [
  "LOOKBACK_DAYS",
  "CHUNK_SIZE",
  "ALPACA_FEED",
  "ALPACA_ADJUSTMENT",
  "MIN_BARS",
  "MIN_COVERAGE_RATIO",
  "ALPACA_PAGE_LIMIT",
  "FETCH_CHUNK_SIZE",
  "SIP_DELAY_MINUTES",
] as const;

describe("hydration constants are single-sourced", () => {
  it.each(KEYS)("%s agrees across json, .ts and .mjs", (key) => {
    expect((ts as Record<string, unknown>)[key]).toBe((json as Record<string, unknown>)[key]);
    expect((mjs as Record<string, unknown>)[key]).toBe((json as Record<string, unknown>)[key]);
  });

  it("holds the Phase 2.2 agreed values", () => {
    expect(json.LOOKBACK_DAYS).toBe(365);
    expect(json.CHUNK_SIZE).toBe(35);
    expect(json.ALPACA_FEED).toBe("sip");
    expect(json.ALPACA_ADJUSTMENT).toBe("split");
    expect(json.MIN_BARS).toBe(40);
    expect(json.MIN_COVERAGE_RATIO).toBe(0.95);
  });

  it("CHUNK_SIZE * ~one trading year still fits one Alpaca page", () => {
    // ~252 sessions/yr; the point of 35 is that 35 * 252 < the 10k-bar cap.
    expect(json.CHUNK_SIZE * 252).toBeLessThan(json.ALPACA_PAGE_LIMIT);
  });
});

// Modal cannot import the JS module; verify its deployed Python constants and
// request wiring against the same source rather than trusting local-only parity.
describe("Modal hydration request parity", () => {
  const source = readFileSync("deploy/universe-hydration/modal_app.py", "utf8");
  it.each(["CHUNK_SIZE", "LOOKBACK_DAYS", "MIN_COVERAGE_RATIO", "ALPACA_FEED", "ALPACA_ADJUSTMENT", "ALPACA_PAGE_LIMIT", "SIP_DELAY_MINUTES"] as const)("%s matches shared configuration", (key) => {
    const literal = source.match(new RegExp(`^${key} = (.+)$`, "m"))?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal!.replaceAll("_", ""))).toBe(json[key]);
  });
  it("uses the declared feed, adjustment, page cap and delayed end", () => {
    expect(source).toContain('"feed": ALPACA_FEED');
    expect(source).toContain('"adjustment": ALPACA_ADJUSTMENT');
    expect(source).toContain('"limit": ALPACA_PAGE_LIMIT');
    expect(source).toContain('"end": end');
    expect(source).toContain("datetime.now(timezone.utc) - timedelta(minutes=SIP_DELAY_MINUTES)");
  });
});
