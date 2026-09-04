---
date: 2026-09-02
type: entity
tags: [openrouter, llm, models, seats, fallback, free-tier]
sources: [../../lib/openrouter.ts, ../../scripts/refresh-free-models.mjs, ../../__tests__/openrouter-fallback.test.ts, ../../__tests__/live/openrouter-resilience.live.test.ts, PR#29, PR#30, PR#37, PR#97]
---

# Entity: OpenRouter Client (`lib/openrouter.ts`)

The single module that talks to OpenRouter. Owns the seat definitions, the seat→model map, the free-tier fallback chain, and `runSeat()` — the primitive every council call goes through.

## What it is

- **`CouncilSeat`** — `'T1' | 'T2' | 'RISK' | 'MACRO' | 'QUANT' | 'CHAIR'`.
- **`DEBATE_SEATS`** — the five that answer in round 1 (`T1, T2, RISK, MACRO, QUANT`); CHAIR only synthesizes.
- **`SEAT_SYSTEM`** — one system prompt per seat, all written to the [[concept-small-model-prompting]] contract.
- **`SEAT_MODELS`** — each seat's primary model (free-tier except T1 — see "Model assignment" below).
- **`FREE_MODEL_CHAIN`** — the ordered fallback list every seat drops through on failure.
- **`SMALLEST_MODEL`** — `= SEAT_MODELS.QUANT`, reused for the 3× CHAIR verdict vote.
- **`CHAIR_VERDICT_SYSTEM`** — the tiny JSON-only prompt for the separate verdict call ([[decision-split-chair-synthesis-and-verdict]]).

## Model assignment

`SEAT_MODELS` spends the best free model on the one irreducibly hard job and the smallest on tasks reduced to pure classification ([[concept-small-model-prompting]] §10):

Current as of **PR #75 (2026-08-19)**, when five of six were replaced (failure #5):

| Seat | Primary model | Size | Vendor | Rationale |
|---|---|---|---|---|
| T1 | `cohere/command-r7b-12-2024` | 7B | cohere | structured 4-field output |
| T2 | `google/gemma-4-31b-it:free` | 31B | google | secular thesis reasoning |
| RISK | `z-ai/glm-5.2:free` | — | z-ai | adversarial framing |
| MACRO | `google/gemma-4-26b-a4b-it:free` | 26B | google | rotation/rates narrative |
| QUANT | `liquid/lfm-2.5-2.6b:free` | 2.6B | liquid | numbers-only → smallest model (updated PR #97, was `nvidia/nemotron-nano-9b-v2:free`) |
| CHAIR | `nvidia/nemotron-3-ultra-550b-a55b:free` | 550B | nvidia | synthesis (hardest job) |

The **Vendor** column is load-bearing, not decoration. `FREE_MODEL_CHAIN` is all-nvidia (failure #6), so if the seats were too, one account-tier outage would remove every primary *and* its entire fallback simultaneously. Four vendors across six seats means such an outage degrades some seats to the chain rather than all of them at once.

The CHAIR *verdict* call (not synthesis) uses `SMALLEST_MODEL`, because a verdict reduced to a single JSON line is classification, not reasoning.

## `runSeat` — the fallback primitive

`runSeat(seat, messages, apiKey, maxTokens, temperature, modelOverride?)` builds `[primaryModel, ...FREE_MODEL_CHAIN]` (deduped) and tries each in order, falling through on **402 / 429 / 5xx** with a **20 s per-model timeout**. Five of six seats use `:free` models; T1 (`cohere/command-r7b-12-2024`) is a paid model chosen for structured output quality. A full ~11-call deliberation costs **~$0.20–$0.50** (primarily from T1), not quite meeting the WS2.6 $0 intent but balancing output reliability. See [[decision-free-tier-model-chain]] "Consequences" for cost implications.

## Where used

- [[entity-ai-council]] — both `/api/council` and `/api/council/deliberate` route every model call through `callCouncilSeat` / `runSeat`
- [[entity-grounding-compiler]] — the compile script uses the same free-tier philosophy (`COMPILE_MODEL` defaults to a `:free` model) but its own fetch, not this client

## Known failures

1. **Whole chain exhausted.** If every model in `[primary, ...FREE_MODEL_CHAIN]` fails, `runSeat` throws. `deliberate` isolates this per-seat via `Promise.allSettled`; a failed CHAIR synthesis, however, returns a route-level 503.
2. **Free models rotate / disappear.** OpenRouter's free roster churns. `scripts/refresh-free-models.mjs` (cron, Mondays 06:17 UTC) refreshes `FREE_MODEL_CHAIN`; the grounding compile runs at 06:23, after it, deliberately. PR #44 (2026-07-27) swapped `google/gemma-4-31b-it:free` for `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` — routine churn, not an incident.
3. **Account-wide daily quota, not per-model.** OpenRouter's free tier caps the whole API key at **50 requests/day** (not per-model) unless ≥10 credits are added, which raises it to 1000/day. When exhausted, *every* model in `[primary, ...FREE_MODEL_CHAIN]` 429s simultaneously — `refresh-free-models.mjs`'s live probe (and any caller) sees "0 working models" and can't tell that apart from an actual dead roster. Observed 2026-07-30: the refresh script's own probe run burned into this ceiling. `X-RateLimit-Reset` on the 429 response headers gives the exact reset timestamp (UTC midnight, key-specific). See [[decision-free-tier-model-chain]] "Validated by" — this is the concurrency risk that section flagged as unvalidated.
4. **Chain-of-thought leak.** Reasoning-style free models emit `<think>` blocks. This client doesn't strip them — [[entity-ai-council]]'s `stripReasoning` does, downstream.
5. ~~**`SEAT_MODELS` has rotted — 5 of 6 primaries no longer exist**~~ — **fully resolved 2026-08-19 (PR #75).** History retained because the *why it stayed invisible* generalizes. (Confirmed 2026-08-18; fallback fixed that day, ids replaced the next.) Checked against the live 412-model catalog: only T1's `cohere/command-r7b-12-2024` is still present. T2/MACRO/CHAIR's `qwen/qwen3-next-80b-a3b-instruct:free`, RISK's `meta-llama/llama-3.3-70b-instruct:free`, and QUANT's `mistralai/mistral-7b-instruct:free` are all gone. The consequence is worse than a slow seat: a retired id returns **404**, which is *not* in `runSeat`'s retry set (`402/429/5xx`), so it `break`s the loop — **a dead primary means the seat never reaches its fallback chain at all**. `refresh-free-models.mjs` has been faithfully maintaining `FREE_MODEL_CHAIN` while the other model list in the same file rotted untouched, because the script only knows about the chain. Two fixes were identified; **the first is now done** (2026-08-18): `runSeat` gained `isRetryableStatus(status, isPrimary)`, which makes 404/400 retryable *only in the primary position* — a retired seat model now falls through to the chain (with a loud `console.warn` naming `SEAT_MODELS`, since the seat still answers and the rot is otherwise invisible), while the same status inside the chain stays fatal, because those ids are refreshed weekly against the live catalog so a 404 there means a malformed request that will fail identically on every remaining model. Live-verified: QUANT's retired `mistralai/mistral-7b-instruct:free` now warns and advances instead of disabling the seat. **Resolved 2026-08-19 (PR #75)** — both halves. The five stale ids are replaced with live models chosen against the §10 size intent (550B on CHAIR synthesis, 9B on QUANT and therefore `SMALLEST_MODEL`) *and* deliberate vendor spread (cohere / google / z-ai / nvidia), so a single account-tier outage degrades some seats rather than all six. And `refresh-free-models.mjs` now audits `SEAT_MODELS` against the live catalog on every weekly run, exiting 1 when a seat is dead — it reports rather than rewrites, because a seat assignment encodes size and vendor intent a script cannot infer, and substituting "some model that exists" would satisfy the check while quietly discarding both. The audit queries the **full** catalog, not `fetchFreeModels()`'s `:free`-only list: T1 legitimately runs a paid model that the free-only set would have reported as dead.
6. **`FREE_MODEL_CHAIN` is single-vendor — nominal depth 4, real depth 1 (confirmed 2026-08-18).** All four entries are `nvidia/*:free`, so the chain has no independence against any failure landing at the vendor or account-tier level — which is the failure that actually happens (failure #3). Observed: on daily-quota exhaustion all four returned 429 within ~100 ms of each other and the fallback loop absorbed nothing. This is not bad luck: `refresh-free-models.mjs` ranks purely on "$0 and probes healthy" with **no vendor-diversity constraint**, so it reproduces whatever monoculture dominates the free tier that week. The catalog held 18 $0 models at the time (`nvidia:8, google:4, poolside:2, cohere:1, openai:1, …`) — diversity was available and simply not requested. Fix: a per-vendor cap (max 2 of N) in the refresh ranking. **Still unfixed as of PR #75** — though two things changed around it. The catalog shifted on its own, so a dry run now ranks `google/gemma-4-31b-it:free` into slot 3, giving the chain incidental 2-vendor depth; that is luck, not a constraint, and the next refresh can undo it. More usefully, `SEAT_MODELS` is now *deliberately* spread across cohere/google/z-ai/nvidia (failure #5), so an nvidia-wide outage degrades some seats to the chain rather than removing every primary and its fallback at once. The chain itself still has no vendor-diversity constraint.

7. **A non-ASCII `X-Title` silently disabled the whole fallback chain (found and fixed 2026-08-19, PR #72).** One caller passed `"NuWrrrld Precompute — Portfolio Health"`. HTTP header values are ByteStrings, so the em-dash (U+2014) made `fetch()` throw a **TypeError before the request was ever sent** — not a network error, a construction error. Inside `fetchWithModelFallbackChecked`'s loop that lands in the `catch` that treats a throw as an unreachable model and `continue`s, so *every* model in the chain "failed" without ever recording a status, and the chain ended by reporting its **initial** `lastStatus = 503`.

   Two consequences, both worse than the missing request: the real upstream state (OpenRouter was answering **429** — daily quota exhausted, failure #3) was completely invisible, and `precompute-ai`'s `isQuotaExhausted()` matches on `/OpenRouter 429/`, so the early-stop never fired and the run kept spending subjects against an allowance that was already gone. A quota guard defeated by a typographic character in a log label.

   Fixed at both levels: the offending title is ASCII, and `toHeaderSafe()` now sanitizes every `X-Title` (em/en dashes → `-`, other non-Latin-1 → `?`) so no future caller can reintroduce it. Only this one caller was affected — `/api/brief`, `/api/portfolio/health-ai` and `/api/nuai` all pass ASCII titles. Verified end-to-end: the same request now reports `OpenRouter 429`, `quotaExhausted: true`, and stops after 1 subject instead of attempting 3.

   Worth generalizing: this is the third failure on this page whose *symptom* pointed at the wrong layer (cf. #5's 404-vs-fallback and #3's "0 working models"). The chain's habit of collapsing distinct causes into one terminal status is the recurring hazard, not any single bug.

8. **`SEAT_MODELS` rotted again — QUANT dead (found and fixed 2026-09-02, PR #97).** `nvidia/nemotron-nano-9b-v2:free` (QUANT's primary, and therefore `SMALLEST_MODEL`) started 404ing. This is the *same class* of failure as #5, recurring less than a month after #5's fix and its "add a CI check that pings SEAT_MODELS weekly" open item — `scripts/refresh-free-models.mjs` already has the audit (`--dry-run` prints `DEAD`/`ok` per seat) but nothing runs it on a schedule or fails a build on it, so the fix from #5 caught this occurrence only because a human ran the audit by hand while chasing an unrelated task (a MOO ETF simulation, [[../moo-council-simulation-todo.md|docs/moo-council-simulation-todo.md]]). Fixed by repointing QUANT at `liquid/lfm-2.5-2.6b:free`, the smallest live $0 model in the catalog at the time — matching QUANT's "reduced to classification" role. **The CI-check open item from #5 is still open.**

9. **`runSeat` treated an HTTP 200 with an empty completion as success (found and fixed 2026-09-02, PR #97).** `fetchWithModelFallbackChecked` (the streaming path used by `/api/brief`, `/api/portfolio/health-ai`, `/api/nuai`) already treats a 200-with-zero-content-tokens as a failure and advances the chain — but `runSeat`, the non-streaming primitive every council seat call goes through, did not. A reasoning model in `FREE_MODEL_CHAIN` that spends its entire `max_tokens` budget on hidden chain-of-thought returns HTTP 200 with `choices[0].message.content === ""`; `runSeat` returned that empty string as a normal successful answer. Every caller that only checks "did I get an answer" (not "is it non-empty") then persisted, transcripted, and rendered a blank seat as if it had genuinely deliberated and had nothing to add — indistinguishable from a seat that legitimately abstained.

   Compounded by the default `max_tokens` (500) being too low for the current all-reasoning `FREE_MODEL_CHAIN` composition: at 500, three of five debate seats returned empty in a live test run, and the CHAIR verdict call (100 tokens, formerly on the now-dead QUANT-adjacent id) never got far enough to emit valid JSON in any of 3 samples — `reconcileVerdicts` silently returned `{direction: null, …}`.

   Fixed: `runSeat` now treats an empty/whitespace `answer` on a 200 the same as a retryable failure and advances the chain (mirroring `fetchWithModelFallbackChecked`'s `anyEmptyModel` logic), throwing `"OpenRouter: council {seat} — every model returned an empty completion"` only if *every* model in the chain comes back empty. Default `max_tokens` raised 500→1200 in `runSeat`/`callCouncilSeat`, and the deliberate route's explicit per-call overrides raised proportionally (repair 500→1200, round-2 critique 200→500, CHAIR synthesis 400→1000, verdict 100→300) — free, since these are $0 models. Live-verified after the fix: `__tests__/live/council-verdict.live.test.ts` passed cleanly (0 failures) against the real catalog.

   **Not fixed**: a model that emits visible reasoning *as* `content` (not into a separate `reasoning` field) still burns its budget without producing the four required fields — the empty-answer fix stops the *silent* failure but not this one. Observed live (dev-server end-to-end test, no real MOO signal data available that run): a reasoning-model T2 spent all 1200 tokens narrating whether it was "allowed" to answer without DATA, never emitting `OUTLOOK:`/etc. A stricter system-prompt rewrite or a model-aware reasoning-strip is needed; deferred because a crude strip risks breaking the prose-only seats (RISK/MACRO/CHAIR) that are supposed to write free text.

   Also observed live in the same test: when there is genuinely no DATA (GCP3's `/signals/MOO` was 503 at the time), T1 fabricated a quote and invented price levels rather than admitting no data — the `_GROUND` "never invent evidence" instruction has no fallback behavior defined for the *zero-DATA* case, only for the has-DATA case. Open item, not yet fixed.

## Open questions

- ❓ `SEAT_MODELS` primary assignments predate the §10 residual-difficulty analysis. Should T1/T2/MACRO be re-tuned once Layer-B flag-rate telemetry exists? (mirrors an open question on [[entity-ai-council]])
- ❓ The 20 s per-model timeout × 4 models = up to 80 s worst-case per seat. Is that within the route's own timeout budget under a full chain-failure cascade?
- ✅ Resolved 2026-08-18: a 404 on a *primary* seat model now falls through to the chain; within the chain it stays fatal. The status alone cannot distinguish "retired id" from "malformed request" — position can, and that is what `isRetryableStatus(status, isPrimary)` encodes.
- ❓ Should `SEAT_MODELS` be a hand-written constant at all, or generated data the weekly job owns (measured latency/success per model)? Failure #5 is what happens when a human-edited literal has no scheduled maintainer — failure #8 is the same thing happening again.
- ❓ (new, PR #97) `scripts/refresh-free-models.mjs --dry-run` already detects a dead `SEAT_MODELS` entry and prints it — should this run in CI on a schedule and fail the build, rather than only being useful when someone happens to run it by hand?
- ❓ (new, PR #97) Live-tested against the real catalog with the #9 fixes applied, `__tests__/live/model-chain.live.test.ts`'s 20s `SEAT_LATENCY_BUDGET_MS` failed 6/20 assertions (MACRO/QUANT/CHAIR each hit 20.7–23.8s at least once) — is 20s still the right SLA for an all-reasoning-model chain, or does the chain need at least one fast non-reasoning entry ahead of the slow ones? (This live suite is excluded from `npm test`/CI, so nothing broke — but the tension is real and will recur every time `max_tokens` is raised further.)

## See also

- [[entity-ai-council]] — the primary consumer
- [[concept-small-model-prompting]] — the contract every `SEAT_SYSTEM` prompt follows
- [[decision-free-tier-model-chain]] — why everything is `:free`
- [[decision-split-chair-synthesis-and-verdict]] — why CHAIR calls twice with two different prompts
- [[concept-free-tier-resilience]] — the pattern failures #3, #5 and #6 all stress
- `../gha-modal-core-feature-coverage.md` — the scheduled-maintenance argument failures #5 and #6 motivate
- `../../__tests__/live/openrouter-resilience.live.test.ts` — the suite that found #5 and #6
- `../../__tests__/live/model-chain.live.test.ts` — the suite that surfaced the latency-SLA open question in #9
- `../moo-council-simulation-todo.md` — the MOO ETF simulation task that found failures #8 and #9 as a side effect
