---
date: 2026-07-18
type: entity
tags: [council, llm, deliberation, openrouter]
sources: [../../app/api/council/deliberate/route.ts, ../../app/api/council/route.ts, ../../lib/openrouter.ts, ../../lib/council-verdict.ts, ../../lib/council-critique.ts, ../../lib/council-validate.ts, PR#37]
---

# Entity: AI Council (`app/api/council/*` + `lib/openrouter.ts`)

The portal's six-seat AI deliberation system. Two entry points share the same seat definitions and model-fallback machinery:

- **`POST /api/council`** — single-seat quick-ask (T1 or T2 only), used by the Hold/Fold ticker detail panel. Returns one structured verdict.
- **`POST /api/council/deliberate`** — the full six-seat debate: parallel round-1 answers → diff-shaped round-2 critique → CHAIR synthesis → separate verdict-only vote.

## What it is

Six seats, each a distinct system prompt in `SEAT_SYSTEM` (`lib/openrouter.ts`):

| Seat | Role | Grounding slice ([[entity-grounding-tier-ladder]]) |
|---|---|---|
| T1 | short-term trader (1–60d) | horizon `t1`, `traderFilter: 'T1'` |
| T2 | long-term investor (2mo–5y) | horizon `t2`, `traderFilter: 'T2'` |
| RISK | devil's advocate | counter-slice: pack rows whose `direction` opposes the live signal |
| MACRO | rates / dollar / rotation | Tier 1/2 FTS only (macro isn't in the taxonomy) |
| QUANT | numbers-only interpreter | no pack rules — numbers only |
| CHAIR | synthesizer + verdict | reads the whole transcript |

`runSeat(seat, messages, apiKey, maxTokens, temperature, modelOverride?)` runs one seat against `SEAT_MODELS[seat]`, falling back through `FREE_MODEL_CHAIN` on 402/429/5xx with a 20s per-model timeout. All models are free-tier to keep a full deliberation (~11 calls) at $0.

## The deliberate flow (five stages)

1. **Ground** — each seat gets its *own* sliced brief via `buildGroundedBrief(question, ticker, seat)` ([[entity-grounding-tier-ladder]]).
2. **Round 1** — `DEBATE_SEATS` answer in parallel, per-seat isolated with `Promise.allSettled`. T1/T2 answers pass through the [[concept-verdict-repair-loop]] before being accepted.
3. **Round 2** — diff-shaped critique ([[concept-small-model-prompting]] §8): `computeDisagreements()` finds who actually disagrees with the majority *in code*; only those seats get a `DECIDER / IF_RIGHT / CHANGE_MY_MIND` arbitration prompt. Agreeing seats skip round 2 entirely.
4. **Synthesis** — CHAIR does one prose-only call (best free model), then the verdict is a **separate** call ([[decision-split-chair-synthesis-and-verdict]]) run 3× on `SMALLEST_MODEL`, majority-voting `direction` and taking the *minimum* confidence.
5. **Persist** — session, messages, verdict → Neon (`lib/council-db.ts`), non-fatal if unavailable.

## Where used

- `app/dashboard/holdfold/HoldFoldClient.tsx` — calls `/api/council` per seat (T1/T2), renders the four-field verdict as a `<dl>`
- `app/dashboard/signals/SignalsClient.tsx` — calls `/api/council`, renders only the raw answer prose
- Both routes gate on the `nu_ai` entitlement + a daily quota (`checkAndBumpQuota`)

## The verdict format

`StructuredVerdict` (`lib/council-verdict.ts`) is four fields as of PR #37: `OUTLOOK` / `BECAUSE` / `INVALIDATION` / `EXECUTION` — down from six. See [[decision-four-field-verdict-scaffold]]. `parseStructuredVerdict()` strips chain-of-thought, requires all four fields, and rejects any `OUTLOOK` outside the `bullish|bearish|neutral` enum (previously it silently defaulted to neutral).

## Known failures

1. **Seat returns empty/unparsable after retry.** In `/api/council` a failed parse after one strict-format retry returns `council_response_invalid` (502) rather than rendering raw text — this is the fix for the 2026-07-15 chain-of-thought leak. In `deliberate`, an empty seat lands in `degradedSeats` and the CHAIR is told which seats were unavailable.
2. **All models in `FREE_MODEL_CHAIN` fail.** `runSeat` throws after exhausting the chain; `deliberate` isolates this per-seat, but if CHAIR synthesis itself fails the whole route returns 503 `Council synthesis unavailable`.
3. **Grounding silently degrades.** If every grounding source misses, the brief falls back to "reason from general knowledge and say so" with no hard failure — see [[entity-grounding-tier-ladder#known-failures]].

## Open questions

- ❓ The `SEAT_MODELS` primary assignments predate the §10 residual-difficulty analysis; only the CHAIR verdict call currently uses `SMALLEST_MODEL`. Should T1/T2/MACRO be reassigned once Layer-B flag-rate telemetry exists?
- ❓ RISK's counter-slice uses the *live signal* direction as the majority proxy at brief-build time (there's no real majority yet). Does that match the actual round-1 majority often enough to be useful?
- ❓ No live-model golden tests run in CI — the deterministic Vitest suite covers parsing/critique/validation logic but not whether a real 7B produces parseable output. Deferred in PR #37.

## See also

- [[entity-grounding-tier-ladder]] — where each seat's brief comes from
- [[concept-small-model-prompting]] — the prompting techniques every seat now follows
- [[concept-verdict-repair-loop]] — the numeric/trade-logic validators
- [[decision-four-field-verdict-scaffold]] — why 4 fields, not 6
- [[decision-split-chair-synthesis-and-verdict]] — why the verdict is a separate call
- `gcp3-mobile/docs/wiki-mobile/entity-council-composer.md` — the mobile council this was ported from
