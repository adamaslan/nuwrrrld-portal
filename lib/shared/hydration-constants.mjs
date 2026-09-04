/**
 * hydration-constants (.mjs) — the Node/script view of the shared constants.
 *
 * The values live in hydration-constants.json so there is exactly one source
 * of truth (Phase 2.2 of docs/signal-engine-three-phase-plan.md). This file
 * only re-exports them as named bindings for the plain-Node scripts under
 * scripts/, which cannot import a .ts file without a build step.
 *
 * Kept numerically identical to hydration-constants.ts by
 * __tests__/hydration-constants-drift.test.ts.
 */
import constants from "./hydration-constants.json" with { type: "json" };

export const LOOKBACK_DAYS = constants.LOOKBACK_DAYS;
export const CHUNK_SIZE = constants.CHUNK_SIZE;
export const ALPACA_FEED = constants.ALPACA_FEED;
export const ALPACA_ADJUSTMENT = constants.ALPACA_ADJUSTMENT;
export const MIN_BARS = constants.MIN_BARS;
export const MIN_COVERAGE_RATIO = constants.MIN_COVERAGE_RATIO;
export const ALPACA_PAGE_LIMIT = constants.ALPACA_PAGE_LIMIT;

export default constants;
