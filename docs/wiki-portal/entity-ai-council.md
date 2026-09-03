---
date: 2026-09-02
type: entity
tags: [council, llm, deliberation, openrouter]
sources: [../../app/api/council/deliberate/route.ts, ../../app/api/council/route.ts, ../../app/api/council/sample/route.ts, ../../app/api/council/public/route.ts, ../../lib/openrouter.ts, ../../lib/council-verdict.ts, ../../lib/council-critique.ts, ../../lib/council-validate.ts, PR#37, PR#97]
---

# Entity: AI Council (`app/api/council/*` + `lib/openrouter.ts`)

The portal's six-seat AI deliberation system. Four entry points share the same seat definitions and model-fallback machinery:

- **`POST /api/council`** — single-seat quick-ask (T1 or T2 only), used by the Hold/Fold ticker detail panel. Returns one structured verdict.
- **`POST /api/council/deliberate`** — the full six-seat debate: parallel round-1 answers → diff-shaped round-2 critique → CHAIR synthesis → separate verdict-only vote.
- **`GET /api/council/sample`** — unauthenticated, cached (6h) T1+T2 pair for the public landing page's `#council` section. As of PR #97, simulates a **$10,000 position in MOO** (VanEck Agribusiness ETF) rather than a bare SPY signal prompt — see "The landing sample" below.
- **`POST /api/council/public`** — unauthenticated, ticker-only, single RISK-seat demo with a 1/day IP quota; the prompt is built entirely server-side (never from free-text input) to close the prompt-injection door a public endpoint would otherwise open.

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

## The landing sample (PR #97)

`/api/council/sample` previously ran T1/T2 against a bare `Analyze SPY...` prompt built from a single `GET {gcp3}/signals/SPY` fetch. It now runs the same two seats against an explicit **$10,000 MOO investment simulation** framing (`buildSimulationPrompt`), grounded in whatever live `ai_summary`/`ai_score`/`ai_action` GCP3 returns for MOO, with `SIMULATED_CAPITAL_USD = 10_000` hardcoded server-side — never user input, preserving the same "server-built prompt only" constraint `/api/council/public` documents. The response now carries `ticker`, `fundName`, and `simulatedCapitalUsd`, and `app/page.tsx`'s `#council` panel renders "Live simulation: $10,000 into MOO (VanEck Agribusiness ETF) today" instead of a hardcoded "SPY" label.

The real yfinance scan + 10y investment/backtest simulation this was built from — and a much deeper full six-seat run (all `DEBATE_SEATS` + CHAIR + verdict) against the same MOO data — live in `docs/moo-council-simulation-todo.md` and `docs/moo-council-run/`. That deeper run is what surfaced [[entity-openrouter-client]] failures #8 and #9 (dead `SEAT_MODELS.QUANT`, and `runSeat` accepting an empty 200 as success) — this landing-sample change and those `lib/openrouter.ts` fixes shipped together in the same PR because the fixes were found *while* building this feature, not as separate unrelated work.

Two things observed live during this work remain open, not yet fixed (see [[entity-openrouter-client]] failure #9's "Not fixed" note): when GCP3 has no live MOO data, T1 fabricates plausible-looking figures instead of admitting it has none, and a reasoning-model seat can spend its entire token budget narrating whether it's "allowed" to answer without DATA rather than producing the four required fields.

## Where used

- `app/dashboard/holdfold/HoldFoldClient.tsx` — calls `/api/council` per seat (T1/T2), renders the four-field verdict as a `<dl>`
- `app/dashboard/signals/SignalsClient.tsx` — calls `/api/council`, renders only the raw answer prose
- `app/page.tsx` — calls `/api/council/sample` server-side for the public `#council` landing section (see "The landing sample" above)
- `/api` routes gate `council`/`deliberate` on the `nu_ai` entitlement + a daily quota (`checkAndBumpQuota`); `sample`/`public` are unauthenticated with their own quota/caching

## The verdict format

`StructuredVerdict` (`lib/council-verdict.ts`) is four fields as of PR #37: `OUTLOOK` / `BECAUSE` / `INVALIDATION` / `EXECUTION` — down from six. See [[decision-four-field-verdict-scaffold]]. `parseStructuredVerdict()` strips chain-of-thought, requires all four fields, and rejects any `OUTLOOK` outside the `bullish|bearish|neutral` enum (previously it silently defaulted to neutral).

## Known failures

1. **Seat returns empty/unparsable after retry.** In `/api/council` a failed parse after one strict-format retry returns `council_response_invalid` (502) rather than rendering raw text — this is the fix for the 2026-07-15 chain-of-thought leak. In `deliberate`, an empty seat lands in `degradedSeats` and the CHAIR is told which seats were unavailable.
2. **All models in `FREE_MODEL_CHAIN` fail.** `runSeat` throws after exhausting the chain; `deliberate` isolates this per-seat, but if CHAIR synthesis itself fails the whole route returns 503 `Council synthesis unavailable`.
3. **A caller stops reading the route's response shape.** Distinct from 1: the
   council succeeds and the verdict is persisted, but the client renders an
   error because it reads a key the route no longer returns. Broke signal-card
   "Go Deeper" for ~6 weeks — see
   [[incident-2026-08-31-signals-go-deeper-contract-drift]].
4. **Grounding silently degrades.** If every grounding source misses, the brief falls back to "reason from general knowledge and say so" with no hard failure — see [[entity-grounding-tier-ladder#known-failures]].

## Open questions

- ❓ The `SEAT_MODELS` primary assignments predate the §10 residual-difficulty analysis; only the CHAIR verdict call currently uses `SMALLEST_MODEL`. Should T1/T2/MACRO be reassigned once Layer-B flag-rate telemetry exists?
- ❓ RISK's counter-slice uses the *live signal* direction as the majority proxy at brief-build time (there's no real majority yet). Does that match the actual round-1 majority often enough to be useful?
- ❓ No live-model golden tests run in CI — the deterministic Vitest suite covers parsing/critique/validation logic but not whether a real 7B produces parseable output. Deferred in PR #37.
- ❓ Nothing asserts that each caller of `/api/council` still reads the shape the route returns. This is cheap to cover deterministically and would have caught [[incident-2026-08-31-signals-go-deeper-contract-drift]] on day one.

## See also

- [[entity-grounding-tier-ladder]] — where each seat's brief comes from
- [[concept-small-model-prompting]] — the prompting techniques every seat now follows
- [[concept-verdict-repair-loop]] — the numeric/trade-logic validators
- [[decision-four-field-verdict-scaffold]] — why 4 fields, not 6
- [[decision-split-chair-synthesis-and-verdict]] — why the verdict is a separate call
- `gcp3-mobile/docs/wiki-mobile/entity-council-composer.md` — the mobile council this was ported from
- `../moo-council-simulation-todo.md` — the MOO ETF simulation build-out this PR shipped step 1 of
- [[entity-openrouter-client]] failures #8, #9 — the two production defects this PR's simulation run found and fixed
