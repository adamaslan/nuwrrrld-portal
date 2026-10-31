/**
 * Dark-launch flags for surfaces that show wrong or unverified numbers.
 *
 * Modes (see docs/nwf-dark-launch-gated-workflow-2026-10-28.md):
 *   off    — the surface is hidden and its data is not read.
 *   shadow — reserved for the shadow runner; UI treats it as off.
 *   live   — the surface is shown.
 *
 * Every flag starts `off`. Flags are plain constants so client components can
 * import them without a server round trip. Moving a flag to `live` is a code
 * change reviewed in a PR, not an env toggle, until the Edge Config store lands.
 */

export const FLAG_NAMES = [
  "backtest_hit_rates",
  "paper_benchmark_metrics",
  "holdfold_top_movers",
  "news_vote",
  "council_public_demo",
] as const;

export type FlagName = (typeof FLAG_NAMES)[number];
export type FlagMode = "off" | "shadow" | "live";

const FLAG_MODES: Record<FlagName, FlagMode> = {
  backtest_hit_rates: "off",
  paper_benchmark_metrics: "off",
  holdfold_top_movers: "off",
  news_vote: "off",
  council_public_demo: "off",
};

export function flagMode(name: FlagName): FlagMode {
  return FLAG_MODES[name];
}

export function flagLive(name: FlagName): boolean {
  return FLAG_MODES[name] === "live";
}
