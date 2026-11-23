import { describe, expect, it } from "vitest";
import { evaluateQualityEvidence, readQualityEvidence, unrecoveredNewsAccuracyEvidence } from "@/lib/nulogdash-quality.mjs";
import type { QualityEvidenceInput } from "@/lib/nulogdash-quality.mjs";

describe("nulogdash quality evidence", () => {
  it("does not grade an operationally successful job as quality when evidence is missing", () => {
    const evidence = {
      ...unrecoveredNewsAccuracyEvidence(),
      jobStatus: "ok",
    };
    const quality = evaluateQualityEvidence(evidence);

    expect(quality.metrics[0].verdict).toBe("missing");
    expect(quality.workload.verdict).toBe("missing");
    expect(quality.metrics[0].observed).toBeNull();
    const deltaIc = quality.metrics.find((metric) => metric.id === "delta_ic_h5");
    expect(deltaIc?.valueState).toBe("null");
    expect(deltaIc?.observed).toBeNull();
    expect(deltaIc?.verdict).toBe("missing");
  });

  it("marks a legacy operational report as quality not recorded", () => {
    expect(readQualityEvidence(undefined).displayReason).toMatch(/quality not recorded/i);
  });

  it("fails closed when a versioned artifact is malformed", () => {
    const quality = readQualityEvidence({
      schemaVersion: "nulogdash-quality/v1",
      source: null,
      cutoffAt: null,
      evidenceScope: null,
      workload: null,
      metrics: [null],
    });
    expect(quality.workload.verdict).toBe("blocked");
    expect(quality.metrics[0].verdict).toBe("blocked");
  });

  it.each([
    ["no labels", { eligible: 12, attempted: 12, useful: 0, skipped: 0, deferred: 0, errors: 0, items: [] }],
    ["skips", { eligible: 2, attempted: 2, useful: 1, skipped: 1, deferred: 0, errors: 0, items: [{ id: "one", status: "useful" }, { id: "two", status: "skipped" }] }],
    ["deferrals", { eligible: 2, attempted: 2, useful: 1, skipped: 0, deferred: 1, errors: 0, items: [{ id: "one", status: "useful" }, { id: "two", status: "deferred" }] }],
    ["errors", { eligible: 2, attempted: 2, useful: 1, skipped: 0, deferred: 0, errors: 1, items: [{ id: "one", status: "useful" }, { id: "two", status: "error" }] }],
  ] as const)("keeps %s from becoming a green quality verdict", (_name, workload) => {
    const quality = evaluateQualityEvidence({
      source: { name: "fixture", version: "fixture-v1", runId: "synthetic-run", evaluatorVersion: "fixture-eval-v1" },
      cutoffAt: "2026-11-20T21:00:00Z",
      evidenceScope: "Synthetic regression fixture.",
      workload: workload as unknown as QualityEvidenceInput["workload"],
      metrics: [{ id: "accuracy", label: "Accuracy", observed: 0.99, eligibleDenominator: 12, measuredDenominator: 12, target: { operator: ">=", value: 0.8, rationale: "Synthetic target." } }],
    });

    expect(quality.workload.verdict).not.toBe("measured");
    expect(quality.metrics[0].verdict).not.toBe("meets_target");
  });

  it("preserves a measured numeric zero as a real value when its evidence is complete", () => {
    const quality = evaluateQualityEvidence({
      source: { name: "fixture", version: "fixture-v1", runId: "synthetic-run", evaluatorVersion: "fixture-eval-v1" },
      cutoffAt: "2026-11-20T21:00:00Z",
      evidenceScope: "Synthetic regression fixture.",
      workload: { eligible: 1, attempted: 1, useful: 1, skipped: 0, deferred: 0, errors: 0, items: [{ id: "one", status: "useful" }] },
      metrics: [{ id: "delta_ic", label: "ΔIC", observed: 0, eligibleDenominator: 1, measuredDenominator: 1, target: { operator: ">=", value: 0, rationale: "Synthetic target." } }],
    });
    expect(quality.metrics[0].observed).toBe(0);
    expect(quality.metrics[0].verdict).toBe("meets_target");
  });
});
