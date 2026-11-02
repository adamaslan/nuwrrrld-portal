import { describe, expect, it } from "vitest";
import { FLAG_NAMES, flagLive, flagMode } from "@/lib/flags";

// Dark-launch gate: every surface starts hidden. Moving one to `live` must be a
// deliberate change to this test as well as lib/flags.ts.
describe("dark-launch flags", () => {
  it.each(FLAG_NAMES)("%s starts off and is not live", (name) => {
    expect(flagMode(name)).toBe("off");
    expect(flagLive(name)).toBe(false);
  });

  it("lists exactly the five surfaces from the dark-launch workflow", () => {
    expect([...FLAG_NAMES].sort()).toEqual([
      "backtest_hit_rates",
      "council_public_demo",
      "holdfold_top_movers",
      "news_vote",
      "paper_benchmark_metrics",
    ]);
  });
});
