# MU isolated live council validation

Status: **NOT EXECUTED against real models.** The disabled-by-default test was collected and skipped locally. That is not a passing model validation. Existing council-orchestration tests use mocks and remain separate.

## Run once in an already configured owner environment

Use the existing authorized OPENROUTER_API_KEY and DATABASE_URL (or MCP_BACKEND_URL). Do not paste secrets into an issue, PR or test log. No new key or production setting change is needed. From this branch:

```sh
RUN_ISOLATED_MU=1 npx vitest run --project live __tests__/live/council-mu-isolated.live.test.ts --retry 0
```

The existing live setup loads .env.local without printing it. This test opts in explicitly, rejects known placeholder keys, does not retry the full run and has a ten-minute deadline. It calls the route function locally, never POSTs the production publishing endpoint. It uses the actual route orchestration, actual runSeat client and actual MU grounding builder. Auth/entitlement and quota are isolated test fixtures, not real account-access validation. It does not consume the app's daily deliberation counter; free-provider request limits still apply.

## Guardrails

- Fetches the official model catalog immediately before execution. Only current :free entries with all pricing fields zero may reach the model endpoint. Missing/retired primaries return a local 404 and exercise the real fallback chain.
- Every actual model request adds provider.max_price prompt/completion/request/image caps of zero. No paid model fallback, plugins or tools. Maximum 80 outbound model attempts across all repairs, critiques, synthesis, verdict samples and fallbacks. Stops if a response reports nonzero cost.
- Database adapter accepts only SELECT. Signal-cache warming and grounding telemetry cannot write. Session creation returns null; saving messages/verdicts throws and is asserted uncalled. Prior council records are omitted deliberately. No public MU verdict is published or replaced.
- Actual existing grounding sources must supply MU data. The real builder refuses missing data. Safe evidence includes per-seat brief length and dated-source lines, but never the credential or database URL. Check those date lines for staleness before treating the result as current market analysis. Availability of grounding does not guarantee freshness.

## Evidence and interpretation

MU_EVIDENCE prints seat, requested/returned model identifiers, HTTP status, returned cost when available, latency, per-seat grounding source/date lines, and persistence/quota isolation. MU_RESULT prints status, degraded seats and reconciled verdict. Do not publish financial output as the owner's call. Keep raw outputs private unless the owner approves sharing.

Pass requires genuine nonempty responses from all five debate seats, four CHAIR calls (one synthesis plus three verdict samples), no degraded seats, and a valid reconciled direction. Repairs or dissent critiques may add calls. A fallback response proves that seat ran via that fallback, not that its assigned primary worked. Returned response model identifiers in attempts are the provider's provenance; runSeat's model field identifies the requested model. Failure or skip is not successful validation. This does not prove all financial claims correct, real login/entitlement enforcement, durable DB writes or published UI behavior.

Current preflight found T2 and RISK primaries absent from the model catalog. Real reachability and fallback outcomes remain unverified until run. The one unblocker is running this command where the owner's existing working model credentials and MU data access already exist.

References: https://openrouter.ai/api/v1/models ; https://openrouter.ai/docs/guides/routing/model-variants/free ; https://openrouter.ai/docs/guides/routing/provider-selection .
