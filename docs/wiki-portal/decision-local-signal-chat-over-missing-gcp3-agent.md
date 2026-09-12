---
date: 2026-09-11
type: decision
tags: [signals, chat, gcp3, degradation, openrouter, cross-repo, contract-drift]
sources: [../../app/api/signals/[ticker]/chat/route.ts, ../../lib/signal-chat-local.ts, ../../__tests__/signal-chat-local.test.ts]
---

# Decision — Answer per-ticker signal chat locally instead of proxying to an endpoint gcp3 never had

## Decision

`POST /api/signals/{ticker}/chat` tries gcp3's agent first and treats it as a
**preferred optimisation rather than a dependency**. Any other outcome —
unreachable, non-2xx, or a 200 whose body lacks a non-empty `answer` — grounds
locally on `{gcp3-backend-url}/signals/{ticker}` (a path that *is* registered) and
answers through the portal's own OpenRouter client. `X-Signal-Chat-Source` names
the path that answered.

When grounding itself is unavailable the route returns `503`. It never asks a
model to answer about a ticker it was told nothing about.

## Date

**2026-09-11.**

## Context

The route was a pure proxy to `{gcp3-backend-url}/signals/{ticker}/chat`. That
endpoint does not exist on gcp3 and, as far as the evidence goes, never has: the
backend's live OpenAPI registers ~38 paths, and the only chat endpoints among them
are `/agents/swing/{run_id}/chat` and `/agents/growth/{run_id}/chat` — run-keyed,
a different contract, and not per-ticker.

So every call 404'd upstream and the route returned a flat
`503 { error: "signal chat unavailable" }`. That string is a plausible thing for a
degraded free-tier backend to produce, which is why the feature could be dead
since inception without anyone treating it as broken — the same camouflage as
[[incident-2026-08-31-signals-go-deeper-contract-drift]]. It surfaced only when
[[incident-2026-09-11-nulogdash-blind-sweep]] gave the sweep a working session and
the row turned red for the first time.

The precedent was already set, ten days of wiki-time earlier and in the same
repo: [[decision-local-portfolio-scoring-over-upstream-wait]] faced an identical
situation — a gcp3 route that was never registered, a portal that cannot deploy
gcp3, and data already within reach — and resolved it by owning the contract.
This decision is that one applied a second time, deliberately, rather than
re-litigated.

## Alternatives considered

- **Leave it proxying and wait for gcp3 to register the endpoint.** The status quo.
  Its cost is not the delay; it is that "waiting" had no owner, no date, and no
  visible cost, which is exactly the failure
  [[decision-local-portfolio-scoring-over-upstream-wait]] was written about.
- **Re-point at `/agents/swing/{run_id}/chat`.** Rejected: it needs a `run_id` from
  a swing-agent run this route has no part in, so the adapter would have to
  invent or pre-create a run per question. Wrong contract, and the coupling would
  be worse than the outage.
- **Reuse `/api/nuai` and drop the route.** Tempting — `nuai` is already grounded
  chat — but `nuai` is portfolio-scoped and open-ended, while this question is
  always "about this one ticker's signal." Folding them would lose the per-ticker
  grounding that makes the answer checkable, and would break existing callers.
- **Answer from the model with no grounding fetch.** Cheapest, and the one option
  actively rejected on principle: an answer about a ticker with no signal data is
  a fabrication with a data-backed voice, which
  [[concept-graceful-degradation]] rules out explicitly.
- **Return a clean 501 and hide the UI.** Honest, and briefly attractive. Rejected
  because the data needed to answer was already one reachable endpoint away —
  removing the feature would have been a larger change than fixing it.

## Consequences

- **The feature works, and says how.** `X-Signal-Chat-Source: upstream | local`
  mirrors `X-Portfolio-Health-Source`. An unlabelled substitute is the silent swap
  that made the portfolio-health outage invisible for 47 days.
- **Upstream can come back with no code change.** If gcp3 ever registers the
  agent, it resumes winning automatically — and because the upstream branch
  shape-checks for a non-empty `answer`, a *drifted* future implementation routes
  to local rather than forwarding an empty reply.
- **Degradation is stated in the prompt, not hidden from it.** gcp3 currently
  serves rule-based fallback signals for most tickers (`ai_degraded: true`,
  `prompt_version: "fallback_v1"`). The grounding block labels those timeframes
  as "rule-based fallback, not an AI read", because a model handed "buy @ 55%"
  with no qualifier narrates it as a considered AI judgement. This is the same
  reasoning as reporting coverage instead of folding it into a score.
- **A missing alignment score is omitted, not zeroed.** A rendered `0` would read
  to the model as "timeframes maximally disagree" — a fabricated finding from
  absent data. Pinned by test.
- **One more quiet coupling.** Per-ticker chat now depends on gcp3's
  `/signals/{ticker}` staying up. That is a narrower dependency than before (one
  documented endpoint instead of an unimplemented one), but it is still gcp3.
- **The answer is a different thing than the original design promised.** The gcp3
  agent was specified to call `explain_signal` as a tool before answering. The
  local path has no tool loop: it grounds once, then answers. `tool_calls` is
  therefore always `[]` on the local path — honest, and visible to any caller that
  reads it.

## Validated by

- `__tests__/signal-chat-local.test.ts` — the grounding block: degraded timeframes
  are named as fallbacks, a real AI read is not mislabelled, confidence renders as
  a percentage and tolerates absence, evidence summaries survive so claims can
  cite them, and a missing alignment score is omitted rather than printed as zero.
- `/nulogdash` sweep, 2026-09-11: `signal-chat` `pass` in 5.1–11.3s via the local
  path, after having been a hard `503` on every previous run.
- Direct probe of gcp3's OpenAPI confirming the absence of the upstream path
  (the evidence this decision rests on).

## See also

- [[decision-local-portfolio-scoring-over-upstream-wait]] — the same call, made first
- [[incident-2026-09-11-nulogdash-blind-sweep]] — how this was found
- [[incident-2026-08-31-signals-go-deeper-contract-drift]] — a feature dead behind a plausible error
- [[concept-graceful-degradation]] — the ladder this route now walks
- [[entity-openrouter-client]] — the client answering the local path
- [[entity-signal-data-plane]] — where `/signals/{ticker}` sits
