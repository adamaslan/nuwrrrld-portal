export type QualityVerdict = "measured" | "meets_target" | "misses_target" | "insufficient" | "blocked" | "missing";
export interface QualityMetric {
  id: string;
  label: string;
  observed: number | null;
  valueState?: "value" | "null" | "missing";
  eligibleDenominator: number | null;
  measuredDenominator: number | null;
  dimensions?: { horizonDays: number | null; windowSessions: number | null; sliceKind: string | null; sliceValue: string | null; scorerVersion: string | null };
  target: { operator: ">=" | "<=" | null; value: number | null; rationale: string };
  verdict?: QualityVerdict;
  reason?: string | null;
}
export interface QualityEvidenceInput {
  schemaVersion?: string;
  source: { name: string | null; version: string | null; runId: string | null; evaluatorVersion: string | null };
  cutoffAt: string | null;
  evidenceScope: string;
  workload: {
    eligible: number | null;
    attempted: number | null;
    useful: number | null;
    skipped: number | null;
    deferred: number | null;
    errors: number | null;
    items: { id: string; status: "useful" | "skipped" | "deferred" | "error" }[];
    verdict?: QualityVerdict;
    reason?: string | null;
  };
  metrics: QualityMetric[];
  displayReason?: string | null;
}
export interface QualityEvidence extends QualityEvidenceInput {
  schemaVersion: "nulogdash-quality/v1";
  workload: QualityEvidenceInput["workload"] & { verdict: QualityVerdict; reason: string | null };
  metrics: (QualityMetric & { verdict: QualityVerdict; reason: string | null })[];
}
export const QUALITY_SCHEMA_VERSION: "nulogdash-quality/v1";
export function evaluateQualityEvidence(input: QualityEvidenceInput): QualityEvidence;
export function missingQualityEvidence(reason?: string): QualityEvidence;
export function readQualityEvidence(raw?: unknown): QualityEvidence;
export function unrecoveredNewsAccuracyEvidence(): QualityEvidenceInput;
