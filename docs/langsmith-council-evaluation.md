# Synthetic LangSmith Council fallback evaluation

`fixtures/langsmith/council-fallback-contract-v1.json` is a synthetic,
content-free dataset for the Council fallback contract. It covers an empty
completion followed by a usable answer, an all-empty sequence, a retired
primary followed by an answer, and an unavailable provider chain. It contains
no real prompt, completion, ticker, caller ID, or production trace.

`scripts/council-langsmith-eval.mjs` has three explicit modes:

- No arguments or `--local` computes the expected fallback metrics from the
  checked-in fixture without network access.
- `--upload` creates or finds a provenance-marked LangSmith dataset, rejects unexpected
  or modified existing examples and adds only missing checked-in synthetic examples. It requires both `LANGSMITH_API_KEY` and
  `LANGSMITH_API_URL`; no default hosted endpoint is selected.
- `--experiment` first verifies the entire remote example set against the checked-in
  fixture, including dataset identity, synthetic provenance, exact inputs/outputs,
  duplicate keys and unexpected attachments. It then evaluates a fresh allowlisted
  local snapshot of those verified examples, not a mutable dataset-name lookup.
  Extra, changed or missing examples fail closed before an experiment starts.
  It makes no model calls; the evaluator compares success, empty-completion
  count and attempt count with the fixture reference.

Upload and experiment modes are opt-in and were not run for this change. The
fixture represents the observed failure categories abstractly; it is not a
replay of the Nov 10 private prompt or provider response.


Offline boundary tests mock dataset reads and experiment execution. They verify
rejection of foreign, modified, missing, duplicate, wrong-dataset, attachment-bearing
and unmarked examples, and verify snapshot isolation if remote objects change after
validation. A remote client also replaces serialized errors with a fixed marker.
The local counting fixture is not a replay of provider logic. Separate actual
Council `runSeat` tests cover fallback behavior with mocked provider transport and
tracing enabled. Neither suite proves live model availability or endpoint retention.
