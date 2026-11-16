/** Offline simulator measurement only. Never a real Judge run or publication gate. */
import { GOLD_AGREEMENT_THRESHOLD, GOLD_AGREEMENT_TOLERANCE } from "@/lib/eval-judge";
import type { GoldEntry } from "@/lib/eval-judge";
import { JUDGE_SIM_LABEL, JUDGE_SIM_VERSION, simulateJudge } from "@/lib/judge-sim";

export interface SimulatorFidelityComparison {
  label: typeof JUDGE_SIM_LABEL;
  version: typeof JUDGE_SIM_VERSION;
  id: string;
  humanTotal: number;
  simulatorTotal: number;
  agrees: boolean;
}

/** Separate shape intentionally omits JudgeResult and GoldGateResult fields. */
export function reportSimulatorFidelity(entries: readonly GoldEntry[]) {
  const ids = new Set<string>();
  const comparisons: SimulatorFidelityComparison[] = entries.map((entry) => {
    if (!entry.id.trim() || ids.has(entry.id)) throw new Error("Gold entry ids must be nonempty and unique.");
    ids.add(entry.id);
    if (!Number.isInteger(entry.goldTotal) || entry.goldTotal < 0 || entry.goldTotal > 10) {
      throw new Error(`Invalid human goldTotal for ${entry.id}; expected integer 0..10.`);
    }
    const result = simulateJudge(entry.verdict, entry.brief);
    return {
      label: JUDGE_SIM_LABEL,
      version: JUDGE_SIM_VERSION,
      id: entry.id,
      humanTotal: entry.goldTotal,
      simulatorTotal: result.total,
      agrees: Math.abs(entry.goldTotal - result.total) <= GOLD_AGREEMENT_TOLERANCE,
    };
  });
  const agreedCount = comparisons.filter((comparison) => comparison.agrees).length;
  const agreementRate = entries.length ? agreedCount / entries.length : 0;
  return {
    label: JUDGE_SIM_LABEL,
    version: JUDGE_SIM_VERSION,
    sampleSize: entries.length,
    agreedCount,
    agreementRate,
    tolerance: GOLD_AGREEMENT_TOLERANCE,
    threshold: GOLD_AGREEMENT_THRESHOLD,
    meetsFidelityTarget: entries.length > 0 && agreementRate >= GOLD_AGREEMENT_THRESHOLD,
    publicationEligible: false as const,
    comparisons,
  };
}
