# LangSmith Council attempt traces

The Council provider fallback loop can emit one content-free LangSmith run per
model attempt. This is an optional diagnostic mirror; the application's
existing Council attempt records remain the source of truth.

## Enablement

Tracing is off unless all three settings are present:

- `NWF_LANGSMITH_TRACING=true`
- `LANGSMITH_API_KEY`
- `LANGSMITH_API_URL`

The endpoint must be set explicitly. This keeps the code from silently choosing
LangSmith Cloud before the project decides whether to use a hosted or
self-hosted service. The trace project is `nuwrrrld-council-attempts`.

To turn tracing off, unset the flag. No database or provider behavior depends on
LangSmith availability.

## Recorded fields

The trace records seat, model, attempt number, whether the model was primary,
answer-only mode, HTTP status, finish reason, reasoning-token count, visible
content length, and whether visible content was present.

Prompts, completions, tickers, caller identifiers, authorization headers, and
provider error text are excluded. The SDK applies allowlists to run metadata and
outputs, removes run inputs and runtime metadata, and drops unrecognized
serialized fields. A failed LangSmith client setup falls back to the provider
call without tracing. A trace failure after a provider call does not repeat that
call.

Do not enable this against real traffic until the owner has selected and
configured the LangSmith endpoint and reviewed the applicable data-retention
terms. No hosted or self-hosted trace ingestion was performed for this change.
