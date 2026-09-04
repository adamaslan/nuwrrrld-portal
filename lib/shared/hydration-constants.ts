/**
 * hydration-constants (.ts) — the typed view of the shared hydration constants.
 *
 * The values live in hydration-constants.json so there is exactly one source
 * of truth across every compute host (Phase 2.2 of
 * docs/signal-engine-three-phase-plan.md):
 *
 *   - this file            → the Next.js / TypeScript side
 *   - hydration-constants.mjs → the plain-Node scripts under scripts/
 *   - hydration-constants.json → read directly by deploy/universe-hydration/modal_app.py
 *
 * __tests__/hydration-constants-drift.test.ts asserts the .ts and .mjs views
 * expose identical values, so a hand-edit to one without the JSON fails CI.
 */
import constants from "./hydration-constants.json";

/** Calendar days of daily bars to request. 365 matches Modal, unblocks the
 *  50/200-day MAs, and stabilizes the volatility percentile. */
export const LOOKBACK_DAYS: number = constants.LOOKBACK_DAYS;

/** Symbols per Alpaca request. 35 is the largest chunk that still fits inside
 *  one 10k-bar page at a 365-day lookback (~252 trading days × 35 ≈ 8,820). */
export const CHUNK_SIZE: number = constants.CHUNK_SIZE;

/** Alpaca data feed. `iex` is today's plan default; pinning it here makes a
 *  feed upgrade a one-line diff rather than an unstated assumption. */
export const ALPACA_FEED: string = constants.ALPACA_FEED;

/** Bar adjustment. `split` matches Modal and removes split discontinuities
 *  that would otherwise show up as fake gaps and volatility spikes. */
export const ALPACA_ADJUSTMENT: string = constants.ALPACA_ADJUSTMENT;

/** Minimum bars before every indicator returns a real (non-null) reading —
 *  one value shared by both hosts, which previously disagreed (JS 40 / Py 30). */
export const MIN_BARS: number = constants.MIN_BARS;

/** Coverage ratio (carded / active) below which a full run is a failure. */
export const MIN_COVERAGE_RATIO: number = constants.MIN_COVERAGE_RATIO;

/** Max bars Alpaca returns per page before it hands back a next_page_token. */
export const ALPACA_PAGE_LIMIT: number = constants.ALPACA_PAGE_LIMIT;

export default constants;
