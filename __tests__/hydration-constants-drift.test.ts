/**
 * The universe-hydration constants must be identical across every compute host
 * (Phase 2.2 of docs/signal-engine-three-phase-plan.md). The values live in
 * lib/shared/hydration-constants.json; the .ts and .mjs files only re-expose
 * them. This test fails if anyone hand-edits one view without the JSON, and
 * pins the agreed values so a change to them is a deliberate, reviewed diff.
 */
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
] as const;

describe("hydration constants are single-sourced", () => {
  it.each(KEYS)("%s agrees across json, .ts and .mjs", (key) => {
    expect((ts as Record<string, unknown>)[key]).toBe((json as Record<string, unknown>)[key]);
    expect((mjs as Record<string, unknown>)[key]).toBe((json as Record<string, unknown>)[key]);
  });

  it("holds the Phase 2.2 agreed values", () => {
    expect(json.LOOKBACK_DAYS).toBe(365);
    expect(json.CHUNK_SIZE).toBe(35);
    expect(json.ALPACA_FEED).toBe("iex");
    expect(json.ALPACA_ADJUSTMENT).toBe("split");
    expect(json.MIN_BARS).toBe(40);
    expect(json.MIN_COVERAGE_RATIO).toBe(0.95);
  });

  it("CHUNK_SIZE * ~one trading year still fits one Alpaca page", () => {
    // ~252 sessions/yr; the point of 35 is that 35 * 252 < the 10k-bar cap.
    expect(json.CHUNK_SIZE * 252).toBeLessThan(json.ALPACA_PAGE_LIMIT);
  });
});
