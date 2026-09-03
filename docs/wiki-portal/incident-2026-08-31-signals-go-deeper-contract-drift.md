---
date: 2026-08-31
type: incident
tags: [council, signals, contract-drift, response-shape, test-coverage, silent-failure]
sources: [../../app/dashboard/signals/SignalsClient.tsx, ../../app/api/council/route.ts, ../../app/dashboard/holdfold/HoldFoldClient.tsx, ../../lib/shared/councilErrors.ts, PR#34, PR#37]
---

# Incident — "Go Deeper" on Signal Cards Silently Dead for Six Weeks

## Date & severity

2026-08-31 (discovered). Introduced 2026-07-15. **Medium-high** — a paid
(`nu_ai`-gated) feature was 100% broken on one surface for ~6 weeks, and every
attempt still billed a full OpenRouter call before failing.

## What happened

Clicking **"✦ Go deeper — T1 Council analysis"** on any signal card always
rendered *"Council returned an empty response — try again."* The council was
never actually failing: the model answered, the answer parsed, the verdict was
persisted to the ledger. Only the render failed. Retry never helped, because
the failure was deterministic and client-side.

The user-visible symptom pointed at the model; the cause was in the caller.

## Root cause

When [[decision-four-field-verdict-scaffold]] moved T1/T2 from free prose to
the four labeled fields, `/api/council` changed its response shape from
`{ answer }` to `{ verdict, model, seat }`. The route has **two** consumers.
Only one was migrated:

- `HoldFoldClient` → read `data.verdict`. Worked.
- `SignalsClient` → still read `data.answer`. Always `undefined`.

`SignalsClient` then coerced the missing key with `?? ""` and fed it to an
emptiness guard, so a *successful* 200 was converted into an error state by the
client's own fallback. The `?? ""` is what made this silent: without it, the
render would have thrown visibly on day one.

Three things let it survive:

1. **No test covered `handleGoDeeper`.** Hold/Fold had ~8 seat tests; the
   signals path had zero. The deterministic suite stayed green throughout.
2. **The failure was indistinguishable from a real degradation.** The message
   it produced is a plausible thing for a small model to cause, so the symptom
   read as a known-failure mode (see [[entity-ai-council#known-failures]] §1)
   rather than a bug.
3. **Contract drift is invisible to `tsc`** when the response is `await
   res.json()` — typed `any`, so reading a nonexistent key type-checks.

## Resolution

- `SignalsClient` reads `data.verdict` and renders all four fields as a
  definition list, matching Hold/Fold. A 200 without a verdict is now an
  explicit error rather than a blank.
- `ticker` is now passed on the signals quick-ask, so those verdicts are
  attributable in the ledger instead of keyed on a prompt-prefix.
- `COUNCIL_ERROR_MESSAGES` lifted to `lib/shared/councilErrors.ts` and shared.
  Signals had hand-rolled `Error ${status}` and never mapped
  `council_response_invalid` — the one code this route emits specifically.
- Six regression tests added over `handleGoDeeper`, including one asserting the
  exact success-path field values.
- Removed the `(~150 words)` prose tails from all three prompt builders. They
  contradicted `STRUCTURED_VERDICT_INSTRUCTIONS` ("output must start
  immediately with `OUTLOOK:` and contain nothing else") and drove the route's
  retry path. This affected the *working* Hold/Fold path too — a latent cost
  bug found while fixing the visible one.

## Impact on design

The four-field migration was validated by testing the **producer**
(`parseStructuredVerdict` has thorough coverage) while assuming the
**consumers** followed. With two consumers of one route, that assumption
silently held for one and broke for the other.

This sharpens the open question already recorded on
[[decision-four-field-verdict-scaffold]] and [[entity-ai-council#open-questions]]:
the missing CI coverage isn't only "does a real 7B emit parseable fields" — it's
also "does every caller still read what the route returns". The second is
cheap to test deterministically and would have caught this immediately.

A shared response-shape type between the route and its callers would have made
this a compile error. `await res.json()` returning `any` is the load-bearing
weakness.

## Open items

- ❓ Are there other `/api/*` routes whose response shape changed with only
  some callers migrated? The same `res.json()` → `any` pattern is repo-wide.
- ❓ Should `/api/council`'s response be a shared exported interface that both
  clients import, making drift a type error rather than a runtime blank?
- ❓ The `?? ""` coercion pattern converts missing data into a valid-looking
  empty value. Worth a lint rule on API-response destructuring.

## See also

- [[decision-four-field-verdict-scaffold]] — the format change that drifted
- [[entity-ai-council]] — the subsystem; §known-failures now distinguishes a
  real degradation from this class of caller bug
- [[concept-verdict-repair-loop]] — the server-side machinery that was working
  correctly the whole time
- [[concept-test-strategy]] — the coverage gap this exposes
