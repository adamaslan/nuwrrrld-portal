# The NuWrrrld AI Councils, Compared

There is no single "council." Across the codebase there are **four distinct
things** that call themselves an AI council. This doc names each one, says where
it lives, and ranks them by sophistication.

**Short answer: the most advanced is the portal's 6-seat deliberation —
`POST /api/council/deliberate` in `nuwrrrld-portal`.** Nothing else is close.
There is no separate "nu-finance council": the finance council *is* this one
(the portal is the NuWrrrld Financial web surface), plus a thinner mobile
version that predates it.

---

## The four councils

| # | Name | Repo / path | Kind | Model calls per run | Status |
|---|---|---|---|---|---|
| 1 | **Portal deliberation council** | `nuwrrrld-portal` · `app/api/council/deliberate/route.ts` + `lib/council-*.ts` + `lib/openrouter.ts` | 6-seat multi-round debate, grounded, structured verdict, persisted | ~11 | **Production, actively developed** |
| 2 | **Portal single-seat quick-ask** | `nuwrrrld-portal` · `app/api/council/route.ts` | 1 seat (T1 or T2), same parse/validate/repair path | 1–2 | Production (Hold/Fold ticker panel) |
| 3 | **Mobile council composer** | `gcp3-mobile` · `lib/clients/council.ts` + `components/CouncilPanel.tsx` | Prompt-builder → single RAG `/api/chat` call | 1 (2 for "Agree") | Production on mobile, being superseded by #1 |
| 4 | **AI Alpha OS "Run AI Council"** | `ai-text-opt-1024` · demo landing page | UI simulation — a 9-step interval timer, **no real execution** | 0 | Marketing demo only |

Councils 1 and 2 share the same seat definitions, model chain, verdict parser,
and Neon `council_verdicts` ledger — 2 is a one-seat slice of 1.

---

## Why #1 is the most advanced

`POST /api/council/deliberate` is a **five-stage** pipeline, not a prompt:

### Stage 1 — Ground (per-seat, sliced)
Each seat gets its *own* brief from `buildGroundedBrief(question, ticker, seat)`
(`lib/council-grounding.ts`), assembled from four independent sources that each
degrade to "omitted" on their own:

- live signal data (gcp3 backend)
- backtest hit-rates
- `council_verdicts` — the council's own prior calls on this ticker
- `grounding_pack` — the compiled corpus (tier ladder, `lib/grounding/*`)

Seats get **different slices of the same pack**: RISK is fed rules that *oppose*
the prevailing direction; T1/T2 are filtered by horizon; QUANT gets no rules at
all (numbers only); MACRO gets only Tier 1/2 full-text.

### Stage 2 — Round 1 (parallel, isolated)
`DEBATE_SEATS` answer their own brief in parallel under `Promise.allSettled`, so
one seat failing can't abort the debate. T1/T2 answers pass through the
**verdict repair loop** (`lib/council-validate.ts`) before being accepted — a
deterministic, no-network numeric + trade-logic check that can bounce a verdict
back for one repair attempt.

### Stage 3 — Round 2 (diff-shaped critique)
`computeDisagreements()` (`lib/council-critique.ts`) works out **in code** which
seats actually disagree with the majority on direction. Only those seats get a
`DECIDER / IF_RIGHT / CHANGE_MY_MIND` arbitration prompt. Seats that already
agree skip round 2 entirely — no wasted calls.

### Stage 4 — Synthesis (split)
CHAIR does one prose-only call on the **best** free model
(`nvidia/nemotron-3-ultra-550b`), then the verdict is a **separate** call
(`decision-split-chair-synthesis-and-verdict`) run **3× on the smallest model**,
majority-voting `direction` and taking the *minimum* confidence.

### Stage 5 — Persist
Session, messages, and the four-field verdict (`OUTLOOK` / `BECAUSE` /
`INVALIDATION` / `EXECUTION`) → Neon via `lib/council-db.ts`. Non-fatal if the
DB is unavailable.

### The six seats

| Seat | Role | Primary model (`SEAT_MODELS`, refreshed 2026-08-19) |
|---|---|---|
| T1 | short-term trader (1–60d) | `cohere/command-r7b-12-2024` |
| T2 | long-term investor (2mo–5y) | `google/gemma-4-31b-it:free` |
| RISK | devil's advocate (counter-slice) | `z-ai/glm-5.2:free` |
| MACRO | rates / dollar / rotation | `google/gemma-4-26b-a4b-it:free` |
| QUANT | numbers-only interpreter | `nvidia/nemotron-nano-9b-v2:free` (= `SMALLEST_MODEL`) |
| CHAIR | synthesizer + verdict | `nvidia/nemotron-3-ultra-550b-a55b:free` |

Every seat falls through `FREE_MODEL_CHAIN` (four NVIDIA Nemotron-3 tiers) on
402/429/5xx with a 20s per-model timeout. **Total model spend for a full
deliberation: $0.** Quota-gated: 5/day free, 25/day pro.

### What only #1 has

- Multiple rounds with a real inter-seat critique step
- Mechanically-computed disagreement (not "ask the LLM if they agree")
- Per-seat differentiated grounding, including an adversarial counter-slice
- A deterministic numeric/trade-logic validator with a repair loop
- Verdict by majority vote over 3 independent calls, not a single generation
- A persisted verdict ledger that later runs read back as grounding
- Structured, enum-validated output (a bad `OUTLOOK` is a parse failure, not a
  silent "neutral")
- Per-seat failure isolation and a `degradedSeats` report to the CHAIR

---

## The others, briefly

### #2 — Portal single-seat quick-ask (`POST /api/council`)
Same infrastructure as #1, one seat. Contract is **T1 or T2 only** (the other
seats emit free prose that wouldn't parse against the 4-field format). Used by
`app/dashboard/holdfold/HoldFoldClient.tsx` (renders the verdict as a `<dl>`)
and `app/dashboard/signals/SignalsClient.tsx` (renders raw prose only). Parses →
validates → retries once stricter → persists. No debate, no grounding slices, no
vote.

### #3 — Mobile council composer (`gcp3-mobile/lib/clients/council.ts`)
Five prompt-builder functions (`buildShortTermPrompt`, `buildLongTermPrompt`,
`buildShortTermChat`, `buildLongTermChat`, `buildAgreementPrompt`) that encode a
**trader persona + horizon** into a string, then `askCouncil()` forwards it to
**ai-text-opt-1024's RAG `/api/chat`** (ChromaDB retrieval + Gemini/Mistral). No
transport of its own, no seats, no verdict schema. The "★ Agree" button is the
one composite move: it feeds the short-term and long-term answers into
`buildAgreementPrompt` for one synthesis call. Deliberately never on the request
path — only fires on an explicit "Ask the Council" tap (the *tap-in* pattern,
keeping it outside the $5 cost-blowup risk). This is the council #1 was **ported
from and is replacing** on the web side; mobile↔web parity docs track the drift.

### #4 — AI Alpha OS "Run AI Council" (`ai-text-opt-1024` landing page)
Not a real council. A demo: clicking "Run AI Council" starts a 9-step
`setInterval` (850ms/step) that advances a display array — "Re-query AI council
with the critic output…" is a *string being shown*, not a call. Sliders
(`iterations` 3–12, `riskStrictness` 35–95) deterministically scale fake scores.
Roles listed (Scout, Quant, Strategist, Risk, Operator) are cosmetic. Useful as
a visual North Star for what a richer council UI could look like; zero backend.

---

## Reaching them

| Council | CLI | MCP |
|---|---|---|
| #1 deliberation | `curl -s localhost:3000/api/council/deliberate -H "cookie: __session=<jwt>" -d '{"ticker":"AAPL"}'` (Clerk + `nu_ai` entitlement + quota) | none — wrap the route; see `connecting-signals-holdfold-council-cli-mcp.md` §3.4 |
| #1 public preview | `curl -s localhost:3000/api/council/public -d '{"ticker":"AAPL"}'` (no auth, 1/day/IP, ticker-only) | same |
| #1 landing sample | `curl -s localhost:3000/api/council/sample` (cached SPY pair) | same |
| #2 quick-ask | `curl -s localhost:3000/api/council -H "cookie: __session=<jwt>" -d '{"prompt":"...","seat":"T1","ticker":"AAPL"}'` | same |
| #3 mobile | via ai-text-opt-1024 `POST localhost:3001/api/chat` `{message, trader_filter}` | none |
| #4 demo | n/a (frontend timer) | n/a |

Full startup order and combined `.mcp.json`:
[`connecting-signals-holdfold-council-cli-mcp.md`](connecting-signals-holdfold-council-cli-mcp.md).

---

## Source map

- Deliberation orchestration — `nuwrrrld-portal/app/api/council/deliberate/route.ts`
- Seats, models, fallback chain, prompts — `nuwrrrld-portal/lib/openrouter.ts`
- Verdict format / parse / reasoning-strip — `nuwrrrld-portal/lib/council-verdict.ts`
- Numeric + trade-logic validation, repair — `nuwrrrld-portal/lib/council-validate.ts`
- Disagreement computation — `nuwrrrld-portal/lib/council-critique.ts`
- Per-seat grounding brief assembly — `nuwrrrld-portal/lib/council-grounding.ts`
- Persistence (sessions, messages, verdicts) — `nuwrrrld-portal/lib/council-db.ts`
- Public demo quota/cache — `nuwrrrld-portal/lib/public-demo.ts`
- Architecture writeup — `nuwrrrld-portal/docs/ai-architecture.md` §2
- Prompting technique — `nuwrrrld-portal/docs/council-prompting-small-models.md`
- Wiki entity — `nuwrrrld-portal/docs/wiki-portal/entity-ai-council.md`
- Mobile composer — `gcp3-mobile/lib/clients/council.ts`, `docs/wiki-mobile/entity-council-composer.md`
- Demo UI — `ai-text-opt-1024/docs/AI-ALPHA-OS-FULL-STACK-OVERVIEW.md`
