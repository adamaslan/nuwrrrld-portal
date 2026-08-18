# Maximum Signal Coverage, Minimum Machinery

Answers two questions asked together on 2026-08-18:

1. *"What's the 50/day key?"* — see the correction below; the number was wrong.
2. *"What's the simplest approach that maximizes signal coverage, AI, and
   automation — pre-existing or not?"*

Supersedes the sequencing (not the research) in
`docs/universe-scale-hydration.md`, after reading `docs/Recent Docs/` — which
turns out to already contain the answer.

---

## Correction: there is no 50/day OpenRouter limit

I used "~50 requests/day on the whole key" in `universe-scale-hydration.md`
(line 428) as a hard constraint, and built the top-100 batching design around
it. **That number is not in this codebase and I should not have stated it as
fact.**

What is actually verifiable here:

- `lib/openrouter.ts` treats **402** (quota) and **429** (rate limit) as
  retryable into `FREE_MODEL_CHAIN`. It never encodes a daily count.
- `docs/gha-modal-core-feature-coverage.md` records an observed `429` reset at
  `2026-08-19T00:00:00Z` — confirming a **UTC-midnight daily reset**, which is
  what the precompute-at-reset design correctly depends on.
- Nothing in the repo, tests included, establishes the size of the daily bucket.

OpenRouter's published free-tier policy is request-per-day limited on `:free`
models, tiered by account credit balance — commonly cited as 50/day for
zero-credit accounts and 1000/day once ~10 credits have ever been purchased.
Which tier this account sits in, I can't tell from the repo, and it's worth
checking directly at `https://openrouter.ai/api/v1/auth/key`, which returns the
live limit and usage for the key.

**Why the correction matters practically:** at 50/day, a top-100 AI batch is
impossible without prompt-batching. At 1000/day it's comfortable. Same design,
completely different urgency — so this is worth one curl before building
anything around it.

**Why it matters more than that:** the whole reason a daily cap is scary is
that the architecture spends *one big call per unit of work*. The approach
below makes the cap mostly irrelevant, which is a better fix than measuring it.

---

## The finding: the answer was already written, twice

`docs/Recent Docs/nuwrrrld-small-model-engine.md` (2026-08-12) is a complete,
correct design for exactly this problem, and its thesis is the one sentence
that should drive everything:

> **The LLM should never compute, never fetch, and never freestyle — it should
> classify, rank, and explain, over pre-digested categorical inputs, into
> schema-locked outputs, with deterministic guardrails on both sides.**

And more of it is built than that doc knows. `lib/grounding/taxonomy.ts` **is
the discretizer that doc §2 asks for**, already shipped, already unit-testable,
already pure:

| small-model-engine.md §2 asks for | Already in the repo |
|---|---|
| Fixed 3–7 value vocabulary per field | `RsiRegime`, `MacdCrossState`, `AdxTrendBucket`, `VolatilityRegime`, `ConfluenceBucket` |
| Thresholds in config, not prompts | `RSI_OVERSOLD_MAX`, `ADX_TRENDING_MIN`, `VOL_LOW_MAX`… as module constants |
| Discretize floats → tokens before any model sees them | `toStateKeyParts()` / `toStateKey()` |
| Versioned vocabulary | `TAXONOMY_VERSION` |
| Deterministic lookup keyed on the token state | `grounding_pack.state_key` + `lib/grounding/resolve.ts` |

The taxonomy was built for grounding-pack retrieval. It is *also* — unchanged,
no new code — the signal-card discretizer. That is the leverage this document
is about.

Meanwhile `docs/universe-scale-hydration.md` (which I wrote yesterday) proposed
three new tables, a new Modal app, a new bulk-ingest endpoint, a cross-repo
gcp3 change, and a new ranking API. It is a defensible design. It is also
substantially more machinery than the problem needs, because it treats AI
narrative-per-ticker as the unit of work and then has to ration it.

---

## The simplest approach that maximizes all three

**One sentence: discretize every ticker in code, rank on the tokens with SQL,
and let the model see only the top of the ranking — because a token card costs
zero quota, and quota is the only thing that was ever scarce.**

Coverage, AI, and automation stop competing, because they stop being the same
resource:

| | Unit | Cost per ticker | Ceiling |
|---|---|---|---|
| **Coverage** | a token card (code) | $0, no quota | thousands |
| **Ranking** | one SQL `ORDER BY` | $0, no quota | thousands |
| **AI** | one batched explain call per ~10 tickers | quota | tens |

The current architecture makes coverage expensive because a "covered" ticker
means an AI narrative. Decouple those and coverage becomes free. **You can
cover all 4,300 tickers today at zero AI cost** — the tokens *are* the signal —
and spend AI only where a human will read it.

Important definition: **coverage means "this ticker has a dated, source-traced,
machine-rankable card," not "this ticker has confident advice."** A card with
partial inputs is still coverage, but it must carry lower `data_quality` and
must not be allowed to look equivalent to a fully hydrated card. That distinction
matters because `toStateKeyParts()` intentionally defaults missing values into
neutral-looking buckets; the storage layer has to preserve the difference
between "neutral because the market is neutral" and "neutral because the input
was missing."

### The four steps

**Step 1 — Reuse the taxonomy as the signal card.** No new code. Feed it
whatever indicator fields the hydration lane produces; get back a stable token
tuple per ticker. Every ticker gets a card, forever, free.

**Step 2 — Store cards, rank with SQL.** One table (not three):

```sql
CREATE TABLE IF NOT EXISTS ticker_cards (
  ticker           text PRIMARY KEY REFERENCES ticker_universe (ticker) ON DELETE CASCADE,
  state_key        text NOT NULL,          -- toStateKey() — the discretized tuple
  taxonomy_version text NOT NULL,          -- TAXONOMY_VERSION at card time
  score            real NOT NULL,          -- deterministic, computed in code
  score_version    text NOT NULL,          -- e.g. CARD_SCORE_V1
  action           text NOT NULL CHECK (action IN ('BUY', 'HOLD', 'SELL')),
  tokens           jsonb NOT NULL,         -- toStateKeyParts() — the card itself
  numerics         jsonb NOT NULL DEFAULT '{}',  -- the numeric appendix (§2)
  data_quality     real NOT NULL DEFAULT 1.0,    -- gates ranking/explain
  missing_fields   text[] NOT NULL DEFAULT '{}', -- prevents silent neutralization
  input_hash       text NOT NULL,          -- idempotency + provenance
  source           text NOT NULL,
  source_run_id    text,
  bar_date         date,
  computed_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticker_cards_rank_idx
  ON ticker_cards (score DESC, computed_at DESC)
  WHERE data_quality >= 0.8;
CREATE INDEX IF NOT EXISTS ticker_cards_state_idx
  ON ticker_cards (taxonomy_version, state_key);
CREATE INDEX IF NOT EXISTS ticker_cards_freshness_idx
  ON ticker_cards (bar_date DESC, computed_at DESC);
```

The `state_key` index is the quiet payoff: it joins straight to
`grounding_pack`, so **every ticker gets cited, corpus-grounded rules at Tier 0
for zero model calls** — the machinery already exists in `resolve.ts` and
currently only serves council sessions.

**Step 3 — Rules-derived action, model-derived prose.** `_score_etf` in gcp3
already proves a deterministic scorer works; small-model-engine §4.1 calls the
same thing the "rules-based fallback." Make it the *primary*, not the fallback.
BUY/HOLD/SELL and the score come from code. The model only writes sentences,
and only for tickers someone will read.

**Step 4 — Batch the explain call.** Ten token cards per prompt (they're tiny —
tokens, not floats), schema-locked output, validated per §4. Top 100 tickers =
~10 calls. Under a 50/day cap that's 20% of the budget; under 1000/day it's
noise.

### The contracts that make this safe

- **Version every interpretation.** `taxonomy_version` and `score_version` are
  part of the card contract. If a threshold moves, old rows are still readable
  but should be rehydrated before they compete in the same ranking.
- **Never promote unknowns.** Missing RSI/MACD/ADX/volatility/confluence inputs
  are allowed in storage, but they lower `data_quality`, populate
  `missing_fields`, and stay out of the high-confidence top-N explain batch.
- **Keep stale real data instead of overwriting with bad neutral data.** Upserts
  should only replace a card when the new `bar_date` is newer, or when the same
  `bar_date` has a better source priority and a valid `input_hash`.
- **Separate action from prose.** If the model output fails schema validation,
  the card remains useful: score/action/tokens/grounding still render, and only
  the explanation is missing or stale.
- **Surface freshness.** Any UI reading `ticker_cards` should expose `bar_date`
  or `computed_at`; "full universe" is not the same thing as "live universe."

### What this deletes from yesterday's plan

- `universe_signals` and `hydration_runs` → folded into one `ticker_cards` table
- The `/api/signals/top` ranking API → a SQL `ORDER BY`, no endpoint needed
- The per-ticker AI narrative as the coverage unit → replaced by token cards
- The quota anxiety → structurally reduced, not rationed

### What it keeps

- The universe table and the hydration lane (still required — something must
  fetch prices; Alpaca's no-daily-cap batch endpoint is still the right vendor)
- The gcp3 per-stock-engine finding — still true, still the biggest open
  question, see below
- The precompute-at-quota-reset scheduling
- The bounded-ceiling and `quotaExhausted` guards in the precompute route

### Compared with the ten free-tier Daily Engine rebuilds

`docs/Recent Docs/how-i-use-zo.md` asks a neighboring but different question:
where could the Daily Engine run for $0 if Zo is removed? That pipeline is
small: one daily fetch, one composed JSON artifact, one publish/delivery pass.
This document is larger: thousands of ticker cards, deterministic ranking, and
quota-gated top-N AI.

So the answer changes by workload:

| Free-tier option | Fit for the Daily Engine | Fit for this max-coverage plan | Role here |
|---|---:|---:|---|
| **1. GitHub Actions all-in-one** | Excellent | Partial | Best control plane: preflight, audits, issue/PR creation, artifact history. Not the best home for 4,300-symbol indicator math. |
| **2. Modal** | Good | Excellent | Best new compute lane for full-universe hydration, pandas indicators, fan-out, and quota-reset AI batches. |
| **3. GCP always-free** | Excellent if repairing `gcp3` | Excellent if `gcp3` is fixed | Best "minimum new machinery" path: wire the existing gcp3 feature modules into a per-stock endpoint and let Cloud Scheduler/Cloud Run own it. |
| **4. AWS always-free** | Viable | Viable but not simple | Lambda/EventBridge can do it, but adds a new cloud and IAM surface for no app-specific win. |
| **5. Azure free tier** | Viable | Viable but not simple | Same as AWS: technically fine, operationally extra. |
| **6. Cloudflare Workers** | Good for serving JSON | Weak for indicator fan-out | Great edge mirror for `latest.json` or `backend-status.json`; poor fit for heavy Python/market-data computation on the free plan. |
| **7. Supabase + pg_cron** | Good greenfield | Poor fit here | Would replace Neon and move the source of truth. Nice if starting over; churn if incorporated now. |
| **8. Vercel / Netlify** | Good for one daily trigger | Weak for full coverage | Fine for a small briefing endpoint; too timeout- and host-coupled for universe hydration. |
| **9. Oracle Cloud VM** | Viable | Viable but risky | Powerful free compute, but a pet VM with cron recreates the local-secret/logs-on-a-box failure mode Zo exposed. |
| **10. Val Town / Deno Deploy** | Great prototype | Prototype only | Perfect for proving a tiny JSON publisher; too much new production surface for financial state. |

**Decision for this document:** if the goal is *only* replacing Zo's small Daily
Engine, pick option 1, GitHub Actions all-in-one. If the goal is the one this
document is about — maximum ticker coverage with minimum AI spend — the
winner is **option 3 if gcp3 can be repaired cleanly**, otherwise **option 2
Modal**.

That is not a contradiction. It is the workload boundary:

- Daily Engine: one artifact/day → GitHub Actions is simplest.
- Full-universe ticker cards: thousands of symbols/day → gcp3 or Modal is
  simplest.
- Public artifact serving: Cloudflare/Vercel/GitHub Pages are all fine, but
  they are serving surfaces, not the signal engine.

The temptation to run everything in one free place is exactly how the design
gets worse. The simplest path is one **data owner**, not one **host**: the
portal/Neon own the card state; gcp3 or Modal computes indicators; GitHub
Actions watches and reports.

### If option 2 wins: the concrete Modal pipeline

Choosing the ten-list's **Option 2, Modal**, means Modal becomes the scheduled
compute host for max coverage. The portal still owns auth, validation, and
storage; Modal owns the work that is too bursty or too Python-heavy for a
request.

The shape is one Modal app with two required scheduled functions and one
optional market-hours lane:

```text
Modal app: nuwrrrld-universe-pipeline

weekly refresh_universe()
  -> fetch or receive active symbols
  -> POST /api/pipeline/ticker-universe

daily hydrate_universe_eod()
  -> GET active ticker universe from portal
  -> chunk symbols into batches of ~100-200
  -> fetch bars/snapshots from the market-data vendor
  -> pandas/numpy indicators: RSI, MACD, ADX, volatility percentile, confluence
  -> POST /api/pipeline/hydrate-universe with per-symbol status rows
  -> portal calls toStateKey(), scores, and upserts ticker_cards

00:10 UTC precompute_topn_ai()
  -> POST /api/pipeline/precompute-ai or /api/pipeline/precompute-topn-signals
  -> portal ranks ticker_cards and spends bounded OpenRouter calls
  -> results land in precomputed_ai

optional refresh_hot_set_intraday()
  -> every 15-30 minutes during market hours
  -> fetch only watchlist + prior strong-score + S&P/Nasdaq-100 hot set
  -> partial upsert; never overwrite complete EOD cards with worse data
```

Two implementation details matter more than the vendor choice:

1. **Modal should not write Neon directly.** It should call portal pipeline
   endpoints with `Authorization: Bearer $PORTAL_PUSH_SECRET`. That keeps the
   database contract, idempotency, validation, and `CONFIG_ERROR` behavior in
   one place.
2. **The model key should usually stay in the portal.** Modal can trigger
   `precompute-ai` with `httpx` only, exactly like `deploy/precompute-ai/modal_app.py`
   already does. That keeps Modal from becoming another long-lived copy of
   `OPENROUTER_API_KEY`.

The Modal secret bundle is small:

| Secret | Used by | Notes |
|---|---|---|
| `PORTAL_URL` | all functions | defaults to `https://financial.nuwrrrld.com` only in dev |
| `PORTAL_PUSH_SECRET` | all portal writes | fail loudly if missing |
| market-data vendor key(s) | hydration functions | Alpaca/Finnhub/etc.; not needed by AI-only trigger |
| `OPENROUTER_API_KEY` | only if Modal calls models directly | avoid this in the first version |

The batch contract should be per-symbol, not all-or-nothing:

```json
{
  "runId": "universe-eod:2026-08-18:alpaca",
  "source": "alpaca",
  "barDate": "2026-08-18",
  "rows": [
    {
      "ticker": "AAPL",
      "status": "ok",
      "rsi": 58.2,
      "macdCross": "bullish",
      "adx": 27.4,
      "volatilityPercentile": 61,
      "confluenceScore": 72,
      "direction": "bullish",
      "inputHash": "..."
    },
    {
      "ticker": "DELISTED",
      "status": "error",
      "missingFields": ["bars"],
      "error": "no bars returned"
    }
  ]
}
```

That lets one bad ticker fail as data, not as a failed run. The portal can
accept the batch, preserve yesterday's good `ticker_cards` row for the bad
symbol, and still report that coverage was 4,214/4,300.

Modal's failure policy should be explicit:

- Missing secret or vendor auth failure: hard failure.
- One symbol missing bars: per-row error, not whole-job failure.
- Coverage below target, e.g. `<95%` active symbols: job warning or failure,
  depending on whether a previous good card exists for the misses.
- Indicator exception in one chunk: retry that chunk once, then emit per-symbol
  errors.
- AI quota exhausted: stop immediately; keep deterministic cards and any
  explanations already written.

The biggest risk is that Modal creates a second RSI/MACD implementation while
gcp3 already has feature modules nearby. If Modal is chosen because it ships
faster, pin it with golden fixtures: the same OHLCV input should produce the
same RSI/MACD/ADX buckets every time, and any later gcp3 implementation must
match the buckets even if the raw float differs slightly. The taxonomy buckets
are the contract, not the exact decimal.

First files for this path:

- `deploy/universe-hydration/modal_app.py` — pandas image, scheduled functions,
  chunking, retries, portal POSTs.
- `app/api/pipeline/hydrate-universe/route.ts` — auth, schema validation,
  `toStateKey()`, scoring, idempotent upsert.
- `lib/shared/card-policy.ts` — pure score/action/data-quality functions.
- `__tests__/card-policy.test.ts` and a route test with mixed ok/error rows.

This is still "minimum machinery" because Modal does not own product state. It
is just the strongest place to run the heavy loop.

---

## The one thing that still blocks everything

From `universe-scale-hydration.md`, verified in gcp3 and unchanged by any of
the above:

**gcp3's `/signals` analyzes 54 industry ETFs, not individual stocks.**
`get_technical_signals()` iterates only `industries`; `?symbol=AAPL` returns
`{"error": "not found"}` with a 200. There is no per-stock RSI/MACD path
wired into that endpoint, though `features_rsi.py` / `features_macd.py` /
`features_volume.py` all exist beside it.

The taxonomy needs `rsi`, `macdCross`, `adx`, `volatilityPercentile`,
`confluenceScore` per ticker. Something must produce those. That is the single
piece of genuinely new work, and it is upstream of every step above.

Cheapest path: wire gcp3's existing feature modules into a
`GET /signals/stocks?symbols=…` endpoint. They already do the math against a
three-tier vendor fallback with a `yf.download()` bulk path. The alternative —
a Modal pandas job — is faster to ship and creates a second RSI implementation,
which is the trade discussed at length in the sibling doc.

The endpoint contract should be boring and strict:

| Field | Why it matters |
|---|---|
| `ticker`, `barDate`, `asOf` | Makes idempotent upsert and freshness labeling possible |
| `rsi`, `macdCross`, `adx`, `volatilityPercentile`, `confluenceScore`, `direction` | The exact `SignalStateInput` surface `taxonomy.ts` already expects |
| `source`, `sourceRunId` | Lets a bad vendor batch be traced and selectively replaced |
| `status`, `missingFields`, `error` | Lets partial coverage degrade honestly instead of masquerading as neutral |

The most important behavior: a failed symbol in a 500-symbol request should be
a per-symbol `status: "error"` row, not a whole-response failure. Full-universe
hydration is only robust if one delisted ticker or vendor miss does not poison
the batch.

---

## Build order

1. **`curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/auth/key`**
   — settle the actual daily limit. Five seconds, and it decides how aggressive
   step 6 can be. *(Do this first regardless of everything else.)*
2. **`ticker_universe` + `ticker_cards` tables.** Ship dark. *(small)*
3. **Per-stock indicators in gcp3.** The blocker. *(medium-high, cross-repo)*
4. **Hydration lane** — Modal cron, Alpaca batch, → `POST /api/pipeline/hydrate-universe`
   which calls `toStateKey()` and upserts cards. *(medium)*
5. **Rules scorer + SQL ranking.** Pure functions in
   `lib/shared/card-policy.ts`, tested without `DATABASE_URL` — same split as
   `signal-policy.ts`. *(small)*
6. **Batched explain for the top N**, into the existing `precomputed_ai` table
   under the existing guards. *(medium)*
7. **Tier-0 grounding join** — `ticker_cards.state_key` → `grounding_pack`.
   Cited rules for every ticker at zero model cost. *(small, high payoff)*

Steps 2 + 5 + 7 give **full-universe coverage with cited grounding and zero AI
spend**. Steps 3 + 4 are the real cost. Step 6 is the part everyone assumes is
the whole project, and it's last because it's the least of it.

### Done means

- A nightly run can upsert cards for at least 95% of active `ticker_universe`
  rows without spending any model quota.
- No card with `missing_fields != '{}'` or `data_quality < 0.8` appears in the
  default top-N AI explain batch.
- A failed gcp3 symbol does not delete or downgrade the previous good card for
  that ticker.
- The top-N query is explainable from stored fields alone: ticker, action,
  score, tokens, numerics, source, freshness, and Tier-0 citations.
- The model-call ceiling is deterministic: `ceil(N / batch_size)` plus bounded
  retries, with `quotaExhausted` stopping the job rather than spilling into
  interactive quota.

### Test plan

- Unit-test the scorer against fixed token cards, including version changes,
  missing-field penalties, and BUY/HOLD/SELL boundaries.
- Unit-test `ticker_cards` upsert policy: newer bar replaces older, older bar
  is ignored, partial data cannot overwrite a complete same-day card.
- Add a stubbed route test for the hydration endpoint with mixed success,
  partial, and per-symbol error rows.
- Add one SQL smoke test or script assertion that `ticker_cards.state_key` joins
  to `grounding_pack` for known fixture states.
- Keep live OpenRouter tests observational here; this design should pass with
  either a 50/day or 1000/day account because coverage does not spend quota.

---

## See also

- `docs/Recent Docs/nuwrrrld-small-model-engine.md` — the design this follows;
  §2 discretization, §4 guardrail sandwich, §6 escalation-on-dissent
- `docs/Recent Docs/nuwrrrld-adaptive-engine.md` — the `universe.json` config
  pattern, worth adopting for thresholds currently hard-coded in `taxonomy.ts`
- `docs/universe-scale-hydration.md` — vendor budgets, the gcp3 finding, the
  fuller (heavier) alternative design
- `lib/grounding/taxonomy.ts` — the discretizer that already exists
- `lib/grounding/resolve.ts` — the Tier-0 pack join step 7 reuses
- `docs/gha-modal-core-feature-coverage.md` — the scheduler patterns
