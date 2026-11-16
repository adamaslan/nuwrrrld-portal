import { describe, expect, it } from "vitest";
import seed from "./fixtures/followed-tickers-gold-set.json";
import { reportSimulatorFidelity } from "@/lib/judge-sim-fidelity";
import { simulateJudge } from "@/lib/judge-sim";

describe("SIMULATED fidelity, not real Judge gate", () => {
  it("reports every unchanged human seed entry, including disagreement", () => {
    const before = JSON.stringify(seed);
    const report = reportSimulatorFidelity(seed.entries);
    expect(report.comparisons).toHaveLength(3);
    for (const [index, entry] of seed.entries.entries()) {
      const comparison = report.comparisons[index];
      expect(comparison.id).toBe(entry.id);
      expect(comparison.humanTotal).toBe(entry.goldTotal);
      expect(comparison.simulatorTotal).toBe(simulateJudge(entry.verdict, entry.brief).total);
      expect(comparison.agrees).toBe(Math.abs(comparison.simulatorTotal-entry.goldTotal) <= 1);
    }
    expect(report.agreementRate).toBe(report.agreedCount / 3);
    expect(report.agreementRate).toBeLessThan(0.8);
    expect(report.meetsFidelityTarget).toBe(false);
    expect(JSON.stringify(seed)).toBe(before);
  });

  it("uses inclusive ±1 and inclusive80% without excluding failed entries", () => {
    const entry = seed.entries[2];
    const total = simulateJudge(entry.verdict, entry.brief).total;
    const entries = [total-1,total,total+1,total,total+2].map((goldTotal,index)=>({...entry,id:String(index),goldTotal}));
    const report = reportSimulatorFidelity(entries);
    expect(report.agreedCount).toBe(4);
    expect(report.agreementRate).toBe(0.8);
    expect(report.meetsFidelityTarget).toBe(true);
    expect(report.tolerance).toBe(1);
    expect(report.threshold).toBe(0.8);
  });

  it("labels the report and each comparison, and fails closed on empty input", () => {
    const report = reportSimulatorFidelity(seed.entries);
    expect(report.label).toBe("SIMULATED");
    expect(report.version).toBe("judge_sim_v1");
    expect(report.publicationEligible).toBe(false);
    expect(report.comparisons.every(c=>c.label==="SIMULATED" && c.version==="judge_sim_v1")).toBe(true);
    expect(reportSimulatorFidelity([])).toMatchObject({sampleSize:0,agreementRate:0,meetsFidelityTarget:false,publicationEligible:false});
  });

  it("refuses invalid human totals and duplicate identities instead of inflating agreement", () => {
    const entry = seed.entries[0];
    for(const goldTotal of [NaN,Infinity,-1,11,1.5]) {
      expect(()=>reportSimulatorFidelity([{...entry,goldTotal}])).toThrow(/goldTotal/);
    }
    expect(()=>reportSimulatorFidelity([entry,entry])).toThrow(/unique/);
  });
});
