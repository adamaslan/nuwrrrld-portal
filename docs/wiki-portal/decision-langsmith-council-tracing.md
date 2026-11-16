---
date: 2026-11-16
type: decision
tags: [council, langsmith, privacy, observability]
sources: [../../lib/langsmith-council-trace.ts, ../../lib/openrouter.ts, ../../docs/langsmith-council-observability.md, ../../fixtures/langsmith/council-fallback-contract-v1.json, ../../scripts/council-langsmith-eval.mjs]
---

# Decision: opt-in, content-free LangSmith Council traces

## Decision

Add per-model-attempt LangSmith tracing behind an explicit feature flag, API
key, and API URL. Trace only allowlisted operational metadata and completion
statistics. Keep prompts, model responses, tickers, caller identifiers, and raw
provider errors out of the external trace payload.

## Date

2026-11-16

## Context

The Council's fallback loop already records attempt statuses and distinguishes
empty completions from provider failures. Tracing can make those attempts
searchable and comparable, but sends data to an external observability service.
PR #359 addressed the Nov 10 empty-output failure path; tracing does not prove
provider recovery or replace the application's run records.

## Alternatives considered

- Automatically trace all provider requests from environment defaults. Rejected
  because it can select a hosted endpoint without an explicit owner decision.
- Send prompts and completions for richer debugging. Rejected for this first
  slice because the data-retention decision is not established.
- Keep diagnostics only in application logs. This remains a valid fallback and
  preserves the current system of record, but does not provide trace search or
  cross-attempt comparison.

## Consequences

- Traces are off unless `NWF_LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, and
  `LANGSMITH_API_URL` are all set.
- A separate review of the selected endpoint's retention policy and the emitted
  payload is required before real traffic is enabled.
- The evaluation corpus is synthetic and checks only fallback status/content
  accounting. It does not reconstruct the Nov 10 prompt or completion.
- The trace can identify empty and failed attempts, but cannot evaluate answer
  correctness or repair the underlying data issues.
- No LangSmith endpoint was contacted for this implementation.

## Validated by

Source inspection only. No runtime trace ingestion or application test run has
been performed for this change.

## See also

- [[entity-ai-council]] — Council routes and model fallback
- [[concept-ai-run-privacy]] — content-free external telemetry boundary
- `docs/langsmith-council-observability.md` — operational settings
