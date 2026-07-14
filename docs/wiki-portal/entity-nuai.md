---
date: 2026-07-02
type: entity
tags: [nuai, chat, llm, openrouter, portal]
sources: [lib/nuai.ts, lib/openrouter.ts, app/api/nuai/route.ts, git log PR #16, #19]
---

# entity: Nu AI / AI Council (server-side)

## What it is

Two related but distinct AI surfaces live here:

**Nu AI chat** — `app/api/nuai/route.ts` gates on `hasEntitlement("nu_ai", tier)`
(see [[entity-subscription]]), enforces a per-user **daily token budget**
(`NU_AI_DAILY_TOKEN_BUDGET` from the shared `lib/nuai.ts`) via an **in-memory**
`Map` (`dailyUsage`) — the code's own comment flags this: *"For production
this should be persisted in a KV store (e.g. Vercel KV)"* — meaning the budget
resets on every cold start / deploy, not just daily. `isRefusedQuery` (shared
with mobile) pre-filters before any model call.

**AI Council** (`lib/openrouter.ts`) — two seats, T1 (short-term trader) and
T2 (long-term investor), each with a dedicated system prompt demanding
concise (~180 word), data-grounded, non-advice-framed output.
`fetchWithModelFallback` retries through `FREE_MODEL_CHAIN` on 429/5xx only —
other errors propagate immediately (no silent retry-and-hide).

**Discrepancy found this sync**: `FREE_MODEL_CHAIN`'s code comment lists
`[qwen, llama-3.3-70b, mistral-7b]`, but the git log's PR #19 title says
*"three-model AI fallback chain (Qwen → Cohere → Mistral)"* — Llama vs. Cohere
disagree. `SEAT_MODELS.T1` is `cohere/command-r7b-12-2024` (not in
`FREE_MODEL_CHAIN` at all — it's a *paid* primary, separate from the free
fallback chain). This suggests the "three-model fallback" in the PR title
refers to a different or updated list than what's currently in the file, or
the PR title is describing the seat-primary + fallback combination loosely.
**Needs direct clarification**, flagged rather than guessed at.

## Keeping FREE_MODEL_CHAIN fresh (automated)

`FREE_MODEL_CHAIN` is not hand-maintained. `scripts/refresh-free-models.mjs`
pulls OpenRouter's catalog, keeps only `$0`/`:free` models, **live-probes** each
(a 1-token completion — a `$0` price still returns 402/429 when quota-limited,
so pricing alone isn't trusted), ranks the survivors by a preference list
(llama-3.3-70b → qwen3 → deepseek → gemma → mistral → phi-3), and rewrites the
`FREE_MODEL_CHAIN` block. A safety rail refuses to write a chain with fewer than
one working model (exits non-zero, leaves the file intact).

PR #28 adds `scripts/run-refresh-remote.sh` (clone → refresh → open/update a PR
only if the chain changed) plus deploy artifacts under
`deploy/free-model-refresh/` to run it **weekly on three independent
platforms — GCP Cloud Run Job, Modal, and a Zo automation** — so no single
scheduler outage lets the chain rot. Each platform needs two secrets:
`OPENROUTER_API_KEY` and a GitHub PAT (`{github-pat}`) with Contents + Pull
requests write on this repo.

## Where used

- `/dashboard/nuai` chat UI
- Hold/Fold council seats — see [[entity-holdfold]]
- `app/api/council/route.ts` and `app/api/council/sample/route.ts`

## Known failures

- Token budget resets on cold start (by design comment, not yet fixed) —
  meaning a user could exceed the intended daily cap across multiple
  deploys/restarts in a day. Not an incident yet, but a known gap.

## Open questions

- ❓ Resolve the `FREE_MODEL_CHAIN` vs. PR #19 title discrepancy (Llama vs.
  Cohere) — re-read the diff at commit `312086d` directly.
- ❓ Is there a plan to move `dailyUsage` to a real KV store, or is in-memory
  accepted as good-enough given expected traffic?
- ❓ `gcp3-mobile`'s `entity-nuai.md` asks whether `NU_AI_DAILY_TOKEN_BUDGET`
  is enforced client-side or server-side — this page confirms **server-side**,
  in `app/api/nuai/route.ts`. That mobile-side open question can be marked
  resolved on next mobile wiki sync.

## See also

[[entity-subscription]], [[entity-holdfold]].
`gcp3-mobile/docs/wiki-mobile/entity-nuai.md` — shares `lib/nuai.ts` contract;
the budget-enforcement-location question there is answered here.
