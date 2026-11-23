/** Versioned, evidence-backed quality results shared by the runner, readers, and HTML report. */
export const QUALITY_SCHEMA_VERSION = "nulogdash-quality/v1";

const validNumber = (value) => typeof value === "number" && Number.isFinite(value);
const validCount = (value) => value === null || (Number.isInteger(value) && value >= 0);
const nullableText = (value) => typeof value === "string" && value.trim() ? value : null;

function validCutoff(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60
    && Number.isFinite(Date.parse(value));
}

function sourceIsIdentified(source) {
  return Boolean(source?.name && source?.version && source?.runId && source?.evaluatorVersion);
}

function evaluateWorkload(workload) {
  if (!workload || typeof workload !== "object") {
    return { eligible: null, attempted: null, useful: null, skipped: null, deferred: null, errors: null, items: [], verdict: "blocked", reason: "Invalid workload evidence." };
  }
  const { eligible, attempted, useful, skipped, deferred, errors, items } = workload;
  if (![eligible, attempted, useful, skipped, deferred, errors].every(validCount) || !Array.isArray(items)) {
    return { ...workload, verdict: "blocked", reason: "Invalid workload counts or item list." };
  }
  if ([eligible, attempted, useful, skipped, deferred, errors].some((value) => value === null)) {
    return { ...workload, verdict: "missing", reason: "Workload denominators or return counts were not recorded." };
  }
  if (eligible === 0 || attempted === 0 || items.length === 0) {
    return { ...workload, verdict: "insufficient", reason: "No eligible or observed workload items were available." };
  }
  const itemCounts = items.reduce((counts, item) => {
    if (item?.status in counts) counts[item.status] += 1;
    else counts.invalid += 1;
    return counts;
  }, { useful: 0, skipped: 0, deferred: 0, error: 0, invalid: 0 });
  if (itemCounts.invalid || attempted !== items.length || attempted > eligible || itemCounts.useful !== useful || itemCounts.skipped !== skipped || itemCounts.deferred !== deferred || itemCounts.error !== errors) {
    return { ...workload, verdict: "blocked", reason: "Workload item outcomes do not match the recorded counts." };
  }
  if (errors > 0) return { ...workload, verdict: "blocked", reason: "One or more workload items returned an error." };
  if (skipped > 0 || deferred > 0) return { ...workload, verdict: "insufficient", reason: "Skipped or deferred work leaves quality coverage incomplete." };
  if (attempted < eligible || useful === 0) return { ...workload, verdict: "insufficient", reason: "Useful workload coverage is incomplete or empty." };
  return { ...workload, verdict: "measured", reason: null };
}

/**
 * Validate raw quality evidence and derive conservative verdicts. Job/transport
 * success is intentionally absent: it cannot turn missing evidence green.
 * @param {object} input
 */
export function evaluateQualityEvidence(input) {
  input = input && typeof input === "object" ? input : {};
  const workload = evaluateWorkload(input.workload ?? {});
  const source = {
    name: nullableText(input.source?.name),
    version: nullableText(input.source?.version),
    runId: nullableText(input.source?.runId),
    evaluatorVersion: nullableText(input.source?.evaluatorVersion),
  };
  const cutoffAt = nullableText(input.cutoffAt);
  const evidenceScope = nullableText(input.evidenceScope) ?? "Not recorded.";
  const provenanceReady = sourceIsIdentified(source) && validCutoff(cutoffAt) && evidenceScope !== "Not recorded.";
  const metrics = (Array.isArray(input.metrics) ? input.metrics : []).map((rawMetric, index) => {
    const metric = rawMetric && typeof rawMetric === "object" ? rawMetric : {};
    const invalidIdentity = !nullableText(metric.id) || !nullableText(metric.label);
    const target = metric.target && typeof metric.target === "object"
      ? { operator: metric.target.operator ?? null, value: metric.target.value ?? null, rationale: nullableText(metric.target.rationale) ?? "No target rationale recorded." }
      : { operator: null, value: null, rationale: "No target rationale recorded." };
    const eligibleDenominator = metric.eligibleDenominator ?? null;
    const measuredDenominator = metric.measuredDenominator ?? null;
    const observed = metric.observed ?? null;
    const valueState = metric.valueState ?? (observed === null ? "missing" : "value");
    let verdict = "measured";
    let reason = null;
    if (invalidIdentity || workload.verdict === "blocked") {
      verdict = "blocked";
      reason = invalidIdentity ? "Metric identity or label is invalid." : workload.reason;
    } else if (!["value", "null", "missing"].includes(valueState) || (valueState === "value") !== validNumber(observed)) {
      verdict = "blocked";
      reason = "Observed value state is inconsistent.";
    } else if (!provenanceReady || valueState !== "value" || observed === null || eligibleDenominator === null || measuredDenominator === null) {
      verdict = "missing";
      reason = "Metric value, provenance, or denominator was not recorded.";
    } else if (!validCount(eligibleDenominator) || !validCount(measuredDenominator) || measuredDenominator > eligibleDenominator) {
      verdict = "blocked";
      reason = "Metric denominator is invalid or exceeds eligible coverage.";
    } else if (workload.verdict !== "measured" || eligibleDenominator <= 0 || measuredDenominator <= 0 || measuredDenominator < eligibleDenominator) {
      verdict = "insufficient";
      reason = "Evidence does not cover the eligible denominator.";
    } else if (!validNumber(observed) || !validCount(eligibleDenominator) || !validCount(measuredDenominator)) {
      verdict = "blocked";
      reason = "Metric value or denominator is invalid.";
    } else if (target.value !== null && target.value !== undefined) {
      const { operator, value } = target;
      const passed = operator === ">=" ? observed >= value : operator === "<=" ? observed <= value : null;
      if (passed === null || !validNumber(value) || !nullableText(metric.target?.rationale)) {
        verdict = "blocked";
        reason = "Target comparison is invalid.";
      } else {
        verdict = passed ? "meets_target" : "misses_target";
      }
    }
    const dimensions = metric.dimensions && typeof metric.dimensions === "object" ? {
      horizonDays: validCount(metric.dimensions.horizonDays) ? metric.dimensions.horizonDays : null,
      windowSessions: validCount(metric.dimensions.windowSessions) ? metric.dimensions.windowSessions : null,
      sliceKind: nullableText(metric.dimensions.sliceKind),
      sliceValue: nullableText(metric.dimensions.sliceValue),
      scorerVersion: nullableText(metric.dimensions.scorerVersion),
    } : undefined;
    return { ...metric, id: nullableText(metric.id) ?? `invalid-metric-${index}`, label: nullableText(metric.label) ?? "Unlabeled metric", observed, valueState, eligibleDenominator, measuredDenominator, target, dimensions, verdict, reason };
  });
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    source,
    cutoffAt,
    evidenceScope,
    workload,
    metrics,
    displayReason: nullableText(input.displayReason),
  };
}

export function missingQualityEvidence(reason = "Quality was not recorded for this report.") {
  return evaluateQualityEvidence({
    source: { name: null, version: null, runId: null, evaluatorVersion: null },
    cutoffAt: null,
    evidenceScope: "No quality evidence attached to this operational report.",
    displayReason: reason,
    workload: { eligible: null, attempted: null, useful: null, skipped: null, deferred: null, errors: null, items: [] },
    metrics: [],
  });
}

const newsMetric = (id, label, targetValue, operator, rationale) => ({
  id, label, observed: null, eligibleDenominator: null, measuredDenominator: null,
  dimensions: { horizonDays: null, windowSessions: null, sliceKind: null, sliceValue: null, scorerVersion: null },
  target: { operator, value: targetValue, rationale },
});

/** Local attribution only: this records the missing result state, not a run or a score. */
export function unrecoveredNewsAccuracyEvidence() {
  return {
    schemaVersion: QUALITY_SCHEMA_VERSION,
    source: { name: "news_accuracy_eval", version: null, runId: null, evaluatorVersion: null },
    cutoffAt: null,
    evidenceScope: "GCP9/25 is an attributed offline captured-data checkpoint, not deployed parity. The stale NWF4 catalog is historical relative to known NWF5; deployed source version and schedules are unverified. News jobs ran; numeric quality values and workload denominators were not recovered. A pipeline status of ok can accompany zero output rows. The current deltaIC field is source-reported SQL NULL.",
    displayReason: "News quality results were not recovered. An operational job status does not establish measured quality.",
    workload: { eligible: null, attempted: null, useful: null, skipped: null, deferred: null, errors: null, items: [] },
    metrics: [
      newsMetric("coverage", "Coverage", null, null, "Descriptive metric: share of active tickers with a non-null score per session; no threshold specified."),
      newsMetric("hit_rate", "Hit rate", null, null, "Report with a Wilson 95% confidence interval; no threshold specified."),
      newsMetric("hit_rate_lo", "Hit rate CI lower", null, null, "Lower bound of the Wilson 95% interval; requires recovered labeled outcomes."),
      newsMetric("hit_rate_hi", "Hit rate CI upper", null, null, "Upper bound of the Wilson 95% interval; requires recovered labeled outcomes."),
      newsMetric("rank_ic", "Rank IC", 0.02, ">=", "Specified 5-session, 250-session ensemble gate; also requires at least 120 sessions and 5,000 scored pairs."),
      newsMetric("ic_tstat", "IC t-stat", 2, ">=", "Specified non-overlapping 5-session, 250-session ensemble gate."),
      newsMetric("icir", "ICIR", null, null, "Consistency metric; no threshold specified."),
      newsMetric("decile_spread", "Decile spread", null, null, "Top-decile minus bottom-decile abnormal return; no numeric threshold specified."),
      newsMetric("monotonicity", "Decile monotonicity", 0.6, ">=", "Specified 5-session, 250-session ensemble gate."),
      newsMetric("brier", "Brier score", null, null, "Compare with the documented 0.25 baseline; no pass threshold specified."),
      { ...newsMetric("delta_ic_h5", "ΔIC (5-session)", 0.005, ">=", "Specified incremental-value gate at the candidate weight on the 250-session ensemble window."), valueState: "null" },
      newsMetric("delta_ic_h1", "ΔIC (1-session)", 0, ">=", "Specified cross-horizon guard for the candidate weight."),
      newsMetric("delta_ic_h20", "ΔIC (20-session)", 0, ">=", "Specified cross-horizon guard for the candidate weight."),
    ],
  };
}

/** Normalize old reports and reject malformed or forged green verdicts on read. */
export function readQualityEvidence(raw) {
  if (!raw) return { ...missingQualityEvidence(), displayReason: "Quality not recorded for this older report." };
  if (raw.schemaVersion !== QUALITY_SCHEMA_VERSION) {
    return { ...missingQualityEvidence(), displayReason: "Quality evidence version is unsupported; quality not recorded." };
  }
  const reevaluated = evaluateQualityEvidence(raw);
  return { ...reevaluated, displayReason: raw.displayReason ?? null };
}
