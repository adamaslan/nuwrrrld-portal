# Scaling to the Full Universe: S&P 500 + Nasdaq Hydration and Signal-Gated AI

Companion to `docs/gha-modal-core-feature-coverage.md` (which asks *what can run
off-request*) and `docs/api-failure-mitigation-build-options.md` (which asks
*how it degrades*). This one asks the question neither does:

**How do we go from "tickers someone happened to add to a watchlist" to "every
stock in the S&P 500 and the Nasdaq", hydrate the database on a free tier, and
still only spend AI quota on the ~100 names that earned it?**

Written 2026-08-18.

---

## The finding that reframes this: gcp3 does not compute stock signals

Before any of the design below, one fact verified in `gcp3/backend/` on
2026-08-18, because it changes what "expand coverage" even means:

**gcp3's signal engine does not analyze individual stocks. It analyzes 54
industry ETFs, and derives everything else from them.**

`backend/technical_signals.py` defines `ALL_SIGNAL_TICKERS` as 54 ETFs plus
~216 named constituent stocks (~270 symbols). But `get_technical_signals()` —
the function behind `GET /signals`, the one the portal's `fetchTickerEntryLive`
calls for every ticker — iterates **only over `industries`**, scoring ETF rows
from `get_industry_returns()`. Its own docstring says so:

> *"Return BUY/HOLD/SELL signals for all 54 industry ETFs from industry_cache.
> Signals are derived from multi-period return data (no external API calls)."*

The seven scoring signals in `_score_etf` are all ETF-relative: 52-week range
position, relative strength rank *within the 54-ETF universe*, multi-period
returns. There is no per-stock RSI, MACD, or volume analysis in this path,
despite `features_rsi.py`, `features_macd.py`, and `features_volume.py`
existing in the same directory — those feed a different pipeline.

Three consequences, and they are the load-bearing facts of this whole document:

1. **`GET /signals?symbol=AAPL` returns `{"error": "not found"}`.** AAPL is not
   an ETF in `INDUSTRIES`, so the filter `if symbol and etf != symbol.upper()`
   excludes every row and `ranked` comes back empty. Every portal call for a
   non-ETF ticker gets nothing back. This is very likely the "gcp3 404s"
   referred to in `gha-modal-core-feature-coverage.md`'s Option C — the same
   defect seen from the other side.
2. **Batch-vs-single is a non-question.** `GET /signals` with no `symbol` already
   returns all rows in one call, computed from a cached Firestore document with
   zero external API calls. There is nothing to batch. The open question the
   first draft of this guide flagged is answered, and answered in a way that
   makes the answer irrelevant.
3. **Expanding to 4,300 stocks is not "more of what gcp3 does".** It is a
   different analysis — per-stock indicators over per-stock price history —
   that does not exist anywhere in either repo today. The 54-ETF engine cannot
   be pointed at AAPL; there is no per-stock code path to point.

So the real question is not "how do we hydrate more tickers through the
existing pipeline". It is **"where does per-stock indicator computation get
built, given that it doesn't exist yet"** — and that is a genuinely new
component, which is why this document recommends building it as one.

---

## The shape of the problem

Today the portal's signal data plane is **demand-pulled**. Nothing enters
`signal_cache` unless a user does something:

```
watchlist add → enqueueSignalRefresh() → pending_signals
                                            ↓ (external cron)
                              POST /api/signals/drain → gcp3 /signals?symbol=X
                                            ↓
                                       signal_cache          [← returns nothing
                                                                for non-ETF tickers]
```

That design is correct for a small user base and wrong for universe coverage,
for one structural reason: **the queue's unit of work is a user request, and
there is no user requesting AMD at 4am.** `pending_signals` even enforces
`requested_by text NOT NULL` and a unique index on one pending row per ticker —
both sensible for demand-pull, both awkward for a 4,500-row batch sweep.

Universe coverage inverts the flow. It is **supply-pushed**: a scheduler walks
a known list of symbols, fetches them from a data vendor, computes indicators,
and writes rows nobody asked for yet — so that when someone *does* ask, the
answer is already there and the AI has a ranked shortlist to spend quota on.

The four things that must be built, in order:

1. **A universe table** — the list of symbols itself, refreshed weekly. Does
   not exist today in any form.
2. **A per-stock indicator engine** — the component the finding above shows is
   missing. RSI/MACD/MA-cross/volume over per-symbol price history.
3. **A hydration lane** — a scheduled fetch that fills 2's inputs for every
   symbol in 1, within free-tier call budgets.
4. **A signal-gated AI trigger** — rank hydrated rows by strength, and spend the
   day's model quota top-down on that ranking rather than on whoever's watchlist
   happened to be enumerated first.

The rest of this document is those four, plus three concrete free-tier ways to
build 2+3, plus what changes in the existing code.

---

## Sizing the problem honestly

The numbers decide the architecture, so start there.

| Universe | Symbols | Notes |
|---|---|---|
| S&P 500 | ~503 | 500 companies, ~503 share classes (GOOG/GOOGL, BRK.B, FOX/FOXA) |
| Nasdaq-100 | ~101 | ~90% already inside the S&P 500 |
| **Nasdaq full listing** | **~3,300–4,000** | Every symbol on the exchange — includes micro-caps, SPACs, ADRs, ETFs |
| Union (S&P 500 + Nasdaq-100) | **~560 unique** | The realistic target |
| Union (S&P 500 + full Nasdaq) | **~4,300 unique** | The literal reading of the ask |

This distinction is the single most important decision in this document, and it
is worth being blunt about it: **"every stock in the S&P 500 and in Nasdaq"
reads two ways, and they are different projects.**

- **~560 symbols** is comfortably achievable on free tiers with daily EOD
  hydration and intraday refresh of the interesting subset. Everything below
  works.
- **~4,300 symbols** is achievable for *daily EOD* hydration on exactly one of
  the three options below (Alpaca), and is not achievable intraday on any free
  tier without either paying or accepting hours-long staleness. The long tail is
  also where data quality is worst — illiquid names produce indicator values
  that are technically computable and practically meaningless.

**Recommendation: build for ~4,300 but *tier* it.** Store the full universe,
hydrate the full universe daily EOD, and run intraday refresh only on a "hot
set" (S&P 500 + Nasdaq-100 + anything on a user watchlist + anything that
scored strongly yesterday ≈ 600–800 symbols). The universe table carries a
tier column so the tiering is data, not a hard-coded list. This is spelled out
in the schema below.

---

## Free-tier call budgets, computed

The vendor comparison in the prompt lists limits; what matters is calls-per-day
against the universe size, and specifically whether the vendor has a **batch
endpoint** — one call returning N symbols — because that single property
changes the arithmetic by two orders of magnitude.

| Vendor | Free limit | Batch? | Full-universe daily sweep (4,300) | Verdict |
|---|---|---|---|---|
| **Alpaca** | No daily cap; 200 req/min (Basic) | **Yes** — multi-symbol bars/snapshots, ~100–200 symbols/call | ~22–43 calls | **Viable, with room to spare** |
| Twelve Data | 800/day, 8/min | Partial (batch counts as N credits) | 4,300 credits — **5× over** | Hot set only |
| Finnhub | 60/min (~86k/day theoretical) | No — one symbol per call | 4,300 calls ≈ 72 min of sustained bursting | Viable but slow + fragile |
| FMP | 250/day | Yes, but capped list length | 4,300 ÷ ~50 ≈ 86 calls — fits | Viable; thin margin for retries |
| StockData.org | "generous", undocumented ceiling | Yes | Unknown | Unsuitable as a primary — unbounded limits can't be budgeted |

Two conclusions fall out:

1. **Batch capability dominates rate limits.** Finnhub's 60/min is a higher
   *rate* than Alpaca's practical throughput, and yet Alpaca finishes the sweep
   in 30 seconds because it returns 200 symbols per call while Finnhub returns
   one. Never rank these vendors by their headline limit.
2. **Twelve Data's 800/day, the most generous-sounding number in the list, is
   the most misleading.** Its batch endpoints charge one credit *per symbol*,
   so batching saves latency but not quota. 800/day is a hot-set budget
   (≈800 symbol-refreshes/day = the S&P 500 once plus a partial second pass),
   not a universe budget.

---

## The three recommended approaches

All three share the same database shape and the same AI trigger. They differ
only in who fetches the market data and where the indicator math runs.

### Option 1 — Alpaca batch sweep on Modal (recommended scheduler; see caveat)

**One vendor, one scheduler, whole universe, no daily quota to exhaust.**

Alpaca's free data API has no daily call cap — only a per-minute rate limit —
and its `/v2/stocks/bars` and `/v2/stocks/snapshots` endpoints accept a
comma-separated `symbols` list. A Modal function chunks the universe into
batches of 200, fetches bars, computes indicators locally with pandas, and
POSTs the results to the portal in bulk.

```
Modal cron (16:15 ET / after close)
  → GET /v1/assets  (weekly, universe refresh)
  → GET /v2/stocks/bars?symbols=<200 syms>&timeframe=1Day&limit=200   ×22
  → pandas: RSI / MACD / MA-cross / volume-surge per symbol
  → POST /api/pipeline/hydrate-universe  (bulk upsert, chunked ~250 rows)
      → signal_cache + universe_signals
```

**Caveat, per the finding above:** the "pandas: RSI / MACD / …" step is a
*new* indicator implementation, not a call into existing logic — because no
per-stock logic exists. That makes this option faster to ship and the one that
creates a second home for the math. See the Recommendation below.

**Why Modal specifically and not GHA:** this is fan-out over thousands of
symbols with real CPU work (indicator math on 200 bars × 4,300 symbols), which
is exactly the Option F shape in `gha-modal-core-feature-coverage.md` — "work
bounded by a resource other than the user's patience". Modal's `.map()` handles
the fan-out with its own rate limiting; the image needs pandas, which is a
30-second cold start on Modal and a 90-second install on every GHA run.

**Cost:** $0. Alpaca data is free; Modal's free tier ($30/mo credit) covers a
daily 5-minute pandas job with enormous headroom.

**Effort:** Medium. New Modal app, new bulk-ingest endpoint, indicator math.
The indicator math may already exist in gcp3 — see "Reuse gcp3 or not" below.

**The catch:** Alpaca's free tier serves IEX-only data, not the full SIP
consolidated feed. For the S&P 500 that is a non-issue (IEX prints are
representative and the daily bars reconcile). For illiquid Nasdaq micro-caps,
IEX may have thin or no prints on a given day, so some long-tail symbols will
have gaps. This is an argument for tiering, not against Alpaca.

---

### Option 2 — Hybrid: Alpaca for breadth, Finnhub for the hot set

**Two lanes at different cadences, matched to what each vendor is good at.**

Option 1's weakness is that a single daily EOD sweep means intraday signal
staleness across the board. This option adds a second lane: after the EOD sweep
establishes the ranking, a market-hours Modal cron refreshes only the top
~500 hot-set symbols every 15 minutes via Finnhub, whose 60/min rate limit
supports ~500 single-symbol calls in ~9 minutes of sustained bursting.

```
16:15 ET  Alpaca batch sweep  → all 4,300 symbols, EOD bars
every 15m Finnhub burst       → hot set only (~500), intraday quotes
  (both write signal_cache; hot-set writes also bump universe_signals.score)
```

This also composes with the existing `modal_finnhub_ws.py` WebSocket worker
already pushing to `POST /api/signals/live` — that worker is the third, lowest-
latency tier for the handful of symbols a user is actively looking at. Three
tiers, three cadences, each matched to how much anyone cares:

| Tier | Symbols | Cadence | Source |
|---|---|---|---|
| Universe | ~4,300 | Daily EOD | Alpaca batch |
| Hot set | ~500–800 | 15 min, market hours | Finnhub REST |
| Live | ~10–50 | Sub-second | Finnhub WS (exists) |

**Cost:** $0. **Effort:** Medium-high — Option 1 plus a second scheduled lane
and hot-set selection logic.

**The catch:** two vendors means two failure modes, two auth paths, and a
reconciliation question when they disagree on a price. Worth it only once
Option 1 is running and intraday staleness is demonstrably the binding
complaint.

---

### Option 3 — Build the per-stock engine inside gcp3

**Put the missing component where the market-data infrastructure already lives.**

The finding at the top of this document says per-stock indicator analysis does
not exist. Option 3 says: build it in gcp3 rather than in a new Modal app,
because gcp3 already has everything it needs except the endpoint —
`features_rsi.py`, `features_macd.py`, `features_volume.py`, a `data_client.py`
with a three-tier vendor fallback (Finnhub → Alpha Vantage → yfinance), a
`yf.download()` bulk path that already batches many symbols per request, and
Firestore caching.

```
new: GET /signals/stocks?symbols=<200>   (or scope=stocks over the universe)
  → data_client bulk fetch (existing)
  → features_rsi / features_macd / features_volume (existing)
  → Firestore cache (existing)
Modal/GHA cron → walks universe through it → POST /api/pipeline/hydrate-universe
```

**Why this is probably the right call despite being the most work:** it is the
only option that puts per-stock indicators in the same place as the ETF
signals, computed by the same feature modules against the same vendor fallback
chain. Every other option creates a second RSI implementation. When gcp3 says
AAPL's RSI is 61 and a Modal pandas job says 58 — different lookback
convention, different close series, both defensible — the portal will serve
whichever wrote last, and the symptom is "the numbers flicker" long before
anyone diagnoses it.

It also fixes the `{"error": "not found"}` defect for free, since a per-stock
path is exactly what's missing when the portal asks for AAPL.

**Cost:** $0 (Cloud Run free tier). **Effort:** High — and it lands in a second
repo, outside this repo's PR loop.

**The catch:** cross-repo coordination, and `get_industry_returns()`'s daily
Firestore cadence means the existing infrastructure is built around one refresh
per day. Intraday per-stock coverage needs new cache plumbing there too.

---

### Recommendation

**Option 3 for the engine, Option 1's scheduler shape to drive it.**

The first draft of this guide recommended Option 1 and treated Option 3 as
"eventually correct". Verifying gcp3 inverts that. Option 1 assumed it was
adding a *faster lane* alongside an existing per-stock engine; there is no
existing per-stock engine, so Option 1 is really "build a second, parallel
analysis stack in a different language against a different vendor" — and the
duplicate-indicator risk stops being a tolerable trade and becomes the main
consequence of the decision.

Concretely:

1. **Add the per-stock path to gcp3** (Option 3). It has the feature modules,
   the vendor fallback, and the bulk fetch already. This also repairs
   `?symbol=AAPL`.
2. **Drive it from a Modal cron** (Option 1's shape) that walks the universe
   and bulk-posts to the portal. The scheduler is the easy half and is
   repo-local.
3. **Add Option 2's Finnhub hot-set lane** only when intraday staleness is a
   real complaint rather than an anticipated one.

**If cross-repo work is genuinely blocked**, Option 1 standalone is the
fallback — but then treat the Modal job as the *sole* owner of per-stock
indicators and never let gcp3 grow a competing implementation later. Pick one
home for the math and write down which.

---

## Schema: what to add

Three new tables. All idempotent, same `IF NOT EXISTS` style as the rest of
`lib/db/schema.sql`.

```sql
-- ── Ticker universe (the list itself) ────────────────────────────────────────
-- Refreshed weekly from the index constituents / exchange listing. This is the
-- supply-side counterpart to watchlist_items: rows here exist because the
-- market has them, not because a user asked.
CREATE TABLE IF NOT EXISTS ticker_universe (
  ticker      text        PRIMARY KEY,
  name        text,
  exchange    text,                      -- 'NASDAQ' | 'NYSE' | 'ARCA' | …
  in_sp500    boolean     NOT NULL DEFAULT false,
  in_nasdaq100 boolean    NOT NULL DEFAULT false,
  tier        smallint    NOT NULL DEFAULT 3,  -- 1=hot, 2=broad, 3=tail
  active      boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticker_universe_tier_idx
  ON ticker_universe (tier) WHERE active;

-- ── Per-symbol scored signal state (the ranking substrate) ───────────────────
-- Distinct from signal_cache, which stores the whole opaque gcp3 payload. This
-- table stores only the few *comparable* scalars needed to rank 4,300 symbols
-- against each other cheaply — an ORDER BY over a jsonb payload would need a
-- functional index per field and still be slower than columns.
CREATE TABLE IF NOT EXISTS universe_signals (
  ticker       text        PRIMARY KEY REFERENCES ticker_universe (ticker) ON DELETE CASCADE,
  score        real        NOT NULL,     -- 0–100 confluence, comparable across symbols
  direction    text,                     -- bullish | bearish | neutral
  action       text,                     -- STRONG BUY | BUY | HOLD | SELL | STRONG SELL
  close        numeric,
  volume       bigint,
  indicators   jsonb       NOT NULL DEFAULT '{}',  -- rsi, macd, ma_cross, vol_surge…
  source       text        NOT NULL,     -- 'alpaca-eod' | 'finnhub-intraday' | 'gcp3'
  bar_date     date,                     -- the session this reflects
  computed_at  timestamptz NOT NULL DEFAULT now()
);
-- The whole point: rank the universe by strength in one index scan.
CREATE INDEX IF NOT EXISTS universe_signals_score_idx
  ON universe_signals (score DESC, computed_at DESC);
CREATE INDEX IF NOT EXISTS universe_signals_action_idx
  ON universe_signals (action, score DESC);

-- ── Hydration run log (observability for a job nobody watches) ───────────────
CREATE TABLE IF NOT EXISTS hydration_runs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lane        text        NOT NULL,      -- 'universe-eod' | 'hot-set-intraday'
  source      text        NOT NULL,      -- vendor
  attempted   int         NOT NULL DEFAULT 0,
  succeeded   int         NOT NULL DEFAULT 0,
  failed      int         NOT NULL DEFAULT 0,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error       text
);
CREATE INDEX IF NOT EXISTS hydration_runs_lane_idx
  ON hydration_runs (lane, started_at DESC);
```

**Why `universe_signals` is separate from `signal_cache` rather than a column
added to it.** `signal_cache` is keyed on ticker and holds gcp3's whole payload
as jsonb, read one row at a time by `fetchTickerEntry`. The ranking query is the
opposite access pattern — a whole-table sort over one scalar. Putting `score` in
a jsonb column and indexing it functionally would work, but it couples the
ranking to gcp3's payload shape, and this table needs to hold rows for symbols
gcp3 has never seen. Two tables, two access patterns, one foreign key.

---

## The AI trigger: JIT and top-100, from the same ranking

This is where the existing `precomputed_ai` infrastructure does almost all the
work already. The change is *what feeds it*.

Today `POST /api/pipeline/precompute-ai` enumerates watchlist ticker-sets
(`listWatchlistSubjects`) and generates portfolio-health narratives for up to
`maxSubjects` of them. That is demand-shaped: it precomputes for portfolios that
exist. The universe layer adds a supply-shaped sibling: precompute for *symbols
that scored*, whether or not anyone holds them.

### Lane A — Top-100 batch (scheduled, at quota reset)

```
00:10 UTC  (existing schedule, existing quota-reset rationale)
  SELECT ticker, score, action, indicators
    FROM universe_signals
   WHERE computed_at > now() - interval '36 hours'
     AND (action IN ('STRONG BUY','STRONG SELL') OR score >= 70 OR score <= 30)
   ORDER BY score DESC
   LIMIT 100
  → for each, generate a per-ticker narrative
  → savePrecomputed(kind='ticker_thesis', subject=<TICKER>, …)
```

Then a user opening any of those 100 tickers gets an AI narrative at **zero
quota cost and zero latency** — an ordinary `precomputed_ai` read, exactly the
mechanism the portfolio-health precompute already uses.

**The quota arithmetic is the hard constraint, and it does not currently work.**
OpenRouter's free tier is ~50 requests/day on the whole key. One hundred
tickers at one call each is 100 requests — double the entire daily allowance,
before the interactive Nu AI chat this whole precompute pattern exists to
protect gets a single call. Three ways out, in preference order:

1. **Batch multiple tickers per model call.** Ten tickers per prompt at ~200
   tokens of signal data each is a ~2k-token prompt well within any free
   model's context. 100 tickers becomes **10 calls**, leaving 40 for
   everything else. This is the recommended answer and it costs only a prompt
   rewrite plus a structured-output parse — the same shape as
   `council-verdict.ts`'s existing structured parsing.
2. **Cut the batch to the top 25** and accept narrower coverage.
3. **Add a second free-tier provider** (Groq and Cerebras both have separate
   free daily allowances) so the batch lane and the interactive lane draw from
   *different* buckets. This is also Finding 1's vendor-diversity fix from
   `gha-modal-core-feature-coverage.md` arriving from a second direction, and
   it is the only option here that raises the ceiling rather than rationing
   beneath it.

Set `MAX_TICKER_THESES` to something the quota can actually pay for, and have
the route stop early on `quotaExhausted` — both guards already exist in the
precompute route and should be reused verbatim rather than reinvented.

### Lane B — JIT for everything else

For a symbol *not* in the top-100 batch, the flow is unchanged from today:
`precomputed_ai` misses → the interactive route makes a live model call →
result is written back to `precomputed_ai` with a TTL so the second viewer of
the same ticker gets the cached copy. The universe layer makes this JIT path
*better* without changing it, because `universe_signals` and `signal_cache` are
already hydrated — the model call has real grounding data available instantly
instead of waiting on a cold 8-second gcp3 fetch.

The net effect is the tiering that makes the whole thing affordable:

| | Signal data | AI narrative |
|---|---|---|
| Top 100 by score | Hydrated nightly | **Precomputed** (batched, ~10 calls) |
| Rest of hot set (~500) | Hydrated nightly + intraday | JIT on first view, then cached |
| Long tail (~3,700) | Hydrated nightly EOD | JIT on first view, then cached |

---

## What to build, in order

Each step is independently shippable and leaves the app working.

**1. Universe table + weekly refresh** *(small)*
`lib/db/schema.sql` gets `ticker_universe`. A script pulls S&P 500 constituents
and the Nasdaq listing, upserts, and sets `tier`. Ship it dark — nothing reads
the table yet. Constituent sources: Alpaca `/v2/assets` for the exchange
listing; S&P 500 membership from any of the maintained public constituent lists
(committed to the repo and refreshed weekly by a GHA job is more reliable than
scraping at runtime — the Option E "discover on a schedule, commit the fact"
pattern from the companion doc).

**2. Bulk ingest endpoint** *(small)*
`POST /api/pipeline/hydrate-universe`, Bearer `PORTAL_PUSH_SECRET`, same auth
contract as `/api/signals/drain` and `/api/pipeline/precompute-ai`. Accepts
`{rows: [{ticker, score, action, close, volume, indicators, barDate}], source,
lane}`. Chunked multi-row upsert into `universe_signals`, one `hydration_runs`
row per call. Cap the body size and the row count — a 4,300-row single POST is
a timeout waiting to happen; the caller chunks at ~250.

**3. Per-stock engine + sweep** *(medium-high)*
The engine per the recommendation above (gcp3 `/signals/stocks`, or a Modal
pandas job if cross-repo is blocked), driven by a scheduler shaped like
`deploy/hydrate-universe/modal_app.py`, following `deploy/precompute-ai/`
exactly: `modal.Secret.from_name`, a `modal.Cron` schedule, a bounded
`MAX_SYMBOLS` outer guard, loud failure when the secret is missing. Runs 16:15
ET weekdays. This is the step that actually delivers universe coverage.

**4. Ranking read + `/api/signals/top`** *(small)*
`GET /api/signals/top?limit=100` over `universe_signals` ordered by score, with
a `lib/shared/universe-policy.ts` holding the pure ranking/threshold logic —
same split-for-testability rationale as `signal-policy.ts` and
`precompute-policy.ts`, so the thresholds get unit tests without needing
`DATABASE_URL`.

**5. Signal-gated AI batch** *(medium)*
Extend `/api/pipeline/precompute-ai` with a `kind: 'ticker_thesis'` mode fed by
step 4's ranking, using the batched-prompt approach. Reuse `MAX_SUBJECTS_CEILING`
and the `quotaExhausted` early-stop; do not add a second, differently-behaved
guard.

**6. Hot-set intraday lane** *(medium, optional)*
Option 2's Finnhub burst. Only after 1–5 are running and staleness is a real
complaint rather than an anticipated one.

---

## Where the indicator math lives (answered)

The first draft left this open: *can gcp3's `/signals` accept a symbol list?*
Verified — the question is moot. `GET /signals` already returns every row in one
call, but the rows are 54 ETFs, and there is no per-stock code path at all.

So the real decision is not batch-vs-single, it is **which repo owns per-stock
indicator computation** — and the answer must be exactly one of them. gcp3 is
the better home (feature modules, vendor fallback, bulk fetch all present); a
Modal pandas job is the faster home to build. Either is defensible. Two is not.

Whichever is chosen, the `source` column on `universe_signals` records which
lane produced each row, so a future disagreement is at least diagnosable rather
than invisible.

**Also worth fixing regardless:** `GET /signals?symbol=<non-ETF>` currently
returns `{"error": "not found"}` with a 200, and the portal's
`fetchTickerEntryLive` reads that as a successful response with no usable
entry. A 404, or an explicit `{"supported": false}`, would let the portal tell
"this ticker isn't covered" apart from "the backend is down" — which is the
distinction `concept-cache-then-degrade.md` is built on and currently can't
make here.

---

## What NOT to do

- **Don't route universe hydration through `pending_signals`.** That queue is
  demand-pull, one row per user request, with a unique index enforcing one
  pending row per ticker. Pushing 4,300 supply-side rows through it would
  contend with real user-triggered refreshes and make the queue depth metric
  meaningless. Bulk upsert directly.
- **Don't hydrate the long tail intraday.** Illiquid names don't move enough
  between EOD prints to justify the calls, and on Alpaca's IEX-only free feed
  many won't have intraday prints at all.
- **Don't let the universe sweep touch the OpenRouter quota.** Hydration is
  market data and indicator math — zero model calls. Only the ranked top-N
  batch spends AI quota, and it spends it at the reset, under the existing
  bounded-ceiling guards.
- **Don't precompute AI for the whole universe.** 4,300 narratives is not a
  quota problem to be solved, it is a category error: nobody reads 4,300
  narratives, and the ones worth reading are exactly the ones the ranking
  already identifies.
- **Don't scrape index constituents at request time.** Discover on a schedule,
  commit the fact, read it from the repo.

---

## See also

- `docs/gha-modal-core-feature-coverage.md` — Options C/D/F are the scheduling
  patterns this guide instantiates at universe scale
- `docs/api-failure-mitigation-build-options.md` — how the hydrated cache
  degrades when a vendor or the backend is down
- `lib/shared/signal-policy.ts` — `cacheTtlMinutes` already encodes the
  volatility-aware refresh idea this guide generalizes to tiers
- `app/api/pipeline/precompute-ai/route.ts` — the bounded, quota-aware batch
  pattern step 5 extends
- `deploy/precompute-ai/modal_app.py` — the Modal app shape step 3 copies
- `docs/wiki-portal/decision-pending-signals-queue.md` — why the existing queue
  is demand-pull, and therefore why this is a separate lane
- `docs/wiki-portal/decision-precompute-ai-at-quota-reset.md` — the quota-reset
  scheduling rationale the top-100 batch inherits
- `gcp3/backend/technical_signals.py` — `get_technical_signals()` and
  `_score_etf()`, the 54-ETF engine the finding at the top concerns
- `gcp3/backend/features_rsi.py`, `features_macd.py`, `features_volume.py` —
  the per-stock feature modules that exist but are not wired into `/signals`
