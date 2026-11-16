# Synthetic LangSmith Council fallback evaluation

`fixtures/langsmith/council-fallback-contract-v1.json` is a synthetic,
content-free dataset for the Council fallback contract. It covers an empty
completion followed by a usable answer, an all-empty sequence, a retired
primary followed by an answer, and an unavailable provider chain. It contains
no real prompt, completion, ticker, caller ID, or production trace.

`scripts/council-langsmith-eval.mjs` has three explicit modes:

- No arguments or `--local` computes the expected fallback metrics from the
  checked-in fixture without network access.
- `--upload` creates or finds the named LangSmith dataset and adds only missing
  synthetic examples. It requires both `LANGSMITH_API_KEY` and
  `LANGSMITH_API_URL`; no default hosted endpoint is selected.
- `--experiment` runs the deterministic evaluator against that remote dataset.
  It makes no model calls; the evaluator compares success, empty-completion
  count, and attempt count with the fixture reference.

Upload and experiment modes are opt-in and were not run for this change. The
fixture represents the observed failure categories abstractly; it is not a
replay of the Nov 10 private prompt or provider response.
