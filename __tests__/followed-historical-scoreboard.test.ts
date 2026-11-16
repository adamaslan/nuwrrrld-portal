import { describe, expect, it } from "vitest";
import { buildHistoricalScoreboard, type HistoricalCohortArtifact } from "@/lib/shared/followed-historical-scoreboard";

// Synthetic frozen decisions, never production results. Distinct months exercise
// the latest-cohort-only bug without lowering the actual 30 decisive-pick bar.
const expected = { runId: "synthetic-test", engineSha256: "a".repeat(64), universeSha256: "b".repeat(64), today: "2026-11-15" };
function artifact(count = 40): HistoricalCohortArtifact {
  const picks = Array.from({ length: count }, (_, i) => ({
    id: `pick-${i}`, ticker: `TEST${i % 20}`, cohortMonth: i < 20 ? "2026-09-01" : "2026-10-01",
    selectedOn: i < 20 ? "2026-09-01" : "2026-10-01", inputsThrough: i < 20 ? "2026-08-31" : "2026-09-30",
    direction: "bull" as const, entryPrice: 100,
  }));
  return { format: "followed-cohort-reconstruction-v1", mode: "reconstructed_point_in_time",
    horizonPolicy: "followed-weekdays-lag1-yearend-v1", runId: expected.runId, engineSha256: expected.engineSha256, universeSha256: expected.universeSha256, decisionStart: "2026-09-01", decisionEnd: "2026-10-01",
    observationCutoff: "2026-11-13", priceBasis: "SYNTHETIC", picks,
    exits: picks.map((p, i) => ({ pickId: p.id, horizon: "d1" as const, resolvedOn: i < 20 ? "2026-09-02" : "2026-10-02", exitPrice: 102, status: "measured" as const })),
  } as HistoricalCohortArtifact;
}
function ready(a = artifact(), e = expected) {
  const result = buildHistoricalScoreboard(a, e);
  expect(result.status).toBe("ready");
  if (result.status !== "ready") throw Error(result.reason);
  return result.view;
}
describe("reconstructed historical scoreboard", () => {
  it("aggregates 40 frozen decisions across two cohorts without rewriting live data", () => {
    const a = artifact(), before = JSON.stringify(a), v = ready(a);
    expect(v.cohortCount).toBe(2); expect(v.pickCount).toBe(40);
    expect(v.scoreboard.find(r => r.horizon === "d1")).toMatchObject({ n: 40, hits: 40, hitRatePct: 100, meanReturnPct: 2, asOf: "2026-10-02" });
    expect(v.label).toBe("Historical backtest reconstruction, not a live track record");
    expect(v.judgeHistory).toBe("not_available"); expect(JSON.stringify(a)).toBe(before);
  });
  it("preserves the exact 29/30 rate policy and leaves unmeasured horizons blank", () => {
    expect(ready(artifact(29)).scoreboard[0].hitRatePct).toBeNull();
    expect(ready(artifact(30)).scoreboard[0].hitRatePct).toBe(100);
    const v = ready(); expect(v.unmeasuredByHorizon.y1).toBe(40);
    expect(v.scoreboard.find(r => r.horizon === "y1")).toMatchObject({ n: 0, hitRatePct: null, meanReturnPct: null, asOf: null });
  });
  it("does not replace missing prices with winners or mix flat/void into decisive denominator", () => {
    const a = artifact(); a.exits[0].exitPrice = null; a.exits[0].status = "missing_price";
    a.exits[1].exitPrice = 100; a.exits[2].exitPrice = 98;
    expect(ready(a).scoreboard[0]).toMatchObject({ n: 38, hits: 37, misses: 1, flats: 1, voids: 1 });
  });
  it("rejects pooled detector manifests rather than relabeling them as cohorts", () => {
    expect(buildHistoricalScoreboard({ mode: "reconstructed_point_in_time", ledger: [], pooled_category_strength_horizon: [] }, expected).status).toBe("invalid");
  });
  it.each(["future-input", "future-exit", "duplicate-pick", "duplicate-exit", "orphan-exit", "early-horizon", "wrong-pin", "invalid-date", "price-status"]) ("rejects %s", fault => {
    const a = artifact();
    if (fault === "future-input") a.picks[0].inputsThrough = "2026-09-02";
    if (fault === "future-exit") a.exits[0].resolvedOn = "2026-11-16";
    if (fault === "duplicate-pick") a.picks.push(a.picks[0]);
    if (fault === "duplicate-exit") a.exits.push(a.exits[0]);
    if (fault === "orphan-exit") a.exits[0].pickId = "unknown";
    if (fault === "early-horizon") a.exits[0].horizon = "w1";
    if (fault === "wrong-pin") a.engineSha256 = "c".repeat(64);
    if (fault === "invalid-date") a.picks[0].selectedOn = "2026-02-30";
    if (fault === "price-status") a.exits[0].exitPrice = null;
    expect(buildHistoricalScoreboard(a, expected).status).toBe("invalid");
  });
  it("voids a late missing horizon rather than scoring a later rally", () => {
    const a = artifact(); a.exits[0].resolvedOn = "2026-09-08"; a.exits[0].exitPrice = 500;
    expect(ready(a).scoreboard[0]).toMatchObject({ hits: 39, voids: 1 });
  });
  it("requires independent year-end session binding for final YTD", () => {
    const a = artifact(1); a.decisionStart = "2025-09-01"; a.decisionEnd = "2025-09-01";
    a.picks[0] = { ...a.picks[0], cohortMonth: "2025-09-01", selectedOn: "2025-09-01", inputsThrough: "2025-08-29" };
    a.exits[0] = { ...a.exits[0], horizon: "ytd", resolvedOn: "2025-12-31" };
    expect(buildHistoricalScoreboard(a, expected).status).toBe("invalid");
    const result = buildHistoricalScoreboard(a, { ...expected, yearEndSessions: { "2025": "2025-12-31" } });
    expect(result.status).toBe("ready");
  });
});
