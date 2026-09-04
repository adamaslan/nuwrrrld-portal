# OpenRouter Integration Report

**Status:** current-state report (not a plan) · **Date:** 2026-09-04

Scope: every place OpenRouter is called today, across `nuwrrrld-portal` and
`gcp3`, with the model chains, fallback behavior, cost controls, and the
automation that keeps it current. For the migration plan (moving the
remaining Gemini path off gcp3, DB parity work), see
[openrouter-migration-and-db-parity-plan.md](openrouter-migration-and-db-parity-plan.md).

---

## 1. Where OpenRouter is called

### nuwrrrld-portal — single client, 10 call sites

Every AI call in the portal goes through **one** module: [lib/openrouter.ts](../lib/openrouter.ts). No other AI provider exists in the portal's source.

| Caller | Purpose |
|---|---|
| `app/api/council/route.ts` | Full 6-seat council deliberation |
| `app/api/council/deliberate/route.ts` | Streaming deliberation (SSE) |
| `app/api/council/public/route.ts`, `app/api/council/sample/route.ts` | Public/demo council runs |
| `app/api/nuai/route.ts` | Interactive Nu AI chat |
| `app/api/brief/route.ts` | Daily brief generation |
| `app/api/pipeline/followed-tickers/route.ts`, `.../followed-tickers-judge/route.ts` | Batch ticker scoring + judging |
| `app/api/pipeline/precompute-ai/route.ts` | Nightly precompute (fed by Modal/GHA, see §4) |
| `app/api/portfolio/health-ai/route.ts` | Portfolio health narrative |
| `app/api/health/route.ts` | Liveness probe against the OpenRouter API itself |
| `lib/council-critique.ts`, `lib/council-verdict.ts`, `lib/council-grounding.ts`, `lib/public-demo.ts` | Council orchestration helpers built on `fetchWithModelFallback` |

### gcp3 backend — provider-neutral gateway, OpenRouter as primary

`backend/llm/provider_router.py` is a small registry (`openrouter_qwen3`,
`mistral`, `gemini`) selected by `DEFAULT_LLM_PROVIDER_ORDER =
["openrouter_qwen3", "mistral", "gemini"]`
(`backend/config/agent_config.py`). `backend/llm/providers/openrouter.py`
implements the actual call — single model (`qwen/qwen3-235b-a22b`), no
fallback chain of its own; the chain is the provider list, not a model list.
The `gemini` entry is a stub that raises (`RuntimeError`) — see the
migration report for closing that off. **gcp3 does not yet share a model
chain or refresh script with the portal** — see §6.

---

## 2. Model chain and fallback logic (portal)

`fetchWithModelFallback()` in `lib/openrouter.ts` walks `FREE_MODEL_CHAIN`
in order, retrying on `402` (free-tier quota exhausted), `429` (rate
limited), and `5xx`; any other status is fatal and propagates immediately.

**Current chain** (refreshed weekly, see §3):
```
nvidia/nemotron-3-ultra-550b-a55b:free
nvidia/nemotron-3-super-120b-a12b:free
nvidia/nemotron-3-nano-30b-a3b:free
nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
```
This chain is **all-nvidia** — nominal depth 4, real depth 1 against a
vendor-level account failure. It exists as the *fallback of last resort*
after a seat's own primary model fails (see below), which is where the
real vendor diversity lives.

### Council seat → primary model assignment

Each of the 6 council seats has its own primary model, sized to the job and
spread across vendors so one vendor outage doesn't take down every seat at
once:

| Seat | Primary model | Job |
|---|---|---|
| T1 | `cohere/command-r7b-12-2024` | short-term trader |
| T2 | `google/gemma-4-31b-it:free` | long-term investor |
| RISK | `z-ai/glm-5.2:free` | devil's advocate |
| MACRO | `google/gemma-4-26b-a4b-it:free` | macro context |
| QUANT | `nvidia/nemotron-nano-9b-v2:free` | numeric-only interpretation (smallest model — pure classification) |
| CHAIR | `nvidia/nemotron-3-ultra-550b-a55b:free` | synthesis + verdict (largest model — the one irreducibly hard job) |

A dead primary silently degrades to `FREE_MODEL_CHAIN` rather than erroring
— which is a known trap (see the `qwen3-next-80b`/`llama-3.3-70b`/
`mistral-7b` incident noted in the source: retired model IDs 404'd for
weeks before `runSeat`'s retryable-status fix, and the council kept
answering the whole time, which is exactly what hid the rot). **This is why
§3's live-probe refresh exists.**

### CHAIR's two-call split

CHAIR runs twice per deliberation: one prose synthesis call (~180 words, no
JSON) and a second, separate verdict-only call (`CHAIR_VERDICT_SYSTEM`,
`max_tokens≈80`) that must return a single-line JSON object. Splitting them
means a malformed JSON line can never corrupt the synthesis, and vice
versa.

### Header safety (`toHeaderSafe`)

A real production incident, documented inline: an em-dash in one caller's
`X-Title` made `fetch()` throw *before the request was ever sent* (HTTP
header values are Latin-1 `ByteString`s). Inside the fallback loop that
throw looked identical to every model failing, so the batch reported "all
models in chain failed" while OpenRouter was actually returning 429 to
everyone — the true cause. `toHeaderSafe()` now replaces non-Latin-1
characters (em/en dash → `-`, everything else → `?`) before any header is
set.

---

## 3. Automation keeping the chain current

**`.github/workflows/refresh-free-models.yml`** — weekly (Mondays 06:17
UTC) plus manual trigger:

1. Runs `scripts/refresh-free-models.mjs` against the live OpenRouter
   catalog with `MODEL_CHAIN_SIZE=4`.
2. Keeps only models that are both **$0-priced** and pass a **live probe**
   (a real request that returns 200, not 402/429).
3. If the resulting chain differs from what's committed, opens a PR
   (`chore/refresh-free-models`) rewriting `FREE_MODEL_CHAIN` in
   `lib/openrouter.ts`. Merging redeploys via Vercel.
4. If nothing changed, no PR opens — silence means current.

This is the automated defense against the exact failure class described
above (retired/renamed model IDs silently degrading a seat).

---

## 4. Quota management: the precompute/interactive split

OpenRouter's free tier caps the **whole API key**, not per-endpoint —
batch AI work and interactive Nu AI chat share one bucket that resets at
UTC midnight. Batch work run in the afternoon would eat allowance a user
is actively waiting on.

**Design (documented in `deploy/precompute-ai/modal_app.py` and
`.github/workflows/precompute-ai.yml`):** a scheduled job runs a few
minutes after the UTC-midnight reset — when quota is freshest — generates
batch AI artifacts, and stores them in Neon. The app then serves those as
ordinary cached reads at zero additional quota cost, leaving the rest of
the day's allowance for calls a real user triggers.

Two equivalent implementations exist deliberately, **run one at a time,
never both** (doubles quota spend for identical output):

- **GitHub Actions** (`precompute-ai.yml`, cron `10 0 * * *`) — the simpler
  default, no extra account.
- **Modal** (`deploy/precompute-ai/modal_app.py`) — preferable if the job
  ever needs to outlive GHA's 6-hour ceiling or fan out per-ticker.

`MAX_SUBJECTS` (default 10) is an explicit outer bound, deliberately well
under the (unconfirmed) daily cap — the route that receives the call
enforces its own inner ceiling too, so the precompute job is architecturally
prevented from being the thing that exhausts the shared bucket.

---

## 5. Testing coverage

| Test | What it verifies |
|---|---|
| `__tests__/openrouter-fallback.test.ts` | Chain walk, retry-on-402/429/5xx, fatal-on-other-4xx |
| `__tests__/live/openrouter-resilience.live.test.ts` | Live call against real OpenRouter API |
| `__tests__/live/model-chain.live.test.ts` | Each `FREE_MODEL_CHAIN` entry is currently reachable |
| `__tests__/live/council-verdict.live.test.ts` | CHAIR's two-call split produces valid structured verdict |
| `__tests__/live/streaming.live.test.ts` | SSE deliberation path |
| `e2e/ci/refresh-free-models.spec.ts` | The refresh workflow's output is well-formed |
| `e2e/preflight/credentials.spec.ts` | `OPENROUTER_API_KEY` present before other live tests run |
| `e2e/frontend/nuai-fault-injection.spec.ts` | UI behavior when OpenRouter calls fail |

---

## 6. Gaps between portal and gcp3

The two codebases each built an OpenRouter integration independently and
have not converged:

| | Portal | gcp3 |
|---|---|---|
| Fallback unit | Model chain (`FREE_MODEL_CHAIN`, 4 deep) | Provider chain (openrouter → mistral → gemini-stub) |
| Model catalog source | Live weekly refresh (`refresh-free-models.mjs`) | Hardcoded single model (`qwen/qwen3-235b-a22b`) |
| Free-tier awareness | Explicit `:free` suffix requirement + live probe | None — no check that `qwen3-235b-a22b` is still priced/reachable |
| Vendor diversity | Deliberate (cohere/google/z-ai/nvidia across seats) | Single vendor id, single model |

**Consequence:** gcp3's `qwen/qwen3-235b-a22b` is exactly the kind of
hardcoded model ID that bit the portal once already (§2's retired-model
incident) — it has no live-probe refresh protecting it. Phase 4 of the
migration plan (unify model IDs + pricing on the OpenRouter catalog) is
where this gets closed: either point gcp3 at the portal's refreshed chain
output, or give gcp3 its own copy of `refresh-free-models.mjs`.

---

## 7. Summary

- **Portal:** fully migrated, single client, weekly-refreshed free-tier
  chain, per-seat vendor diversity, quota-aware scheduling, live + unit
  test coverage. This is the reference implementation.
- **gcp3:** OpenRouter is already the *primary* provider by config order,
  but the integration is thinner — one hardcoded model, no refresh
  automation, and a dead Gemini entry still in the registry.
- **Open item:** converge gcp3 onto the portal's refresh mechanism so
  neither codebase silently degrades the way the pre-refresh portal did.
