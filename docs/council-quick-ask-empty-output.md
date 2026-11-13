# Quick-ask Council503, Nov10

## Observed failure

At15:30:26.58EST Vercel runtime logs for `/api/council` recorded T1 OpenRouter fallback exhaustion. The aggregate message said every model was empty, but the implementation only proves at least one empty completion and no usable chain answer. It cannot establish each provider's status or whether reasoning consumed its budget. No live model request was made for this investigation.

Source: https://vercel.com/adam-aslans-projects/nuwrrrld-portal/logs

The `technical_signals@1.0.0` data is separate from quick-ask Council. Existing numeric signal facts are not replaced by a model response or an error fallback.

## Source change

Only authenticated T1/T2 quick asks request answer-only mode. For the three catalog-verified optional-reasoning models, send `reasoning.enabled=false`; leave mandatory/unknown reasoning models alone. Deliberation, arbitration, public demo and other transports retain their request options. No model replacements, increased token budget, additional retry, new key or paid fallback. Existing chain,1200token budget, timeout, format validation and repair counts remain. The route has a300second maximum for its existing bounded walks.

The public catalog on Nov10 identifies all three as $0 prompt/completion models supporting reasoning with mandatory=false:
- nvidia/nemotron-3.5-lightning:free
- nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
- dots-studio/dots-3-note-preview:free

Source: https://openrouter.ai/api/v1/models

Reasoning counts toward completion tokens and can leave empty content. Disabling optional reasoning addresses that supported failure mode without allocating more tokens. This is a mitigation, not proof that it was the sole cause of this production request. Source: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens

No usable content still fails503, never fake200. Stable failure codes distinguish missing configuration, no usable content, provider failure and invalid structured output. The new provider-attempt diagnostics include model/status/finish reason/reasoning-token count only, never reasoning text, prompts, credentials or headers; the existing route format-failure log still records a bounded 200-character response preview for debugging. Those diagnostics can distinguish a future length-budget failure from rate limits/provider errors. Existing signal data stays visible and unchanged.

## Validation and open gates

Mocked transport tests verify answer-only options, unchanged1200tokens/single request on success, unknown model preservation, mixed empty/rate-limited exhaustion and existing auth/fallback behavior. Route tests verify failure codes, no fake persisted answer and bounded format retry. Type/lint/direct Next build verified locally using inert DB settings and no migration hook. Full offline suite passes; live-provider and DB tests are skipped, not evidence of runtime success.

Independent different-family exact-head review, required CI, authorized merge and source-bound deployed proof are still required. No production invocation, paid model call, env/admin change, deployment or live persistence was performed. Actual provider recovery remains unverified until an authorized real request is observed.
