# Is the full capacity of the Hold'em features working on the frontend?

**Date:** 2026-09-01
**Repo:** `nuwrrrld-portal` (branch `docs/attribution-sync-followups`)
**Scope:** the Hold/Fold (`holdfold`) surfaces in the web portal, measured against
what the `holdemfoldemapp` backend actually returns.

---

## Short answer

**No.** What is wired up *works*, but it exposes roughly **a third** of what the
backend computes.

The gap is not broken code — every path I traced is functional and correctly
gated. The gap is **unrendered payload**: the deployed backend returns a rich
~50-field verdict, and the portal frontend reads about 15 of those fields. The
most valuable analytics — options, Fibonacci, position P&L, risk/volatility
context, and degradation warnings — are computed on every request, sent over the
wire, and then dropped on the floor.

---

## What IS working

| Surface | File | State |
|---|---|---|
| Hold/Fold list page | [page.tsx](app/dashboard/holdfold/page.tsx) | ✅ Working |
| Search + verdict filter | [HoldFoldClient.tsx:212-273](app/dashboard/holdfold/HoldFoldClient.tsx#L212-L273) | ✅ Working |
| Verdict detail drawer | [HoldFoldClient.tsx:146-210](app/dashboard/holdfold/HoldFoldClient.tsx#L146-L210) | ✅ Working |
| Per-ticker detail page | [[ticker]/page.tsx](app/dashboard/holdfold/[ticker]/page.tsx) | ✅ Working |
| Live trade-plan panel | [AnalyzeLivePanel.tsx](app/dashboard/holdfold/[ticker]/AnalyzeLivePanel.tsx) | ⚠️ Partial — see below |
| AI Council (T1/T2 seats) | [HoldFoldClient.tsx:83-144](app/dashboard/holdfold/HoldFoldClient.tsx#L83-L144) | ✅ Working |
| Watchlist add | [HoldFoldClient.tsx:31-66](app/dashboard/holdfold/HoldFoldClient.tsx#L31-L66) | ✅ Working |
| Track record badge | [[ticker]/page.tsx:195](app/dashboard/holdfold/[ticker]/page.tsx#L195) | ✅ Working |
| Auth + `nu_ai` entitlement gating | both pages | ✅ Working |
| Two-tier cache (L1 memory → Neon) | [api/holdfold/route.ts:31-46](app/api/holdfold/route.ts#L31-L46) | ✅ Working |
| Disclaimer modal + footer | [[ticker]/page.tsx:211-212](app/dashboard/holdfold/[ticker]/page.tsx#L211-L212) | ✅ Working |

Error handling is genuinely good: the detail page distinguishes "backend down"
from "ticker not found" via a `BackendError` sentinel
([[ticker]/page.tsx:17](app/dashboard/holdfold/[ticker]/page.tsx#L17)), and the
analyze proxy returns operator-actionable messages rather than a bare 503
([api/analyze/route.ts:83-90](app/api/analyze/route.ts#L83-L90)).

---

## What is NOT working — the capacity gap

### The measurement

I grepped both frontends for each rich field in the backend's response model.

| Backend field | Portal frontend | `holdemfoldemapp` frontend |
|---|---|---|
| `options_greeks` | ❌ 0 files | ✅ 1 |
| `payoff_curve` | ❌ 0 files | ✅ 1 |
| `breakeven_prices` | ❌ 0 files | ✅ 1 |
| `max_profit` / `max_loss` | ❌ 0 files | ✅ 1 |
| `fib_levels` | ❌ 0 files | ✅ 1 |
| `suppressions` | ❌ 0 files | ✅ 1 |
| `volatility_regime` | ❌ 0 files | ✅ 2 |
| `position_pnl_detail` | ❌ 0 files | ✅ 1 |
| `risk_level` | ❌ 0 files | ✅ 2 |
| `vehicle` / `vehicle_notes` | ❌ 0 files | ✅ 1 |
| `atr` | ❌ 0 files* | — |
| `warnings` | ❌ 0 files | — |

\* `atr` initially showed 2 hits; both were substring false positives on the word
"m**atr**ix" in the marketing homepage. Genuine usage is zero.

**The reference frontend in `holdemfoldemapp` renders all of these. The portal
renders none of them.**

### The three concrete gaps

**1. `AnalyzeLivePanel` sends options/position params it can never display.**

The request schema at
[api/analyze/route.ts:21-32](app/api/analyze/route.ts#L21-L32) accepts
`options_strategy`, `options_legs`, `position_lots`, and `position_side`. The UI
never collects them — the "Advanced" toggle offers only period, risk profile, and
a single position qty/entry pair
([AnalyzeLivePanel.tsx:91-114](app/dashboard/holdfold/[ticker]/AnalyzeLivePanel.tsx#L91-L114)).

Worse, the result renderer displays exactly **six** values — verdict, confidence,
entry, stop, target, R:R
([AnalyzeLivePanel.tsx:118-131](app/dashboard/holdfold/[ticker]/AnalyzeLivePanel.tsx#L118-L131)) —
out of a ~50-field response. The component even *declares* a `fibonacci` field in
its own `AnalyzeResult` interface
([AnalyzeLivePanel.tsx:19](app/dashboard/holdfold/[ticker]/AnalyzeLivePanel.tsx#L19))
and then never reads it.

**2. Confidence is quantized to three buckets, discarding a real number.**

Both the list page and detail page map the backend's `ai_confidence` label to a
hardcoded number:

```ts
confidence: confLabel === "HIGH" ? 80 : confLabel === "MEDIUM" ? 55 : 30
```

([page.tsx:42-46](app/dashboard/holdfold/page.tsx#L42-L46),
[[ticker]/page.tsx:50](app/dashboard/holdfold/[ticker]/page.tsx#L50))

The UI then renders that fabricated integer as a precise-looking percentage
("80%"). Meanwhile `/api/analyze` returns a genuine continuous
`confidence: round(avg_score, 1)`. Two different confidence semantics are shown
in the same UI with no visual distinction between the real one and the bucketed
one.

**3. Silent degradation.** The backend sets `degraded: bool` and a `warnings:
list[str]` when the pipeline runs in a reduced mode
([core.py:394-397](../holdemfoldemapp/backend/core.py)). The portal reads
neither. A degraded verdict renders identically to a healthy one — the user
cannot tell the difference, and neither can an operator looking at the page.

### Secondary finding: duplicated mapping logic

`fetchVerdict` in [[ticker]/page.tsx:19-76](app/dashboard/holdfold/[ticker]/page.tsx#L19-L76)
and `fetchHoldFoldData` in [page.tsx:17-99](app/dashboard/holdfold/page.tsx#L17-L99)
implement the same signals→verdict mapping independently, while
`lib/shared/holdfold-map.ts` already exports `mapSignalsToHoldFold` for exactly
this. Any fix to the confidence bucketing has to be made in three places today.

---

## Two different backends, worth knowing about

The portal talks to **two separate upstreams**, which is deliberate and
documented in [lib/env.ts](lib/env.ts):

- `MCP_BACKEND_URL` → `GET /signals` — the batch feed powering the list page.
- `MCP_ANALYZE_URL` → `POST /api/analyze` — per-ticker live analysis.

Note that `holdemfoldemapp` contains two different `main.py` files. The thin one
(`backend/cloud-run/main.py`, ~11 fields) is **not** what ships —
`deploy-backend.sh` copies `backend/main.py` + `backend/core.py`, the rich v5
model. So the full payload really is reaching the portal; it's the rendering that
stops short.

---

## Ranked recommendations

1. **Render the trade-plan fields already in the response** — `risk_level`,
   `volatility_regime`, `stop_pct`, `upside_pct`, `vehicle`, `primary_signal`.
   Zero backend work; highest value per line of code.
2. **Surface `degraded` + `warnings`.** A wrong verdict shown confidently is the
   worst failure mode this app has, and the data to prevent it is already on the
   wire.
3. **Stop fabricating confidence.** Either display the label (`HIGH`/`MEDIUM`/
   `LOW`) honestly, or plumb through the real `avg_score`. Rendering `30` as
   "30%" when the backend said "LOW" is misleading precision.
4. **Add the Fibonacci panel** — `fib_levels`, `nearest_fib_support` /
   `nearest_fib_resistance`. Self-contained and already computed.
5. **De-duplicate onto `mapSignalsToHoldFold`.** Prerequisite for #3 being a
   one-place fix.
6. **Options UI** — the largest piece of genuinely new work (leg builder, payoff
   chart, Greeks). Port the patterns from `holdemfoldemapp/frontend/src/app/page.tsx`,
   which already renders all of it.

Items 1–5 are all "display data you're already fetching." Only item 6 needs new
UI infrastructure.

---

## Caveats on this audit

- This is a **static read** of the code. I did not run the app or hit the live
  backend, so "working" means the code path is correct and complete, not that it
  was observed rendering in a browser.
- Field coverage was measured by grep across `app/`, `components/`, and `lib/`,
  excluding tests. The `atr` false positive above is a reminder that substring
  matching over-reports; I verified the zero-coverage claims but did not
  hand-verify every positive in the reference frontend column.
