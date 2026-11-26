import { describe, expect, it } from "vitest";
import {
  benchmarkChoiceRankSensitivity,
  eventWindowExclusionSensitivity,
  leadershipClusterConcentration,
  marketNeutralResidualPersistence,
  reboundParticipationAsymmetry,
  sectorRankMigrationMatrix,
} from "@/lib/shared/se1/bar-only-batch-06";

describe("S26-067 sectorRankMigrationMatrix", () => {
  it("keeps reclassified and missing names outside the stable rank matrix", () => {
    const r = sectorRankMigrationMatrix([
      { ticker: "AAA", priorSector: "tech", currentSector: "tech", priorReturn: 0.3, currentReturn: 0.1, priorMember: true, currentMember: true },
      { ticker: "BBB", priorSector: "tech", currentSector: "tech", priorReturn: 0.1, currentReturn: 0.3, priorMember: true, currentMember: true },
      { ticker: "CCC", priorSector: "tech", currentSector: "health", priorReturn: 0.2, currentReturn: 0.4, priorMember: true, currentMember: true },
      { ticker: "DDD", priorSector: "health", currentSector: "health", priorReturn: null, currentReturn: 0.5, priorMember: true, currentMember: true },
    ], { priorDate: "2026-06-01", currentDate: "2026-06-30", bucketCount: 3 });
    expect(r).toMatchObject({ comparable_members: 2, exclusions: { reclassified: 1, missing_score: 1 }, transitions: expect.any(Array) });
  });
});

describe("S26-068 marketNeutralResidualPersistence", () => {
  it("returns unavailable for singular factor inputs instead of fitting on evaluation bars", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-06-${String(i + 1).padStart(2, "0")}`, assetReturn: i / 100, marketReturn: i / 100, sectorReturn: i / 100,
    }));
    expect(marketNeutralResidualPersistence(rows, { trainingEndDate: "2026-06-07", cutoff: "2026-06-10", minTrainingRows: 5, evaluationWindow: 3 })).toMatchObject({ status: "unavailable", reason: "singular factor fit" });
  });
});

describe("S26-069 reboundParticipationAsymmetry", () => {
  it("leaves an unfinished rebound phase pending", () => {
    const r = reboundParticipationAsymmetry([
      { ticker: "AAA", selloffReturn: -0.1, reboundReturn: null },
      { ticker: "BBB", selloffReturn: -0.05, reboundReturn: null },
    ], { selloffStart: "2026-06-01", selloffEnd: "2026-06-05", reboundStart: "2026-06-08", reboundEnd: "2026-06-30", cutoff: "2026-06-10", reboundComplete: false });
    expect(r).toMatchObject({ state: "pending", common_members: 0, down_phase_breadth: 1, up_phase_breadth: null });
  });
});

describe("S26-070 leadershipClusterConcentration", () => {
  it("deduplicates canonical share classes and counts unclassified leaders", () => {
    const r = leadershipClusterConcentration([
      { ticker: "AAA", canonicalId: "A", score: 10, industry: "software" },
      { ticker: "AAA.B", canonicalId: "A", score: 9, industry: "software" },
      { ticker: "BBB", canonicalId: "B", score: 8, industry: null },
      { ticker: "CCC", canonicalId: "C", score: 7, industry: "banks" },
    ], { classificationVersion: "sic-v1", topN: 3 });
    expect(r).toMatchObject({ ranking_population: 2, duplicate_canonical_excluded: 2, unclassified_top_members: 1, classification_version: "sic-v1" });
  });
});

describe("S26-071 benchmarkChoiceRankSensitivity", () => {
  it("reports how a declared market-versus-sector benchmark changes rank", () => {
    const members = [
      { ticker: "AAA", stockReturn: 0.2, marketBenchmarkReturn: 0.1, sectorBenchmarkReturn: 0.25 },
      { ticker: "BBB", stockReturn: 0.15, marketBenchmarkReturn: 0.1, sectorBenchmarkReturn: 0.05 },
      { ticker: "CCC", stockReturn: 0.1, marketBenchmarkReturn: 0.1, sectorBenchmarkReturn: 0.05 },
    ];
    const r = benchmarkChoiceRankSensitivity("AAA", members, { marketBenchmarkId: "SPY", sectorBenchmarkId: "XLK", marketBasis: "total_return", sectorBasis: "total_return", topN: 1 });
    expect(r).toMatchObject({ status: "computed", market_rank: 1, sector_rank: 3, conclusion_changed: true });
  });
});

describe("S26-082 eventWindowExclusionSensitivity", () => {
  it("excludes only event windows known by the evaluated cutoff", () => {
    const r = eventWindowExclusionSensitivity([
      { date: "2026-06-01", eligible: true, triggered: true },
      { date: "2026-06-02", eligible: true, triggered: false },
      { date: "2026-06-03", eligible: true, triggered: true },
    ], [
      { eventDate: "2026-06-02", knownAt: "2026-05-30", beforeBars: 0, afterBars: 0 },
      { eventDate: "2026-06-03", knownAt: "2026-06-10", beforeBars: 0, afterBars: 0 },
    ], { cutoff: "2026-06-05", minSampleSize: 2, exclusionPolicy: "known-at-cutoff-only" });
    expect(r).toMatchObject({ status: "computed", baseline: { eligible: 3, triggered: 2 }, excluding_events: { eligible: 2, triggered: 2 }, excluded_setups: 1 });
  });
});

