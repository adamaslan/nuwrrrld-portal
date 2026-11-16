---
date: 2026-11-16
type: concept
tags: [council, langsmith, privacy, observability]
sources: [../../lib/langsmith-council-trace.ts, ../../lib/openrouter.ts, ../../docs/langsmith-council-observability.md]
---

# Concept: AI run privacy boundary

## The pattern

External observability should receive only the operational fields needed to
classify a model attempt. Keep prompts and completions out of traces, use an
allowlist for metadata and outputs, require explicit enablement and an explicit
destination, and make tracing failure irrelevant to the user-facing model call.

## Where it appears

The portal's Council fallback loop can emit one LangSmith run per provider
attempt. The run records seat, model, attempt number, primary/fallback status,
answer-only mode, HTTP status, finish reason, reasoning-token count, visible
content length, and whether visible content was present. The raw request body,
response text, ticker, and caller identity are excluded. Existing Council
diagnostics remain the source of truth.

## Contradictions / tensions

- This boundary is implemented in code but has not been validated through a
  real LangSmith ingestion. An owner-selected hosted or self-hosted endpoint and
  a payload review are still required before enabling it on live traffic.
- Content-free traces reduce context for debugging prompt quality. They answer
  attempt-status and empty-output questions, not whether the model's prose was
  grounded or numerically correct.

## See also

- [[entity-ai-council]] — the calls that emit the optional traces
- [[decision-langsmith-council-tracing]] — the explicit opt-in decision
- `docs/langsmith-council-observability.md` — enablement and field contract
