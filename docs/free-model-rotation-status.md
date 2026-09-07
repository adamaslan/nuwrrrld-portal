# Free-Model Rotation — Does It Work, and Is It Applied Everywhere?

**Verified live: 2026-09-07** (real OpenRouter catalog + real probe, `--dry-run`).

> **Update 2026-09-07 — P1–P4 fixed.** See [§6](#6-fixes-applied-2026-09-07). The
> four problems below are kept verbatim for the audit trail; each now carries a
> resolution note.

## Short answer

**Yes on both counts, with three caveats.** `scripts/refresh-free-models.mjs`
works end-to-end against the live OpenRouter API, and every pipeline that calls
a model reaches `FREE_MODEL_CHAIN`. But:

1. The weekly job **cannot open its PR right now** — a dead seat model makes the
   script exit 1, which kills the GitHub Actions job before the PR step runs.
2. Rotation covers **fallbacks only, never primaries**. `SEAT_MODELS` is
   audited, never rewritten — so the `followed-tickers` pipeline's primary is
   currently a **paid** model.
3. Two of the three pipelines call the chain with a **token budget the code
   itself documents as too small** for the reasoning models now in the chain.

---

## 1. What the script actually does

`scripts/refresh-free-models.mjs` — plain Node ESM, zero dependencies, native
`fetch`. Four stages:

| # | Stage | Detail |
|---|---|---|
| 1 | **Catalog fetch** | `GET /api/v1/models`, keep only ids ending `:free` whose `pricing.prompt` and `pricing.completion` both parse to `0` (`request` must be 0 *or absent*). |
| 2 | **Seat audit** | Checks all six `SEAT_MODELS` ids against the **full** catalog (not the free-only list — T1 legitimately runs a paid model). **Reports only; never rewrites.** |
| 3 | **Live probe** | 1-token completion per candidate, in preference order, stopping at `MODEL_CHAIN_SIZE` (default 4). Drops anything not returning 200 — a model priced $0 that answers 402/429 is not trusted. |
| 4 | **Rewrite** | Regex-replaces the `FREE_MODEL_CHAIN` block in `lib/openrouter.ts`. Refuses to write if fewer than `MIN_WORKING = 1` models pass, so the app is never stranded with an empty chain. |

The seat audit runs **before** the probe deliberately — the probe's failure
modes (quota exhaustion, vendor outage) are exactly when a weekly run aborts
early, and the audit is most valuable precisely then.

### Where it runs

Redundant by design (see `docs/deploy-runner-decision.md` Finding 3), both
targeting the same `chore/refresh-free-models` PR branch:

| Runner | Schedule | Entry point |
|---|---|---|
| GitHub Actions | Mondays 06:17 UTC | `.github/workflows/refresh-free-models.yml` → `node scripts/refresh-free-models.mjs` |
| Modal | Mondays 09:00 UTC | `deploy/free-model-refresh/modal_app.py` → `scripts/run-refresh-remote.sh` (clone → refresh → PR) |

GCP Cloud Run and Zo runners exist in `deploy/free-model-refresh/` as further
redundancy. `run-refresh-remote.sh` is the portable wrapper: it makes the
refresh durable on an ephemeral worker by cloning, refreshing, and opening a PR
only if the chain actually changed (idempotent — no change, no commit, exit 0).

---

## 2. Live verification (2026-09-07)

```
$ node scripts/refresh-free-models.mjs --dry-run

Fetching OpenRouter catalog…
Found 18 $0-priced :free models.

Seat audit — 6 seat(s) against the live catalog:
  ok   T1     cohere/command-r7b-12-2024
  ok   T2     google/gemma-4-31b-it:free
  DEAD RISK   z-ai/glm-5.2:free
  ok   MACRO  google/gemma-4-26b-a4b-it:free
  ok   QUANT  liquid/lfm-2.5-2.6b:free
  ok   CHAIR  nvidia/nemotron-3-ultra-550b-a55b:free

Live-probing in preference order…
  probe OK  [200] nvidia/nemotron-3-ultra-550b-a55b:free
  probe OK  [200] nvidia/nemotron-3-super-120b-a12b:free
  probe skip [429] google/gemma-4-31b-it:free
  probe OK  [200] nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free
  probe skip [429] google/gemma-4-26b-a4b-it:free
  probe OK  [200] liquid/lfm-2.5-2.6b:free

Selected 4 model(s): …
No change — chain already current.
```

**"No change — chain already current"** is the strongest single signal here: the
chain committed in `lib/openrouter.ts` is byte-identical to what a fresh live
run produces today. The rotation is not stale, and the mechanism is not broken.

---

## 3. Coverage — is it applied to all the pipelines?

There are **four** `/api/pipeline/*` routes that could call a model. **Three do,
and all three reach `FREE_MODEL_CHAIN`.** The fourth calls no model at all, by
design.

| Pipeline route | Calls a model? | Path to the chain | Rotated? |
|---|---|---|---|
| `app/api/pipeline/precompute-ai/route.ts` | yes | `fetchWithModelFallbackChecked()` → iterates `FREE_MODEL_CHAIN` **only** — no primary | ✅ fully |
| `app/api/pipeline/followed-tickers/route.ts` | yes | `runSeat("T1")` → `SEAT_MODELS.T1` **then** the chain | ⚠️ fallback only |
| `app/api/pipeline/followed-tickers-judge/route.ts` | yes | `runSeat("QUANT")` → `SEAT_MODELS.QUANT` **then** the chain | ⚠️ fallback only |
| `app/api/pipeline/hydrate-universe/route.ts` | **no** | n/a — `modelCalls: 0`; not calling a model is its stated reason for existing | n/a |
| `app/api/pipeline/followed-tickers-select/route.ts` | **no** | n/a — no OpenRouter import | n/a |

The same chain also backs every non-pipeline AI surface, so rotation coverage is
app-wide, not pipeline-specific:

| Surface | Entry point |
|---|---|
| `/api/nuai` | `fetchWithModelFallback` |
| `/api/brief` | `fetchWithModelFallback` |
| `/api/portfolio/health-ai` | `fetchWithModelFallbackChecked` |
| `/api/council`, `/council/sample`, `/council/public` | `callCouncilSeat` → `runSeat` |
| `/api/council/deliberate` | `runSeat` ×N + `SMALLEST_MODEL` |

### The important structural distinction

```
fetchWithModelFallback*()  →  [ FREE_MODEL_CHAIN ]              ← rotated weekly
runSeat(seat)              →  [ SEAT_MODELS[seat], ...chain ]   ← primary NEVER rotated
```

`runSeat` prepends the seat's hand-maintained primary and only then walks the
chain. So for the two `runSeat` pipelines, the rotation script is a **safety
net, not the model selector**. That is intentional — a seat assignment encodes
intent (largest model on CHAIR synthesis, smallest on QUANT, vendors spread so
one account-tier outage can't take every seat) that a script cannot infer — but
it means primaries rot silently, which is the whole reason the audit in stage 2
exists.

---

## 4. Problems found

### P1 — A dead seat blocks the weekly chain refresh entirely 🔴 ✅ FIXED 2026-09-07

`RISK` is pinned to `z-ai/glm-5.2:free`, which **no longer exists**. The `:free`
variant was retired; `z-ai/glm-5.2` (paid) is still live.

The script deliberately writes the chain *before* reporting dead seats
("a stale seat is a degraded council, a stale chain is a dead one"), then sets
`process.exitCode = 1`. Confirmed:

```
$ node scripts/refresh-free-models.mjs --dry-run --no-probe >/dev/null; echo $?
1
```

But `.github/workflows/refresh-free-models.yml` runs the script as a bare step
with **no `continue-on-error`**. A non-zero exit fails the step → fails the job →
the `peter-evans/create-pull-request` step **never runs**. The intent ("the
chain refresh must land even when the seats need attention") is defeated by the
workflow wiring. **Right now, the weekly refresh cannot open a PR at all.**

Two independent fixes, both needed:
- Repoint `SEAT_MODELS.RISK` at a live id, preserving the size + vendor-spread
  intent documented above the block.
- Add `continue-on-error: true` to the refresh step (or split dead-seat
  reporting onto a distinct exit code the workflow can tolerate) so a rotted
  seat degrades the run instead of cancelling it.

### P2 — The `followed-tickers` pipeline's primary is a paid model 🟠 ✅ FIXED 2026-09-07

`SEAT_MODELS.T1 = 'cohere/command-r7b-12-2024'`. Live pricing:

```json
{"prompt": "0.0000000375", "completion": "0.00000015"}
```

Non-zero. It passes the seat audit (correctly — the audit checks *existence*
against the full catalog, not price), so nothing flags it. But it means the
`followed-tickers` pipeline spends real money on its first call per ticker, and
the "$0 council" claim in `lib/openrouter.ts`'s own comment ("All free-tier to
keep deliberation (~11 calls) at $0") is no longer true. Either accept it as a
deliberate paid exception and update that comment, or repoint T1 at a `:free`
id.

### P3 — Two pipelines pass a token budget the code says is too small 🟠 ✅ FIXED 2026-09-07

`runSeat`'s default is `maxTokens = 1200`, with an explicit comment:

> At 500 this measurably starved seats to a 0-character answer that read as a
> silent success (2026-09-02) — 1200 was the smallest budget that consistently
> left room for content.

Both `runSeat` pipelines override it below that floor:

- `followed-tickers/route.ts:92` → `500`
- `followed-tickers-judge/route.ts` → `400`

And the chain now contains `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
— a reasoning model that spends budget on hidden chain-of-thought before the
first visible token. This is the documented failure mode, live. `runSeat` does
now treat an empty completion as a failure and advance, so the outcome is a
burned chain rather than a silent empty answer — but in `followed-tickers` that
surfaces as `councilVerdictFor` returning `null` and the ticker being skipped,
which looks like "no verdict" rather than "budget too small".

`precompute-ai` is fine here — it passes `max_tokens: 1024` and uses the
`Checked` variant.

### P4 — The chain has nominal depth 4 and real depth ~1 🟡 ✅ FIXED 2026-09-07

Today's chain is 3× nvidia + 1× liquid. `lib/openrouter.ts` already notes this
("FREE_MODEL_CHAIN is all-nvidia, so it has nominal depth 4 and real depth 1
against an account-tier failure"), and it's *why* seats spread vendors — but the
rotation script has no vendor-spread constraint, so it reproduces the problem
every week.

The mechanism is visible in the probe output above: both Google models returned
**429** and were dropped. The probe treats a transient account-level rate limit
identically to "not free / not reachable", so a momentarily throttled vendor is
excluded from the whole week's chain. Worth adding a vendor cap (e.g. max 2 ids
per vendor prefix) and/or a single retry on 429 before dropping a candidate.

---

## 5. Summary

| Question | Answer |
|---|---|
| Does the script work against OpenRouter? | **Yes** — verified live 2026-09-07; chain is current. |
| Is it applied to all the pipelines? | **Yes** — all 3 model-calling pipelines reach the chain; the 4th calls no model by design. |
| Is the weekly automation healthy? | **No** — P1 blocks the PR step; a dead `RISK` seat currently prevents any refresh from landing. |
| Are all pipeline models free? | **No** — `followed-tickers`' T1 primary is paid (P2). |
| Are the primaries rotated? | **No, by design** — audited, not rewritten. Fix them by hand when the audit reports `DEAD`. |

### Suggested order of work

1. **P1** — repoint `SEAT_MODELS.RISK`; add `continue-on-error: true` to the
   workflow step. Unblocks the weekly refresh.
2. **P3** — raise the two pipeline token budgets to ≥1200, or drop the overrides
   and take the default.
3. **P2** — decide whether T1 is a deliberate paid exception; update the comment
   or the model.
4. **P4** — add a vendor cap and a 429 retry to the probe.

---

## 6. Fixes applied (2026-09-07)

All four in one pass. `tsc --noEmit`, `eslint`, and the 60 tests in
`openrouter-fallback` / `followed-tickers-routes` / `eval-judge` all pass;
`node scripts/refresh-free-models.mjs --dry-run --no-probe` exits 0 with all six
seats `ok`.

| # | Change | Files |
|---|---|---|
| **P1a** | `SEAT_MODELS.RISK`: `z-ai/glm-5.2:free` → `inclusionai/ling-3.0-flash-fin:free`. z-ai retired its `:free` tier entirely — no `z-ai/*:free` id exists in the catalog any more. Ling 3.0 Flash Fin is a $0 `:free` MoE built for investment reasoning and a **new vendor**, so the seat vendor-spread widens rather than narrows. | `lib/openrouter.ts` |
| **P1b** | `refresh-free-models.mjs` now exits **3** (not 1) for "chain refreshed OK, but a seat id is retired". The workflow's refresh step wraps the call in `set +e` and treats exit 3 as a `::warning::` + `exit 0`, so the `create-pull-request` step still runs. Exit 1 (catalog unreachable, too few working models, unparseable `SEAT_MODELS`) still fails the job. | `.github/workflows/refresh-free-models.yml`, `scripts/refresh-free-models.mjs` |
| **P2** | `SEAT_MODELS.T1`: `cohere/command-r7b-12-2024` (paid) → `thinkingmachines/inkling-small:free`. cohere's only `:free` model is a code model, unfit for a trader seat, so the cohere seat is retired. The "$0 council" invariant in `lib/openrouter.ts` is literally true again. | `lib/openrouter.ts` |
| **P3** | Dropped the sub-floor `maxTokens` overrides — `followed-tickers` (`500`) and `followed-tickers-judge` (`400`) — so both take `runSeat`'s documented `1200` default. 1200 is a ceiling, not a target: well-behaved outputs still cost the same; the reasoning models in the chain no longer starve to a 0-char answer. | `app/api/pipeline/followed-tickers/route.ts`, `app/api/pipeline/followed-tickers-judge/route.ts` |
| **P4** | `refresh-free-models.mjs` probe now (a) retries a candidate **once** after a 2 s pause on a `429` before dropping it, and (b) caps the chain at **2 ids per vendor prefix** (`MAX_PER_VENDOR`), applied on both the probed and `--no-probe` paths. An all-one-vendor chain is nominal depth N, real depth 1. | `scripts/refresh-free-models.mjs` |

### Seat vendor spread, after

| Seat | Model | Vendor |
|---|---|---|
| T1 | `thinkingmachines/inkling-small:free` | thinkingmachines |
| T2 | `google/gemma-4-31b-it:free` | google |
| RISK | `inclusionai/ling-3.0-flash-fin:free` | inclusionai |
| MACRO | `google/gemma-4-26b-a4b-it:free` | google |
| QUANT | `liquid/lfm-2.5-2.6b:free` | liquid |
| CHAIR | `nvidia/nemotron-3-ultra-550b-a55b:free` | nvidia |

Five distinct vendors across six seats (was four, with a dead one). Every seat
primary is now `:free`.

### Follow-on (same session) — model-usage log + "free always" guardrail

Requested after the P1–P4 pass: *"spit out a log of the exact runs and models
used each day/week/month; always prefer the cheapest (free) models."*

- **`pipeline_run_log` table** (`lib/db/schema.sql`, helper
  `lib/pipeline-run-log-db.ts`) — one append-only row per invocation of
  `followed-tickers`, `followed-tickers-judge`, and `precompute-ai`, recording
  the per-model rollup (calls, empty completions, chain rescues, latency), a
  compact per-unit list, and pipeline totals. Best-effort: a failed insert is
  logged and swallowed, never fatal to the run. `followed-tickers`'
  `councilVerdictFor` now returns the served model (it was discarded);
  `precompute-ai` already had it.
- **`scripts/model-usage-report.mjs`** (`npm run model-usage`) — rolls that
  table up by `--period day|week|month` into `docs/model-usage/<start>-<period>.md`
  (see that folder's `README.md`). `.github/workflows/model-usage-report.yml`
  runs it weekly + monthly and opens a PR. Report marks each model `$0` for
  `:free` or `⚠ paid` otherwise.
- **Paid-seat audit** — `refresh-free-models.mjs`'s seat audit now classifies
  each seat `ok` (exists, $0) / `PAID` (exists, billed) / `DEAD` (gone), so a
  paid `SEAT_MODELS` entry can't pass silently the way T1 did (P2). Non-fatal —
  a seat *may* be deliberately paid — but it's printed. The chain itself
  (`FREE_MODEL_CHAIN`) is `:free`-only by construction and unchanged.

### Not done — needs a real probe / human eye

- `inkling-small` and `ling-3.0-flash-fin` are **new** `:free` ids, existence-
  verified against the live catalog but **not** probed for a 200 here (no API
  key in this session). Both seats degrade to `FREE_MODEL_CHAIN` on failure and
  `runSeat` now advances past an empty completion, so a bad pick wastes one
  round trip, not a run — but the first live weekly run should be checked.
- The next `refresh-free-models.mjs` CI run will now propose a chain change
  (the vendor cap drops the 3rd nvidia entry). That PR is expected, not a
  regression.
