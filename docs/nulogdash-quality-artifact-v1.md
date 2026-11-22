# nulogdash quality evidence artifact v1

The operational runner may read a retained local JSON result from
`.nulogdash/quality-evidence.json`. It never retrieves results from a provider,
database, or live pipeline. The artifact is embedded in
`.nulogdash/latest.json` as `qualityEvaluation` and shown separately from
endpoint and pipeline run outcomes.

## Contract

The artifact uses `schemaVersion: "nulogdash-quality/v1"` and records:

- `source`: name, source version, source run ID, and evaluator version. Each
  unknown value is `null`; the runner does not infer versions from schedules.
- `cutoffAt` and `evidenceScope`, with an explicit explanation of what the
  evidence does and does not cover.
- `workload`: eligible, attempted, useful, skipped, deferred, and error counts,
  plus item outcomes (`useful`, `skipped`, `deferred`, or `error`). Counts and
  item outcomes must agree before the workload can be considered measured.
- `metrics`: `id`, `label`, `observed`, `valueState`, eligible and measured
  denominators, dimensions (horizon, window, slice, scorer version), and a
  target with rationale. `valueState` distinguishes a numeric value, source
  SQL `NULL`, and a value that was not recovered.

The reader derives verdicts from the evidence. A green target result requires
identified source and evaluator versions, a run ID, cutoff, evidence scope,
complete useful workload coverage, a numeric value, and positive complete
denominators. Empty item arrays, zero useful items, missing values, skipped or
deferred returns, and errors stay missing, insufficient, or blocked. They do
not receive quality credit because a job or HTTP request returned `ok`.

Old reports without this versioned artifact render “quality not recorded.”
Unrecognized artifact versions and malformed data fail closed.

## Current retained evidence boundary

GCP9/25 is an attributed offline captured-data checkpoint, not deployed
parity. The old NWF4 catalog is historical relative to known NWF5, while the
deployed source version and schedules remain unverified here. News jobs ran,
but numeric quality values and workload denominators were not recovered. The
current `deltaIC` observation is SQL `NULL`. A pipeline status of `ok` can
accompany zero output rows, so operational status is displayed independently.

The metric names and documented gate rationales in the local fixture come from
the retained `news_accuracy` specification. In particular, the specified
5-session, 250-session ensemble gate uses rank IC ≥ 0.02, non-overlapping IC
t-stat ≥ 2, ΔIC ≥ 0.005, and decile monotonicity ≥ 0.6, with at least 120
sessions and 5,000 scored pairs. These are design targets; this report does
not claim that a deployed evaluator or schedule used them.
