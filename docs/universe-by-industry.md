# Universe Organization by Industry — Encyclopedia, Metrics, and Integration

How the ticker universe is organized by industry sector, what metrics are computed per symbol, how it integrates with the portal, and what use cases it enables. Companion to `universe-scale-hydration.md`.

**Written 2026-08-18.** Two scopes are described, and they are deliberately distinct:

| Scope | Size | Status | Where documented |
|---|---:|---|---|
| **Registered universe** — active rows in `ticker_universe` today | **981** | Live as of 2026-08-18 | [Appendix A](#appendix-a--ticker-encyclopedia-registered-universe) — full per-symbol catalog |
| **Target universe** — the S&P 500 + Nasdaq full listing this architecture is sized for | ~4,300 | Planned | Sections below (metrics, tiers, integration) |

The registered 981 is **not** an index snapshot. It is a Yahoo portfolio export (680 symbols) unioned with a partial large-cap seed from an earlier `seed-universe.mjs` run (301 symbols). There is no index-membership column — `ticker_universe.universe` carries only `stock` | `etf` — so "is this an S&P 500 constituent?" cannot be answered from the table as it stands.

Everything from *Metrics Computed Per Symbol* onward describes the architecture at target scale. Appendix A is the ground-truth catalog of what is registered right now.

---

## Overview: Universe as a Ranked Index

The universe is not a static list. It is a **ranked, scored, tiered supply-side index** that surfaces the most interesting symbols to AI precomputation without forcing users to ask first.

```
ticker_universe (weekly refresh)
    ↓
hydration pipeline (daily/15-min refresh)
    ↓
universe_signals (computed metrics + rankings)
    ↓
ranking query → top-100 batch → AI precomputation (quota-aware)
    ↓
portal UI (hot symbols precomputed, rest JIT)
```

---

## Industry Tiers and Coverage

Sector ETFs are the *reference frame*: every stock is filed under one, letting a symbol be ranked against its own sector rather than against the S&P 500 as a whole.

The eleven SPDR sector ETFs against **actual registered coverage** (777 equities of the 981 rows; sector assignment is Yahoo's own classification):

| Sector ETF | Sector | Registered | Largest industries in the registered set |
|---|---|---:|---|
| **XLK** | Technology | 163 | Software–Infrastructure (38), Software–Application (34), Semiconductors (23) |
| **XLI** | Industrials | 106 | Aerospace & Defense (21), Specialty Industrial Machinery (19), Engineering & Construction (7) |
| **XLF** | Financial Services | 105 | Capital Markets (20), Asset Management (18), Banks–Regional (16) |
| **XLY** | Consumer Cyclical | 91 | Restaurants (13), Internet Retail (11), Auto Manufacturers (10) |
| **XLV** | Healthcare | 76 | Biotechnology (14), Diagnostics & Research (12), Medical Devices (11) |
| **XLP** | Consumer Defensive | 46 | Packaged Foods (11), Household & Personal Products (7), Beverages–Non-Alcoholic (5) |
| **XLB** | Basic Materials | 43 | Specialty Chemicals (9), Other Industrial Metals & Mining (8), Steel (6) |
| **XLC** | Communication Services | 38 | Internet Content & Information (12), Entertainment (11), Telecom Services (8) |
| **XLE** | Energy | 36 | Oil & Gas E&P (10), Oil & Gas Midstream (9), Oil & Gas Equipment & Services (4) |
| **XLRE** | Real Estate | 34 | REIT–Specialty (7), REIT–Retail (7), REIT–Residential (6) |
| **XLU** | Utilities | 32 | Utilities–Regulated Electric (23), Independent Power Producers (4), Diversified (2) |

*The remaining 204 rows are 173 ETFs, 4 cryptocurrencies, 1 mutual fund, 26 delisted symbols, and 7 equities Yahoo returns no sector for — all catalogued in [Appendix A](#appendix-a--ticker-encyclopedia-registered-universe).*

**Key insight: sector ETFs are not just categories — they are *tradeable reference points* for signal computation.**

When AAPL's RSI hits 70 and XLK is also overbought, that is a different signal than AAPL alone at 70. The portal ranks individual stocks *against their own sector ETF*.

---

**Key insight: Industry ETFs are not just categories—they are *tradeable reference points* for signal computation.**

When AAPL's RSI hits 70 and the broader XLK (Technology) is also overbought, that is a different signal than AAPL alone at 70. The portal ranks individual stocks *against their own industry ETF*, not against the S&P 500 as a whole.

---

## Metrics Computed Per Symbol

Every symbol in `universe_signals` gets a standard set of indicators refreshed on a regular cadence (daily EOD, plus intraday for hot set).

### Core Technical Indicators

| Indicator | Formula | Interpretation | Lookback | Null threshold |
|---|---|---|---|---|
| **RSI (Relative Strength Index)** | 100 - [100/(1+RS)] where RS = AvgGain/AvgLoss | Overbought >= 70, Oversold <= 30, Neutral 40–60 | 14 days | < 15 bars |
| **MACD (Moving Average Convergence Divergence)** | MACD = EMA(close, 12) - EMA(close, 26); Signal = EMA(MACD, 9); Histogram = MACD - Signal | Bullish: MACD crosses above signal; Bearish: below | 26 + 9 = 35 days | < 36 bars |
| **MA Cross (5/20/50/200)** | Close vs moving averages | Bullish: Price > MA; Death/Golden cross on MA cross | 200 days | < 200 bars |
| **Volume surge** | Current vol vs 20-day avg | Breakout confirmation: Vol > 150% of average | 20 days | < 20 bars |
| **ATR (Volatility)** | True range: max(H-L, \|H-Pc\|, \|L-Pc\|) smoothed | High ATR = high volatility regime; breakout risk | 14 days | < 15 bars |

### Confluence Score

A single 0–100 score aggregating all indicators into a comparable ranking:

```
score = blended(RSI_signal, MACD_signal, MA_signal, Volume_signal, Volatility_context)
  where blending weights high agreement across signals
  and volatility context boosts confidence in trending regimes

Direction: bullish (score > 50), bearish (score < 50), neutral (40–60)
Action: STRONG BUY (>= 75) | BUY (>= 60) | HOLD (40–60) | SELL (<= 40) | STRONG SELL (<= 25)
```

### Current State Scalars

| Field | Type | Usage |
|---|---|---|
| `close` | decimal | Comparison baseline for all MA calculations |
| `volume` | bigint | Raw volume for surge calculations; also stored for historical backtest |
| `bar_date` | date | Session this reflects; used to age the data |
| `indicators` | jsonb | Full detail (`{rsi: 62, macd: "bullish", ma_cross: "5>20", atr: 2.3, vol_surge: 1.2}`) — queryable for per-indicator sorting |

### Staleness Tiers

| Tier | Symbols | Data age acceptable | Refresh cadence |
|---|---|---|---|
| Tier 1 (hot set) | S&P 500 + Nasdaq-100 + watchlisted | < 15 min intraday, < 1 day EOD | 15 min (intraday), 16:15 ET (EOD) |
| Tier 2 (broad) | Top 1,000 by market cap/volume | < 4 hours, < 1 day EOD | 2x daily (intraday), 16:15 ET (EOD) |
| Tier 3 (tail) | Remainder (~3,300 micro-caps, illiquid) | < 1 day EOD | Once daily, 16:15 ET |

---

## Industry-Specific Metrics

Beyond the universal indicators, certain industries add sector-specific context:

### Technology (XLK)

**Additions:** earnings surprise rank, RSI relative to sector average, cloud growth trailing multiples

**Why:** Tech is forward-looking and multip le-expansion driven. A stock's RSI of 65 means something different if the sector average is 40 vs. 70. Cloud names (CRWD, SNOW, OKTA) also carry venture-backed expense patterns and need SaaS-specific margin tracking.

**Use case:** Rank tech names by bullish consensus within their sub-sector (semiconductors vs. software); surface breakouts during sector rotations.

### Healthcare (XLV)

**Additions:** clinical trial risk indicators (aggregate news volume on trial keywords), FDA approval calendar proximity, drug pipeline stage

**Why:** Healthcare has catalyst risk that technicals alone miss. A biotech up 40% could be pre-clinical (high risk) or Phase 3 (derisked). News volume spikes around trial readouts.

**Use case:** Identify FDA approval-gated signals; cluster biotech by pipeline maturity before precomputing AI narratives.

### Financials (XLF)

**Additions:** interest-rate sensitivity, credit-spread correlation, earnings volatility tracking

**Why:** Banks and brokers are interest-rate plays. Rising rates can invert the technicals entirely. A bank's RSI 30 "oversold" can be a sale if rates are rising faster.

**Use case:** Weight financials' signals by Fed funds futures; separate rate-driven moves from fundamental weakness.

### Energy (XLE)

**Additions:** oil/gas spot price correlation, geopolitical risk indexing, renewable energy displacement tracking

**Why:** Energy is commodity-linked and tail-risk prone (OPEC decisions, sanctions, wars). Also structurally declining as renewables scale. A bullish technical on XLE can be misleading if crude is falling.

**Use case:** Gate XLE bullish scores on crude price context; flag renewable names separately as growth plays, not commodity plays.

### Consumer Discretionary (XLY)

**Additions:** consumer sentiment indices, housing starts (for durables), margin trend vs. input inflation

**Why:** Consumer spending is leading-edge macroeconomic data. A discretionary stock up on volume in a rising-rate environment may be a dead-cat bounce.

**Use case:** Cluster discretionary by sensitivity to rate changes; surface margin-expanding names during stagflation.

---

## Database Schema: Where the Metrics Live

```sql
-- Core universe signals (refreshed daily/15-min per tier)
CREATE TABLE universe_signals (
  ticker              text PRIMARY KEY,
  score               real NOT NULL,                    -- 0–100, comparable across all sectors
  direction           text,                             -- bullish | bearish | neutral
  action              text,                             -- STRONG BUY | BUY | HOLD | SELL | STRONG SELL
  close               numeric,
  volume              bigint,
  indicators          jsonb NOT NULL DEFAULT '{}',     -- {rsi, macd, ma_cross, atr, vol_surge}
  source              text NOT NULL,                    -- 'alpaca-eod' | 'finnhub-15m' | 'gcp3'
  bar_date            date,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  -- Industry-specific extensions (nullable, populated on demand)
  sector_rsi_pctl     smallint,                         -- percentile within XLK, XLV, etc
  sector_momentum     real,                             -- relative outperformance vs sector avg
  catalyst_risk       jsonb,                            -- {"type": "earnings", "date": "2026-09-15", "surprise_odds": 0.6}
  valuation_context   jsonb                             -- {"pe_vs_sector": 1.2, "pb_vs_sector": 0.9}
);

-- Industry groupings (materialized for fast ranking)
CREATE TABLE industry_universe (
  ticker              text PRIMARY KEY REFERENCES ticker_universe(ticker),
  industry_etf        text NOT NULL,                    -- 'XLK', 'XLV', 'XLF', ...
  subsector           text,                             -- 'semiconductors', 'pharma', 'banks', ...
  market_cap_rank     int,                              -- rank within subsector
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX industry_universe_etf_idx ON industry_universe(industry_etf);

-- Refresh runs per industry (for observability)
CREATE TABLE hydration_runs (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lane                text NOT NULL,                    -- 'tier-1-15m', 'tier-2-4h', 'tier-3-eod'
  industry_etf        text,                             -- NULL for full-universe sweeps; set for targeted
  source              text NOT NULL,
  symbols_attempted   int NOT NULL DEFAULT 0,
  symbols_succeeded   int NOT NULL DEFAULT 0,
  symbols_failed      int NOT NULL DEFAULT 0,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  error               text
);
CREATE INDEX hydration_runs_lane_industry_idx ON hydration_runs(lane, industry_etf, started_at DESC);
```

---

## Integration Points with Portal

### 1. **Signal Discovery / Watchlist Alternatives**

**Current flow:**
```
user adds AAPL → enqueueSignalRefresh(AAPL) → gcp3 fetch → signal_cache
```

**New flow (with universe):**
```
user opens /signals/discover
  → SELECT top 50 FROM universe_signals
             WHERE score >= 70 OR action IN ('STRONG BUY', 'STRONG SELL')
             ORDER BY score DESC
  → group by industry_etf
  → render: {
      "Technology": [NVIDIA(88, STRONG BUY), AMD(75, BUY), ...],
      "Healthcare": [LLY(82, STRONG BUY), JNJ(65, BUY), ...],
      ...
    }
  → click a symbol → render precomputed_ai (if top-100) or JIT (if not)
```

**Key insight:** Users discover signals *top-down by strength*, not bottom-up by personal portfolio holdings.

### 2. **Portfolio Health Narratives (Precomputed)**

**Current:**
```
user opens /portfolio → listWatchlistSubjects()
  → precomputed_ai reads per watchlist ticker
  → renders cached narratives or JIT-computes
```

**Enhanced (with universe + batch precompute):**
```
/api/pipeline/precompute-ai?kind=ticker_thesis
  → SELECT top 100 FROM universe_signals ORDER BY score DESC
  → batch prompt: "Synthesize narratives for these 10 tickers: {NVDA(88), AMD(75), ...}"
  → 1 model call → 10 narratives (vs 10 calls for 10 narratives)
  → savePrecomputed(kind='ticker_thesis', subject='NVDA', narrative, ttl=24h)
  → user opens /portfolio + clicks NVDA → instant cached narrative
  
  → user opens /dashboard/nuai, asks "what should I buy today?"
    → summarize top-10 narratives into 1 curated briefing
    → render: "Markets favor tech (5 tickers STRONG BUY) and healthcare (3 STRONG BUY)"
```

**Quota impact:** 10 tickers in 1 call vs. 10 calls saves 90% of the daily quota for interactive use.

### 3. **Sector Rotation Detection**

**Use case:** Identify when *entire industries* cross a signal threshold.

```
/api/dashboard/sector-rotation
  → SELECT industry_etf, COUNT(*) as bullish_count, AVG(score) as avg_score
    FROM universe_signals u
    JOIN industry_universe i ON u.ticker = i.ticker
    WHERE u.computed_at > now() - interval '1 day'
    GROUP BY industry_etf
    ORDER BY avg_score DESC
  
  → render: {
      "Technology": {"bullish": 120, "avg_score": 62, "trend": "↗️ accelerating"},
      "Financials": {"bullish": 45, "avg_score": 48, "trend": "↘️ weakening"},
      ...
    }
  
  → user sees "Tech is in strong consensus up; Financials rolling over"
```

**Why it matters:** Portfolios are sector-weighted. Individual stock pickers miss rotations; this surfaces them.

### 4. **Industry Relative Strength Ranking**

**Query:** Which industry is the best opportunity right now?

```
SELECT industry_etf, 
       COUNT(CASE WHEN action IN ('STRONG BUY','BUY') THEN 1 END)::float / COUNT(*) as bullish_ratio,
       AVG(CASE WHEN action IN ('STRONG BUY','BUY') THEN score ELSE 0 END) as bullish_avg_score,
       COUNT(*) as coverage
FROM universe_signals u
JOIN industry_universe i ON u.ticker = i.ticker
WHERE u.computed_at > now() - interval '1 day'
GROUP BY industry_etf
ORDER BY bullish_ratio DESC, bullish_avg_score DESC;

-- Result: "Technology 67% bullish (avg 68), Healthcare 52% bullish (avg 55), Financials 34% bullish (avg 41)"
-- User insight: tech has the broadest bullish consensus
```

### 5. **Earnings Seasons and Catalyst Risk**

**Route: `/api/dashboard/earnings-calendar`**

```
SELECT DATE_TRUNC('week', earnings_date) as week,
       industry_etf,
       COUNT(*) as symbols_reporting,
       AVG(score) as pre_earnings_avg_score,
       (SELECT AVG(score) FROM universe_signals u2
        JOIN industry_universe i2 ON u2.ticker = i2.ticker
        WHERE i2.industry_etf = i.industry_etf
          AND DATE_TRUNC('week', u2.computed_at) = DATE_TRUNC('week', earnings_date) + interval '1 week'
       ) as post_earnings_avg_score
FROM universe_signals u
JOIN industry_universe i ON u.ticker = i.ticker
JOIN earnings_calendar ec ON u.ticker = ec.ticker
WHERE earnings_date > now() AND earnings_date < now() + interval '30 days'
GROUP BY week, industry_etf;
```

**User experience:** "Healthcare earnings this week: 87 names reporting. Currently bullish at avg 62; expect volatility post-reports."

### 6. **Backtest / Historical Analysis**

Store the full `indicators` jsonb on every refresh:

```
SELECT ticker, bar_date, indicators->>'rsi' as rsi, indicators->>'macd' as macd, score
FROM universe_signals_history
WHERE ticker IN ('NVDA', 'AMD', 'INTC')
  AND bar_date >= '2026-06-01' AND bar_date <= '2026-08-18'
ORDER BY bar_date;

-- Shows: NVDA RSI progression over 2.5 months, win/loss rate, accuracy of score
-- User asks: "In the last quarter, when this system said STRONG BUY, how often did it win?"
```

---

## Use Cases: What Users Do With This

### 1. **Passive Investor: Sector Rotation**

> *"I own a diversified portfolio across 5 ETFs. Which sector should I overweight this quarter?"*

**Flow:**
1. Open `/dashboard/sector-rotation`
2. See: Technology (67% bullish, accelerating), Healthcare (52%, flat), Financials (34%, weakening)
3. Rebalance: overweight Tech, underweight Financials
4. Done in 2 minutes, zero stock-picking

### 2. **Swing Trader: Intraday Breakouts**

> *"Show me any symbol in my watchlist that's about to break out."*

**Flow:**
1. Open `/signals/watchlist-scan`
2. Filter: `score >= 70 AND volume_surge > 1.5 AND macd == "bullish"`
3. See: [PLUG at 16:30, NVDA at 16:45, ENPH at 17:00]
4. Place orders 5 minutes before close

### 3. **AI Researcher: Narrative Generation**

> *"Generate brief summaries for the top 50 bullish stocks right now. What do they have in common?"*

**Flow:**
1. Backend nightly: precompute narratives for top 50 (10 calls, batched)
2. User opens `/portfolio/ai-research`
3. See: 50 cached narratives, each 2–3 sentences
4. Copy all text → prompt LLM: "Cluster these by narrative type"
5. Result: "30 momentum plays, 15 value recoveries, 5 catalysts"

### 4. **Risk Manager: Concentration by Industry**

> *"We're overweight Healthcare (25% of portfolio). Show me Healthcare names, ranked by weakness, in case we need to trim."*

**Flow:**
1. Open `/portfolio/industry-breakdown`
2. See: Healthcare concentration, sorted by score (worst first)
3. Trim the three lowest-scoring names
4. Rebalance out of over-concentrated sector

### 5. **Earnings Surprise Play**

> *"Which companies report earnings this week in bullish setups?"*

**Flow:**
1. Open `/signals/earnings-calendar`
2. Filter: earnings_date between now and 7 days, score >= 70
3. See: [NVIDIA (88, 9/8), Apple (76, 9/10), Broadcom (74, 9/12)]
4. Pre-position volatility trades

### 6. **Long-Term Investor: Undervalued Sectors**

> *"Find me 10 stocks in weak industries (< 40% bullish) that personally score high."*

**Flow:**
```
SELECT u.ticker, u.score, i.industry_etf, sector_stats.bullish_pct
FROM universe_signals u
JOIN industry_universe i ON u.ticker = i.ticker
JOIN (
  SELECT industry_etf, COUNT(*) filter (WHERE score >= 60)::float / COUNT(*) as bullish_pct
  FROM universe_signals u2
  JOIN industry_universe i2 ON u2.ticker = i2.ticker
  GROUP BY industry_etf
  HAVING bullish_pct < 0.4  -- weak sector
) sector_stats ON i.industry_etf = sector_stats.industry_etf
WHERE u.score >= 70
ORDER BY sector_stats.bullish_pct ASC, u.score DESC
LIMIT 10;
```

**Result:** Undervalued sectors with pockets of strength; contrarian long setup.

---

## Refresh Schedules by Tier and Use Case

| Tier | Symbols | EOD refresh | Intraday cadence | Triggers precompute? | Use case |
|---|---|---|---|---|---|
| **Hot set (Tier 1)** | S&P 500 + Nasdaq-100 + watchlist (600–800) | 16:15 ET | Every 15 min | Yes — top-100 batch | Day traders, momentum plays, user watchlists |
| **Broad (Tier 2)** | Top 1000 by volume + market cap | 16:15 ET | Every 4 hours | Partial — included in scoring, precomputed only if score >= 75 | Swing traders, sector rotations |
| **Tail (Tier 3)** | Remainder (~3,300) | 16:15 ET | None (EOD only) | No — JIT only if user asks | Research, earnings event trades, deep contrarians |

---

## Performance Expectations

### Latency

| Query | Source | Latency | Notes |
|---|---|---|---|
| Top 50 scores | universe_signals (index on score DESC) | < 10ms | Full table scan with index; Postgres optimizer loves this |
| Top 50 by industry | Same, grouped | < 50ms | Slight overhead from grouping; still sub-second |
| Precomputed narrative | precomputed_ai cache | < 1ms | Memcached hit; no DB query |
| JIT narrative | Model API | 2–8 sec | Live call to OpenRouter; still fast vs. historical fetches |
| Industry rotation | Aggregation query | 100–200ms | GROUP BY across industry_universe join; no big deal |
| Earnings calendar filter | Indexed join on earnings_date | < 100ms | High-cardinality index on date; effective |

### Storage

| Table | ~4,300 symbols | Size estimate | Notes |
|---|---|---|---|
| `universe_signals` (current) | 4,300 rows | ~2 MB | One row per ticker; score + jsonb |
| `universe_signals_history` (90 days) | 4,300 × 90 | ~180 MB | Archival; compress or partition by quarter |
| `industry_universe` | 4,300 rows | < 1 MB | Just ticker, industry_etf, subsector |
| `hydration_runs` (90 days) | ~270 rows | < 500 KB | One row per scheduled run; lightweight |

**Total: ~184 MB for 90 days of history. Acceptable on any Neon tier.**

---

## What's NOT in the Universe (Yet)

- **Intraday tick-by-tick data** — would be ~100x storage; not needed for daily refreshes
- **Options implied volatility** — requires options API (separate vendor); orthogonal to stock signals
- **Macro context** (VIX, yield curve, USD index) — separate tables; included only in narrative precompute, not per-symbol scores
- **Sentiment/news indicators** — would require NLP pipeline; currently only AI narratives synthesize news
- **Fundamentals** (P/E, dividend yield, debt/equity) — query from a fundamentals service (CapitalIQ, Morningstar); not recomputed daily

---

## Registered Universe: How It Got There

The 981 active rows in `ticker_universe` come from two unrelated seeds, not from an index constituent feed.

### Seed 1 — pre-existing large-cap set (301 symbols)

Registered by an earlier `scripts/seed-universe.mjs` run. These are S&P 500-style large caps (`ABT`, `ACN`, `ADBE`, `AMZN`, `AON`, `APD`, `AEP`, …) that never appeared in the portfolio export. No record of the run's date or its constituent source survives in the table — there is no `source` or `index` column to carry it.

### Seed 2 — Yahoo portfolio export (680 symbols)

```bash
# Yahoo paginates portfolio exports across "portfolio.csv", "portfolio (1).csv", ...
# The script unions the Symbol column across every CSV in the directory.
PORTAL_PUSH_SECRET=… node scripts/seed-yahoo-portfolio.mjs ~/Downloads/portfolio-yahoo

#   Parsed 26 files (2 skipped as unusable). 680 distinct US tickers,
#   1 non-US skipped, 5 rejected.
#   Done — 680 tickers registered in ticker_universe.
```

**Why 680 and not 686.** The export contains 686 unique symbols; six never reach the database:

| Excluded | Reason |
|---|---|
| `WIZZ.L` | Non-US listing (Yahoo suffix notation). Alpaca — the only source `deploy/universe-hydration/modal_app.py` hydrates from — covers US equities only, so registering it would guarantee a permanent per-symbol failure. |
| `3750.HK` | Same, plus fails the ticker shape regex. |
| `BZ=F`, `CL=F`, `ETH=F` | Futures contracts; `=F` fails the ticker shape regex. |
| `^VOLQ` | Index, not a tradeable symbol; `^` fails the regex. |

Two of the 26 CSVs (`portfolio (19).csv`, `portfolio (25)cann.csv`) were skipped as unusable — Yahoo occasionally serves a plaintext error page in place of a download, and the script detects the missing `Symbol` column rather than silently reading zero tickers.

---

## Data-Quality Corrections Applied 2026-08-18 → 08-19

Seven defects were found and fixed. They fall into two groups, and the split matters: defects 1–3 came from **seeding** (wrong labels in `ticker_universe`), 4–7 from the **hydration and ranking path** (wrong or absent data in `ticker_cards`). Fixing the first group is what made the second group visible — an empty ranking looks the same as a correct one until the rows arrive.

The net effect: the top-N ranking went from returning **0 rows** to returning 100 real equities.

### 1. Every row was labeled `stock` — including 178 funds

`seed-yahoo-portfolio.mjs` hardcodes `universe: "stock"` for everything it sends (line 111). Combined with the pre-existing seed, that left **`?universe=etf` returning zero** while `stock` returned the entire table. Any consumer filtering `universe = 'stock'` to mean "equities" was silently including `TQQQ`, `SOXL`, `SQQQ`, `SPXU` and every other leveraged or inverse product.

Corrected by re-registering all rows with `quoteType`-derived labels:

| Label | Rows | Contents |
|---|---:|---|
| `etf` | 178 | 173 ETFs + 4 cryptocurrencies + 1 mutual fund |
| `stock` | 803 | Equities, plus 26 delisted symbols left as-is |

`CardUniverse` is strictly `"etf" | "stock"` (`lib/shared/card-policy.ts`), so cryptocurrencies and mutual funds map to `etf`: they are baskets whose price is not a single company's equity. A finer taxonomy would need a schema change.

### 2. Share-class tickers: the two vendors disagree, and Alpaca wins

**Yahoo and Alpaca spell share classes differently, and the pipeline must follow Alpaca.** Verified against both APIs:

| Spelling | Yahoo `get_info()` | Alpaca `/v2/stocks/bars` |
|---|---|---|
| `BRK.B` / `BF.B` | nameless stub (`BF.B` even reports `MUTUALFUND`) | **200, real bars** |
| `BRK-B` / `BF-B` | full metadata, correct sector | **400 `invalid symbol`** |

Alpaca is the only source `deploy/universe-hydration/modal_app.py` and `scripts/hydrate-local.mjs` fetch from, so **the dot form is canonical for this system** — matching the example already cited in `normalizeTicker` (`lib/shared/signal-policy.ts:19`).

An earlier pass this same day got this backwards: it read Yahoo's richer metadata as evidence that the dash form was correct, deactivated `BRK.B`/`BF.B`, and registered `BRK-B`/`BF-B`. Those dash rows then failed to hydrate at all — Alpaca 400s on them. Corrected: the dot forms are active and carrying cards; the dash forms are `active = false`.

The general rule this cost a round trip to learn: **metadata richness is not a correctness signal.** Ask the vendor that will actually serve the bars.

### 3. Display names were never populated

`ticker_universe.name` was null for every row despite `upsertUniverse` accepting it. 954 of 981 rows now carry a real company or fund name; the 27 without are symbols Yahoo returns no metadata for.

### 4. The ranking returned zero rows

`topCards()` gates on `missing_fields = '{}'`. Every one of the 880 stored cards carried `missing_fields = ["macdCross"]` and `data_quality = 0.8`, so **the top-N ranking returned nothing at all** — an empty list, not a degraded one.

The cause was stale data, not broken code. `macdCross()` returns three distinct values, and the distinction is the whole point:

| Return | Means | `missing_fields` |
|---|---|---|
| `"bullish"` / `"bearish"` | a cross on the latest bar | — |
| `null` | computed, **no cross** — a real observation | — |
| `"missing"` | fewer than `slow + signal` = 35 bars | `["macdCross"]` |

The cards were written at 19:12 UTC; the commit that fixed the omit-vs-null handling (`9036d44`) landed at 20:02 UTC — 50 minutes later. Re-running `hydrate-local.mjs` against the current code resolved it:

| | before | after |
|---|---:|---:|
| t1 cards passing the ranking gate | **0** | **733** |
| `data_quality = 1.0` | 0 | 733 |

**Watch for this recurring:** `dataQuality = 0.8` with `missing_fields = ["macdCross"]` across the *whole* universe means MACD is being omitted upstream, not that the tape is quiet. A genuinely quiet tape produces `null` and `data_quality = 1.0`.

### 5. Card labels drifted from the universe table

`ticker_cards` carries its own `universe` column, written from the POST body. `hydrate-local.mjs` hardcoded `universe: "stock"` for every batch (the same defect as the seeder), so 306 ETF cards were stored as stocks even after `ticker_universe` was corrected.

Fixed by making the script lane-aware — it now walks `stock` then `etf`, labeling each batch correctly, with a `--universe=` flag to run one lane. Drift is now zero.

### 6. One bad symbol destroyed its entire chunk

Alpaca rejects a whole multi-symbol request with `400 invalid symbol: X` if any single symbol is not a US equity. `fetchBars` threw, so the chunked caller lost all ten symbols it asked about. Four crypto pairs (`BTC-USD`, `ETH-USD`, `SOL-USD`, `DOGE-USD`) therefore cost **40 rows** in the ETF run.

`fetchBars` now parses the offending symbol out of the 400, drops it, and retries the remainder; other errors (auth, rate limit, network) still throw, since those are not per-symbol problems. Post-failures went 40 → 0.

### 7. Inverse and leveraged ETFs were ranked as BUY recommendations

With ETF cards finally complete, the top-100 became **71% ETFs** — `SMST` (2x inverse MicroStrategy) at `BUY`, spot-Bitcoin trusts, and 22 inverse/short products in total.

This is not a scoring bug. The score is a directional read on a price series, and an inverse fund's series is the negation of the exposure its name implies: SQQQ rising *is* the Nasdaq falling. Ranking those beside equities is a category error.

`topCards()` now takes a `universe` argument defaulting to `'stock'`:

| `universe` | rows | ETFs in top-100 |
|---|---:|---:|
| `'stock'` (default) | 100 | **0** |
| `'etf'` | 100 | 100 (funds ranked among themselves) |
| `'all'` | 100 | 71 (the old behavior, now opt-in) |

Setting the default was free: `topCards` has no callers yet.

### 8. The grounding-pack compiler failed silently on a retired model

`compile_grounding_pack.mjs` hardcoded `qwen/qwen3-next-80b-a3b-instruct:free` as its extraction model. OpenRouter has since retired that id, so **every** extraction call 404'd — and the script warned per-chunk, then exited **0** with `rules_extracted=0`. That output is indistinguishable from "the corpus contained no extractable rules," which is exactly what an empty `corpus/` would legitimately produce.

Three fixes:

| Problem | Fix |
|---|---|
| Hardcoded model id goes stale | Default now reads the head of `FREE_MODEL_CHAIN` from `lib/openrouter.ts` — the chain `scripts/refresh-free-models.mjs` already live-probes and maintains. One source of truth instead of two. |
| A 404 was survivable per-chunk | A 404 is a dead model id, not a chunk problem — now throws and exits non-zero. |
| Total extraction failure exited 0 | Transport failures (429/5xx/timeout) are counted separately; if *every* chunk failed, the run throws rather than reporting a successful empty compile. |

The run log now names the model it is using, so the next stale-id failure is one line of output away from diagnosis.

**The same latent bug is worse elsewhere.** Probing every id in `SEAT_MODELS` (`lib/openrouter.ts`) against the live catalog: **five of the six council seats point at models that no longer exist.**

| Seat | Model | Status |
|---|---|---|
| T1 | `cohere/command-r7b-12-2024` | OK |
| T2 | `qwen/qwen3-next-80b-a3b-instruct:free` | **gone** |
| RISK | `meta-llama/llama-3.3-70b-instruct:free` | **gone** |
| MACRO | `qwen/qwen3-next-80b-a3b-instruct:free` | **gone** |
| QUANT | `mistralai/mistral-7b-instruct:free` | **gone** |
| CHAIR | `qwen/qwen3-next-80b-a3b-instruct:free` | **gone** |

Those seats fall back through `FREE_MODEL_CHAIN`, so the council degrades rather than breaking — but it burns a guaranteed-404 call per seat first, and the seat-to-model assignment documented in `docs/council-prompting-small-models.md` §10 (spend the best model on CHAIR) no longer describes what actually runs. `refresh-free-models.mjs` maintains `FREE_MODEL_CHAIN` but does **not** touch `SEAT_MODELS`, which is why the chain is current and the seats are not. Not fixed here — it is council code, outside this change's blast radius — but it should be the next thing picked up.

### Still outstanding

- **26 dead symbols.** They parse as valid US tickers but Yahoo returns no metadata — acquired, taken private, or renamed (`TWTR` → X, `PXD` → ExxonMobil, `WBA` → taken private, `CFLT`, `CTRA`, `SAGE`, `ACLX`, …). Listed in [Appendix A.3](#delisted--no-longer-quoted-26). Still active; they fail every hydration run. Pruning them is the cheapest reduction in recurring per-symbol failures.
- **61 active tickers still have no card**, mostly "insufficient history" — genuinely new listings and the 4 crypto pairs Alpaca will never serve from a stocks endpoint.
- **`grounding_pack` is empty (0 rows), and blocked on two things.** The `ticker_cards.state_key` → `grounding_pack.state_key` join is what the schema calls "the quiet payoff" — cited, corpus-grounded rules at Tier 0 for zero model calls. `groundingHits` is 0 on every card until the pack compiles. Two blockers, in order:

  1. **`corpus_chunks` is also empty, and the production corpus is not on this machine.** `corpus/` holds only the two files `corpus/README.md` marks as samples. The real Q&A corpus (`t1-*-100-questions.md`, `t2-*`, `trader-profiles-updated.md`) lives in a sibling repo's `DOCS_ROOT` (`../ai-text-opt/docs/trader-qa`), which is not checked out here — `ai-text-opt-1024` exists but contains engineering docs, not the trader Q&A set. The README is explicit that the corpus was **not** copied "sight-unseen," and compiling a pack from whatever markdown happens to be nearby would fill Tier 0 with confident, verbatim-cited, *irrelevant* rules — worse than an empty pack, because it looks grounded.
  2. **The OpenRouter free-model daily quota is exhausted** (`free-models-per-day`, 50/day, 0 remaining). Extraction is one model call per chunk, so no rules can be compiled until the daily reset.

  The compiler itself is verified working end-to-end: chunking produces chunks, the model returns well-formed rules, and the verbatim gate rejects the ones that fail it. Only data and quota are missing.

---

## See Also

- `docs/universe-scale-hydration.md` — architectural options, quota math, build sequence
- `docs/gha-modal-core-feature-coverage.md` — scheduler patterns this inherits (Option F: fan-out on Modal)
- `scripts/seed-yahoo-portfolio.mjs` — portfolio-export seeder (hardcodes `universe: "stock"` — see correction 1)
- `scripts/seed-universe.mjs` — S&P 500 / Nasdaq-100 constituent seeder (the target-scale path)
- `app/api/pipeline/hydrate-universe/route.ts` — `GET` lists, `PUT` registers membership, `POST` ingests bars
- `lib/ticker-cards-db.ts` — `upsertUniverse` (idempotent), `listActiveTickers`
- `lib/shared/card-policy.ts` — `CardUniverse` type (`"etf" | "stock"`)
- `docs/wiki-portal/entity-ticker-universe-pipeline.md` — wiki entity documenting the pipeline

---

## Appendix A — Ticker Encyclopedia (Registered Universe)

A complete, alphabetically-indexed catalog of every **active symbol in `ticker_universe`**, filed by **sector → industry** using Yahoo's own classification (`sector` / `industry` / `quoteType` fields), not hand-assignment.

**Total registered: 981** — 777 equities, 173 ETFs, 4 cryptocurrencies, 1 mutual fund, 26 delisted/no longer quoted.

**Two provenances, one table:**

| Origin | Symbols | How it got registered |
|---|---:|---|
| Yahoo portfolio export | 679 | `scripts/seed-yahoo-portfolio.mjs` over 26 CSVs in `~/Downloads/portfolio-yahoo/` (captured 2026-08-18) |
| Pre-existing index seed | 302 | Large-cap constituents registered by an earlier `scripts/seed-universe.mjs` run |

> **Provenance note.** Classification is machine-derived via `yfinance` (`Ticker.get_info()`), so a symbol appears under the sector Yahoo assigns it. Where Yahoo returns no sector — typically delisted, acquired, or warrant/trust structures — the symbol is listed under *Unclassified* rather than guessed at.

> **This is not yet S&P 500 + Nasdaq coverage.** The registered set is a portfolio export unioned with a partial large-cap seed — 981 symbols against the ~4,300 the architecture below is sized for. No index-membership column exists: `ticker_universe.universe` carries only `stock` | `etf`, so "is this an S&P 500 constituent?" is not currently answerable from the table.

---

### A.1 Equities by Sector

| Sector | Symbols | Industries |
|---|---:|---:|
| [Technology](#technology) | 163 | 12 |
| [Industrials](#industrials) | 106 | 21 |
| [Financial Services](#financial-services) | 105 | 11 |
| [Consumer Cyclical](#consumer-cyclical) | 91 | 19 |
| [Healthcare](#healthcare) | 76 | 10 |
| [Consumer Defensive](#consumer-defensive) | 46 | 12 |
| [Basic Materials](#basic-materials) | 43 | 11 |
| [Communication Services](#communication-services) | 38 | 6 |
| [Energy](#energy) | 36 | 8 |
| [Real Estate](#real-estate) | 34 | 9 |
| [Utilities](#utilities) | 32 | 5 |

#### Technology

*163 symbols across 12 industries.*

##### Software - Infrastructure (38)

| Ticker | Name |
|---|---|
| `AI` | C3.ai |
| `AKAM` | Akamai Technologies |
| `ARQQ` | Arqit Quantum |
| `AVPT` | AvePoint |
| `CHKP` | Check Point Software Technologies |
| `CLBT` | Cellebrite DI |
| `CORZ` | Core Scientific |
| `CPAY` | Corpay |
| `CRWD` | CrowdStrike Holdings |
| `CRWV` | CoreWeave |
| `DOCN` | DigitalOcean Holdings |
| `FFIV` | F5 |
| `FTNT` | Fortinet |
| `GDDY` | GoDaddy |
| `GEN` | Gen Digital |
| `GRRR` | Gorilla Technology Group |
| `GTLB` | GitLab |
| `INFQ` | Infleqtion |
| `IOT` | Samsara |
| `MDB` | MongoDB |
| `MSFT` | Microsoft |
| `NET` | Cloudflare |
| `NTAP` | NetApp |
| `NTSK` | Netskope |
| `OKTA` | Okta |
| `ORCL` | Oracle |
| `PANW` | Palo Alto Networks |
| `PATH` | UiPath |
| `PLTR` | Palantir Technologies |
| `QNC` | Quantum eMotion |
| `S` | SentinelOne |
| `SNPS` | Synopsys |
| `TDC` | Teradata |
| `TOST` | Toast |
| `TWLO` | Twilio |
| `VRSN` | VeriSign |
| `XYZ` | Block |
| `ZS` | Zscaler |

##### Software - Application (34)

| Ticker | Name |
|---|---|
| `ADBE` | Adobe |
| `ADP` | Automatic Data Processing |
| `ADSK` | Autodesk |
| `BSY` | Bentley Systems, Incorporated |
| `CDNS` | Cadence Design Systems |
| `CRM` | Salesforce |
| `CXAI` | CXApp |
| `DDOG` | Datadog |
| `ESTC` | Elastic |
| `FICO` | Fair Isaac |
| `FSLY` | Fastly |
| `GRAB` | Grab Holdings Limited |
| `GWRE` | Guidewire Software |
| `HUBS` | HubSpot |
| `INTU` | Intuit |
| `KVYO` | Klaviyo |
| `LYFT` | Lyft |
| `MSTR` | Strategy |
| `NOW` | ServiceNow |
| `PAYX` | Paychex |
| `PEGA` | Pegasystems |
| `PTC` | PTC |
| `ROP` | Roper Technologies |
| `SAP` | SAP SE |
| `SHOP` | Shopify |
| `SNOW` | Snowflake |
| `SOUN` | SoundHound AI |
| `TEAM` | Atlassian |
| `TYL` | Tyler Technologies |
| `U` | Unity Software |
| `UBER` | Uber Technologies |
| `WDAY` | Workday |
| `YMM` | Full Truck Alliance Co. |
| `ZM` | Zoom Communications |

##### Semiconductors (23)

| Ticker | Name |
|---|---|
| `ADI` | Analog Devices |
| `ALAB` | Astera Labs |
| `AMD` | Advanced Micro Devices |
| `ARM` | Arm Holdings |
| `ASX` | ASE Technology Holding Co. |
| `AVGO` | Broadcom |
| `CRDO` | Credo Technology Group Holding |
| `INTC` | Intel |
| `LAES` | SEALSQ |
| `MCHP` | Microchip Technology Incorporated |
| `MPWR` | Monolithic Power Systems |
| `MRVL` | Marvell Technology |
| `MU` | Micron Technology |
| `NVDA` | NVIDIA |
| `NXPI` | NXP Semiconductors |
| `ON` | ON Semiconductor |
| `PRSO` | Peraso |
| `QCOM` | QUALCOMM Incorporated |
| `SKHY` | SK hynix |
| `SMTC` | Semtech |
| `SWKS` | Skyworks Solutions |
| `TSM` | Taiwan Semiconductor Manufacturing Company Limited |
| `TXN` | Texas Instruments Incorporated |

##### Information Technology Services (15)

| Ticker | Name |
|---|---|
| `ACN` | Accenture |
| `APLD` | Applied Digital |
| `BBAI` | BigBear.ai Holdings |
| `BR` | Broadridge Financial Solutions |
| `CDW` | CDW |
| `CIFR` | Cipher Digital |
| `CTSH` | Cognizant Technology Solutions |
| `FIS` | Fidelity National Information Services |
| `IBM` | International Business Machines |
| `IT` | Gartner |
| `JKHY` | Jack Henry & Associates |
| `LDOS` | Leidos Holdings |
| `PONY` | Pony AI |
| `SAIC` | Science Applications International |
| `WIT` | Wipro Limited |

##### Semiconductor Equipment & Materials (14)

| Ticker | Name |
|---|---|
| `AMAT` | Applied Materials |
| `AMBA` | Ambarella |
| `AMKR` | Amkor Technology |
| `ASML` | ASML Holding |
| `ATOM` | Atomera Incorporated |
| `FORM` | FormFactor |
| `KLAC` | KLA |
| `KLIC` | Kulicke and Soffa Industries |
| `LRCX` | Lam Research |
| `ONTO` | Onto Innovation |
| `Q` | Qnity Electronics |
| `TER` | Teradyne |
| `UCTT` | Ultra Clean Holdings |
| `VECO` | Veeco Instruments |

##### Computer Hardware (13)

| Ticker | Name |
|---|---|
| `ANET` | Arista Networks |
| `BTCT` | BTC Digital |
| `DELL` | Dell Technologies |
| `HPQ` | HP |
| `IONQ` | IonQ |
| `QBTS` | D-Wave Quantum |
| `QMCO` | Quantum |
| `QUBT` | Quantum Computing |
| `RGTI` | Rigetti Computing |
| `SMCI` | Super Micro Computer |
| `SNDK` | Sandisk |
| `STX` | Seagate Technology Holdings |
| `WDC` | Western Digital |

##### Communication Equipment (9)

| Ticker | Name |
|---|---|
| `AMPG` | AmpliTech Group |
| `CIEN` | Ciena |
| `CSCO` | Cisco Systems |
| `HPE` | Hewlett Packard Enterprise |
| `LITE` | Lumentum Holdings |
| `MSI` | Motorola Solutions |
| `NOK` | Nokia Oyj |
| `UI` | Ubiquiti |
| `ZBRA` | Zebra Technologies |

##### Scientific & Technical Instruments (6)

| Ticker | Name |
|---|---|
| `COHR` | Coherent |
| `FTV` | Fortive |
| `GRMN` | Garmin |
| `KEYS` | Keysight Technologies |
| `TDY` | Teledyne Technologies Incorporated |
| `TRMB` | Trimble |

##### Electronic Components (5)

| Ticker | Name |
|---|---|
| `APH` | Amphenol |
| `FLEX` | Flex |
| `GLW` | Corning Incorporated |
| `JBL` | Jabil |
| `TEL` | TE Connectivity |

##### Solar (4)

| Ticker | Name |
|---|---|
| `FSLR` | First Solar |
| `JKS` | JinkoSolar Holding Co. |
| `RUN` | Sunrun |
| `SPWR` | SunPower |

##### Consumer Electronics (1)

| Ticker | Name |
|---|---|
| `AAPL` | Apple |

##### Electronics & Computer Distribution (1)

| Ticker | Name |
|---|---|
| `SNX` | TD SYNNEX |

#### Industrials

*106 symbols across 21 industries.*

##### Aerospace & Defense (21)

| Ticker | Name |
|---|---|
| `ATRO` | Astronics |
| `AXON` | Axon Enterprise |
| `BA` | The Boeing |
| `EADSY` | Airbus SE |
| `FTAI` | FTAI Aviation |
| `GD` | General Dynamics |
| `GE` | GE Aerospace |
| `HII` | Huntington Ingalls Industries |
| `HONA` | Honeywell Aerospace |
| `HWM` | Howmet Aerospace |
| `LHX` | L3Harris Technologies |
| `LMT` | Lockheed Martin |
| `LUNR` | Intuitive Machines |
| `NOC` | Northrop Grumman |
| `PL` | Planet Labs PBC |
| `RDW` | Redwire |
| `RKLB` | Rocket Lab |
| `RTX` | RTX |
| `SPCX` | Space Exploration Technologies |
| `TDG` | TransDigm Group Incorporated |
| `TXT` | Textron |

##### Specialty Industrial Machinery (19)

| Ticker | Name |
|---|---|
| `AME` | AMETEK |
| `AOS` | A. O. Smith |
| `CMI` | Cummins |
| `DOV` | Dover |
| `EMR` | Emerson Electric |
| `ETN` | Eaton Corporation |
| `GEV` | GE Vernova |
| `GNRC` | Generac Holdings |
| `IEX` | IDEX |
| `IR` | Ingersoll Rand |
| `ITW` | Illinois Tool Works |
| `NDSN` | Nordson |
| `OTIS` | Otis Worldwide |
| `PH` | Parker-Hannifin |
| `PNR` | Pentair |
| `ROK` | Rockwell Automation |
| `SHMD` | SCHMID Group |
| `SYM` | Symbotic |
| `XYL` | Xylem |

##### Airlines (7)

| Ticker | Name |
|---|---|
| `ALGT` | Allegiant Travel |
| `ALK` | Alaska Air Group |
| `CPA` | Copa Holdings |
| `DAL` | Delta Air Lines |
| `LUV` | Southwest Airlines |
| `UAL` | United Airlines Holdings |
| `VLRS` | Controladora Vuela Compañía de Aviación, S.A.B. de C.V. |

##### Building Products & Equipment (7)

| Ticker | Name |
|---|---|
| `BLDR` | Builders FirstSource |
| `CARR` | Carrier Global |
| `GFF` | Griffon |
| `JCI` | Johnson Controls International |
| `LII` | Lennox International |
| `MAS` | Masco |
| `TT` | Trane Technologies |

##### Engineering & Construction (7)

| Ticker | Name |
|---|---|
| `ACA` | Arcosa |
| `CDNL` | Cardinal Infrastructure Group |
| `EME` | EMCOR Group |
| `FER` | Ferrovial |
| `FIX` | Comfort Systems USA |
| `J` | Jacobs Solutions |
| `PWR` | Quanta Services |

##### Integrated Freight & Logistics (7)

| Ticker | Name |
|---|---|
| `CHRW` | C.H. Robinson Worldwide |
| `EXPD` | Expeditors International of Washington |
| `FDX` | FedEx |
| `FDXF` | FedEx Freight Holding Company |
| `GXO` | GXO Logistics |
| `JBHT` | J.B. Hunt Transport Services |
| `UPS` | United Parcel Service |

##### Specialty Business Services (5)

| Ticker | Name |
|---|---|
| `CPRT` | Copart |
| `CTAS` | Cintas |
| `GPN` | Global Payments |
| `TH` | Target Hospitality |
| `TRI` | Thomson Reuters |

##### Conglomerates (4)

| Ticker | Name |
|---|---|
| `CRESY` | Cresud Sociedad Anónima, Comercial, Inmobiliaria, Financiera y Agropecuaria |
| `HON` | Honeywell International |
| `MMM` | 3M |
| `SEB` | Seaboard |

##### Electrical Equipment & Parts (4)

| Ticker | Name |
|---|---|
| `BLDP` | Ballard Power Systems |
| `EOSE` | Eos Energy Enterprises |
| `HUBB` | Hubbell Incorporated |
| `VRT` | Vertiv Holdings Co |

##### Farm & Heavy Construction Machinery (4)

| Ticker | Name |
|---|---|
| `CAT` | Caterpillar |
| `DE` | Deere & |
| `PCAR` | PACCAR |
| `TEX` | Terex |

##### Industrial Distribution (4)

| Ticker | Name |
|---|---|
| `FAST` | Fastenal |
| `FERG` | Ferguson Enterprises |
| `GWW` | W.W. Grainger |
| `QXO` | QXO |

##### Railroads (4)

| Ticker | Name |
|---|---|
| `CSX` | CSX |
| `NSC` | Norfolk Southern |
| `UNP` | Union Pacific |
| `WAB` | Westinghouse Air Brake Technologies |

##### Consulting Services (2)

| Ticker | Name |
|---|---|
| `EFX` | Equifax |
| `VRSK` | Verisk Analytics |

##### Security & Protection Services (2)

| Ticker | Name |
|---|---|
| `ALLE` | Allegion |
| `GFAI` | Guardforce AI Co., Limited |

##### Tools & Accessories (2)

| Ticker | Name |
|---|---|
| `SNA` | Snap-on Incorporated |
| `SWK` | Stanley Black & Decker |

##### Waste Management (2)

| Ticker | Name |
|---|---|
| `RSG` | Republic Services |
| `WM` | Waste Management |

##### Airports & Air Services (1)

| Ticker | Name |
|---|---|
| `JOBY` | Joby Aviation |

##### Marine Shipping (1)

| Ticker | Name |
|---|---|
| `AMKBY` | A.P. Møller - Mærsk A/S |

##### Pollution & Treatment Controls (1)

| Ticker | Name |
|---|---|
| `VLTO` | Veralto |

##### Rental & Leasing Services (1)

| Ticker | Name |
|---|---|
| `URI` | United Rentals |

##### Trucking (1)

| Ticker | Name |
|---|---|
| `ODFL` | Old Dominion Freight Line |

#### Financial Services

*105 symbols across 11 industries.*

##### Capital Markets (20)

| Ticker | Name |
|---|---|
| `CLSK` | CleanSpark |
| `CRCL` | Circle Internet Group |
| `EVR` | Evercore |
| `FUTU` | Futu Holdings Limited |
| `GS` | The Goldman Sachs Group |
| `HOOD` | Robinhood Markets |
| `HUT` | Hut 8 |
| `IBKR` | Interactive Brokers Group |
| `IREN` | IREN Limited |
| `JEF` | Jefferies Financial Group |
| `MARA` | MARA Holdings |
| `MS` | Morgan Stanley |
| `RIOT` | Riot Platforms |
| `SCHW` | The Charles Schwab |
| `SCHW-PD` | The Charles Schwab |
| `TIGR` | UP Fintech Holding Limited |
| `TW` | Tradeweb Markets |
| `VIRT` | Virtu Financial |
| `WULF` | TeraWulf |
| `XP` | XP |

##### Asset Management (18)

| Ticker | Name |
|---|---|
| `AMP` | Ameriprise Financial |
| `APO` | Apollo Global Management |
| `ARES` | Ares Management |
| `BEN` | Franklin Templeton |
| `BLK` | BlackRock |
| `BX` | Blackstone |
| `CG` | The Carlyle Group |
| `HASI` | HA Sustainable Infrastructure Capital |
| `IVZ` | Invesco |
| `KKR` | KKR & Co. |
| `NTRS` | Northern Trust |
| `OTF` | Blue Owl Technology Finance |
| `OWL` | Blue Owl Capital |
| `PFG` | Principal Financial Group |
| `RJF` | Raymond James Financial |
| `STT` | State Street |
| `TGE` | The Generation Essentials Group |
| `TROW` | T. Rowe Price Group |

##### Banks - Regional (16)

| Ticker | Name |
|---|---|
| `CFG` | Citizens Financial Group |
| `COLB` | Columbia Banking System |
| `FITB` | Fifth Third Bancorp |
| `HBAN` | Huntington Bancshares Incorporated |
| `ITUB` | Itaú Unibanco Holding |
| `KEY` | KeyCorp |
| `LYG` | Lloyds Banking Group |
| `MTB` | M&T Bank |
| `NU` | Nu Holdings |
| `PNC` | The PNC Financial Services Group |
| `PNFP` | Pinnacle Financial Partners |
| `RF` | Regions Financial |
| `TFC` | Truist Financial |
| `USB` | U.S. Bancorp |
| `WAL` | Western Alliance Bancorporation |
| `ZION` | Zions Bancorporation, National Association |

##### Insurance - Property & Casualty (11)

| Ticker | Name |
|---|---|
| `AIZ` | Assurant |
| `ALL` | The Allstate |
| `CB` | Chubb Limited |
| `CINF` | Cincinnati Financial |
| `KNSL` | Kinsale Capital Group |
| `L` | Loews |
| `LMND` | Lemonade |
| `PGR` | The Progressive |
| `ROOT` | Root |
| `TRV` | The Travelers Companies |
| `WRB` | W. R. Berkley |

##### Credit Services (9)

| Ticker | Name |
|---|---|
| `AFRM` | Affirm Holdings |
| `ALLY` | Ally Financial |
| `AXP` | American Express |
| `COF` | Capital One Financial |
| `MA` | Mastercard Incorporated |
| `PYPL` | PayPal Holdings |
| `SYF` | Synchrony Financial |
| `UPST` | Upstart Holdings |
| `V` | Visa |

##### Financial Data & Stock Exchanges (9)

| Ticker | Name |
|---|---|
| `CBOE` | Cboe Global Markets |
| `CME` | CME Group |
| `COIN` | Coinbase Global |
| `FDS` | FactSet Research Systems |
| `ICE` | Intercontinental Exchange |
| `MCO` | Moody's |
| `MSCI` | MSCI |
| `NDAQ` | Nasdaq |
| `SPGI` | S&P Global |

##### Banks - Diversified (7)

| Ticker | Name |
|---|---|
| `BAC` | Bank of America |
| `BBVA` | Banco Bilbao Vizcaya Argentaria |
| `BNY` | The Bank of New York Mellon Cor |
| `C` | Citigroup |
| `JPM` | JPMorgan Chase & |
| `SAN` | Banco Santander |
| `WFC` | Wells Fargo & |

##### Insurance Brokers (6)

| Ticker | Name |
|---|---|
| `AJG` | Arthur J. Gallagher & |
| `AON` | Aon |
| `BRO` | Brown & Brown |
| `ERIE` | Erie Indemnity |
| `MRSH` | Marsh & McLennan Companies |
| `WTW` | Willis Towers Watson Public Limited |

##### Insurance - Diversified (4)

| Ticker | Name |
|---|---|
| `ACGL` | Arch Capital Group |
| `AIG` | American International Group |
| `BRK.B` | Berkshire Hathaway |
| `HIG` | The Hartford Insurance Group |

##### Insurance - Life (4)

| Ticker | Name |
|---|---|
| `AFL` | Aflac Incorporated |
| `GL` | Globe Life |
| `MET` | MetLife |
| `PRU` | Prudential Financial |

##### Insurance - Reinsurance (1)

| Ticker | Name |
|---|---|
| `EG` | Everest Group |

#### Consumer Cyclical

*91 symbols across 19 industries.*

##### Restaurants (13)

| Ticker | Name |
|---|---|
| `CAKE` | The Cheesecake Factory Incorporated |
| `CAVA` | CAVA Group |
| `CMG` | Chipotle Mexican Grill |
| `DPZ` | Domino's Pizza |
| `DRI` | Darden Restaurants |
| `LKNCY` | Luckin Coffee |
| `MCD` | McDonald's |
| `REBN` | Reborn Coffee |
| `SBUX` | Starbucks |
| `SG` | Sweetgreen |
| `SHAK` | Shake Shack |
| `WEN` | The Wendy's |
| `YUM` | Yum! Brands |

##### Internet Retail (11)

| Ticker | Name |
|---|---|
| `AMZN` | Amazon.com |
| `BABA` | Alibaba Group Holding Limited |
| `CART` | Maplebear |
| `CPNG` | Coupang |
| `DASH` | DoorDash |
| `EBAY` | eBay |
| `ETSY` | Etsy |
| `JD` | JD.com |
| `MELI` | MercadoLibre |
| `PDD` | PDD Holdings |
| `VIPS` | Vipshop Holdings Limited |

##### Auto Manufacturers (10)

| Ticker | Name |
|---|---|
| `BYDDF` | BYD Company Limited |
| `F` | Ford Motor |
| `GM` | General Motors |
| `LCID` | Lucid Group |
| `LI` | Li Auto |
| `MBGYY` | Mercedes-Benz Group AG |
| `NIO` | NIO |
| `RIVN` | Rivian Automotive |
| `TSLA` | Tesla |
| `XPEV` | XPeng |

##### Auto Parts (8)

| Ticker | Name |
|---|---|
| `ALV` | Autoliv |
| `APTV` | Aptiv |
| `AUR` | Aurora Innovation |
| `AZO` | AutoZone |
| `GPC` | Genuine Parts |
| `MOD` | Modine Manufacturing |
| `ORLY` | O'Reilly Automotive |
| `QS` | QuantumScape |

##### Packaging & Containers (6)

| Ticker | Name |
|---|---|
| `AMCR` | Amcor |
| `AVY` | Avery Dennison |
| `BALL` | Ball |
| `IP` | International Paper |
| `PKG` | Packaging Corporation of America |
| `SW` | Smurfit Westrock Plc |

##### Travel Services (6)

| Ticker | Name |
|---|---|
| `ABNB` | Airbnb |
| `BKNG` | Booking Holdings |
| `CCL` | Carnival Corporation |
| `EXPE` | Expedia Group |
| `NCLH` | Norwegian Cruise Line Holdings |
| `RCL` | Royal Caribbean Cruises |

##### Apparel Retail (5)

| Ticker | Name |
|---|---|
| `BURL` | Burlington Stores |
| `GAP` | The Gap |
| `LULU` | lululemon athletica inc. |
| `ROST` | Ross Stores |
| `TJX` | The TJX Companies |

##### Residential Construction (5)

| Ticker | Name |
|---|---|
| `DHI` | D.R. Horton |
| `LEN` | Lennar |
| `NVR` | NVR |
| `PHM` | PulteGroup |
| `TOL` | Toll Brothers |

##### Specialty Retail (5)

| Ticker | Name |
|---|---|
| `BBY` | Best Buy Co. |
| `CASY` | Casey's General Stores |
| `TSCO` | Tractor Supply |
| `ULTA` | Ulta Beauty |
| `WSM` | Williams-Sonoma |

##### Auto & Truck Dealerships (3)

| Ticker | Name |
|---|---|
| `CVNA` | Carvana |
| `KMX` | CarMax |
| `UCAR` | U Power Limited |

##### Footwear & Accessories (3)

| Ticker | Name |
|---|---|
| `DECK` | Deckers Outdoor |
| `NKE` | NIKE |
| `ONON` | On Holding AG |

##### Furnishings, Fixtures & Appliances (3)

| Ticker | Name |
|---|---|
| `MHK` | Mohawk Industries |
| `SN` | SharkNinja |
| `WHR` | Whirlpool |

##### Home Improvement Retail (3)

| Ticker | Name |
|---|---|
| `HD` | The Home Depot |
| `LOW` | Lowe's Companies |
| `TBHC` | The Brand House Collective |

##### Resorts & Casinos (3)

| Ticker | Name |
|---|---|
| `LVS` | Las Vegas Sands |
| `MGM` | MGM Resorts International |
| `WYNN` | Wynn Resorts, Limited |

##### Leisure (2)

| Ticker | Name |
|---|---|
| `AS` | Amer Sports |
| `HAS` | Hasbro |

##### Lodging (2)

| Ticker | Name |
|---|---|
| `HLT` | Hilton Worldwide Holdings |
| `MAR` | Marriott International |

##### Apparel Manufacturing (1)

| Ticker | Name |
|---|---|
| `RL` | Ralph Lauren |

##### Luxury Goods (1)

| Ticker | Name |
|---|---|
| `TPR` | Tapestry |

##### Personal Services (1)

| Ticker | Name |
|---|---|
| `ROL` | Rollins |

#### Healthcare

*76 symbols across 10 industries.*

##### Biotechnology (14)

| Ticker | Name |
|---|---|
| `ABSI` | Absci |
| `ALNY` | Alnylam Pharmaceuticals |
| `FBIO` | Fortress Biotech |
| `GPCR` | Structure Therapeutics |
| `INCY` | Incyte |
| `MRNA` | Moderna |
| `REGN` | Regeneron Pharmaceuticals |
| `RLAY` | Relay Therapeutics |
| `RXRX` | Recursion Pharmaceuticals |
| `SRNE` | Sorrento Therapeutics |
| `SRRK` | Scholar Rock Holding |
| `TECH` | Bio-Techne |
| `VKTX` | Viking Therapeutics |
| `VRTX` | Vertex Pharmaceuticals Incorporated |

##### Diagnostics & Research (12)

| Ticker | Name |
|---|---|
| `A` | Agilent Technologies |
| `CRL` | Charles River Laboratories International |
| `DGX` | Quest Diagnostics Incorporated |
| `DHR` | Danaher |
| `IDXX` | IDEXX Laboratories |
| `ILMN` | Illumina |
| `IQV` | IQVIA Holdings |
| `LH` | Labcorp Holdings |
| `MTD` | Mettler-Toledo International |
| `RVTY` | Revvity |
| `TMO` | Thermo Fisher Scientific |
| `WAT` | Waters |

##### Medical Devices (11)

| Ticker | Name |
|---|---|
| `ABT` | Abbott Laboratories |
| `BSX` | Boston Scientific |
| `DXCM` | DexCom |
| `EW` | Edwards Lifesciences |
| `GEHC` | GE HealthCare Technologies |
| `MDT` | Medtronic |
| `PODD` | Insulet |
| `QSI` | Quantum-Si incorporated |
| `STE` | STERIS |
| `SYK` | Stryker |
| `ZBH` | Zimmer Biomet Holdings |

##### Drug Manufacturers - General (10)

| Ticker | Name |
|---|---|
| `ABBV` | AbbVie |
| `AMGN` | Amgen |
| `BIIB` | Biogen |
| `BMY` | Bristol-Myers Squibb |
| `GILD` | Gilead Sciences |
| `JNJ` | Johnson & Johnson |
| `LLY` | Eli Lilly and |
| `MRK` | Merck & Co. |
| `OGN` | Organon & |
| `PFE` | Pfizer |

##### Medical Instruments & Supplies (9)

| Ticker | Name |
|---|---|
| `ALGN` | Align Technology |
| `BAX` | Baxter International |
| `BDX` | Becton, Dickinson and |
| `COO` | The Cooper Companies |
| `FEMY` | Femasys |
| `ISRG` | Intuitive Surgical |
| `RMD` | ResMed |
| `SOLV` | Solventum |
| `WST` | West Pharmaceutical Services |

##### Healthcare Plans (6)

| Ticker | Name |
|---|---|
| `CI` | The Cigna Group |
| `CNC` | Centene |
| `CVS` | CVS Health |
| `ELV` | Elevance Health |
| `HUM` | Humana |
| `UNH` | UnitedHealth Group Incorporated |

##### Medical Care Facilities (5)

| Ticker | Name |
|---|---|
| `DVA` | DaVita |
| `FMS` | Fresenius Medical Care AG |
| `HCA` | HCA Healthcare |
| `SRTA` | Strata Critical Medical |
| `UHS` | Universal Health Services |

##### Medical Distribution (4)

| Ticker | Name |
|---|---|
| `CAH` | Cardinal Health |
| `COR` | Cencora |
| `HSIC` | Henry Schein |
| `MCK` | McKesson |

##### Health Information Services (3)

| Ticker | Name |
|---|---|
| `HNGE` | Hinge Health |
| `TDOC` | Teladoc Health |
| `VEEV` | Veeva Systems |

##### Drug Manufacturers - Specialty & Generic (2)

| Ticker | Name |
|---|---|
| `VTRS` | Viatris |
| `ZTS` | Zoetis |

#### Consumer Defensive

*46 symbols across 12 industries.*

##### Packaged Foods (11)

| Ticker | Name |
|---|---|
| `BYND` | Beyond Meat |
| `CAG` | Conagra Brands |
| `DAR` | Darling Ingredients |
| `GIS` | General Mills |
| `HAIN` | The Hain Celestial Group |
| `HRL` | Hormel Foods |
| `KHC` | The Kraft Heinz |
| `LWAY` | Lifeway Foods |
| `MKC` | McCormick & Company, Incorporated |
| `RKDA` | Arcadia Biosciences |
| `SJM` | The J. M. Smucker |

##### Household & Personal Products (7)

| Ticker | Name |
|---|---|
| `CHD` | Church & Dwight Co. |
| `CL` | Colgate-Palmolive |
| `CLX` | The Clorox |
| `EL` | The Estée Lauder Companies |
| `KMB` | Kimberly-Clark |
| `KVUE` | Kenvue |
| `PG` | The Procter & Gamble |

##### Beverages - Non-Alcoholic (5)

| Ticker | Name |
|---|---|
| `CCEP` | Coca-Cola Europacific Partners |
| `KDP` | Keurig Dr Pepper |
| `KO` | The Coca-Cola |
| `MNST` | Monster Beverage |
| `PEP` | PepsiCo |

##### Discount Stores (5)

| Ticker | Name |
|---|---|
| `COST` | Costco Wholesale |
| `DG` | Dollar General |
| `DLTR` | Dollar Tree |
| `TGT` | Target |
| `WMT` | Walmart |

##### Beverages - Brewers (3)

| Ticker | Name |
|---|---|
| `BUD` | Anheuser-Busch InBev SA/NV |
| `STZ` | Constellation Brands |
| `TAP` | Molson Coors Beverage |

##### Farm Products (3)

| Ticker | Name |
|---|---|
| `ADM` | Archer-Daniels-Midland |
| `BG` | Bunge Global SA |
| `TSN` | Tyson Foods |

##### Grocery Stores (3)

| Ticker | Name |
|---|---|
| `KR` | The Kroger |
| `NGVC` | Natural Grocers by Vitamin Cottage |
| `SFM` | Sprouts Farmers Market |

##### Beverages - Wineries & Distilleries (2)

| Ticker | Name |
|---|---|
| `BF.B` | Brown-Forman |
| `MGPI` | MGP Ingredients |

##### Confectioners (2)

| Ticker | Name |
|---|---|
| `HSY` | The Hershey |
| `MDLZ` | Mondelez International |

##### Food Distribution (2)

| Ticker | Name |
|---|---|
| `ANDE` | The Andersons |
| `SYY` | Sysco |

##### Tobacco (2)

| Ticker | Name |
|---|---|
| `MO` | Altria Group |
| `PM` | Philip Morris International |

##### Education & Training Services (1)

| Ticker | Name |
|---|---|
| `YQ` | 17 Education & Technology Group |

#### Basic Materials

*43 symbols across 11 industries.*

##### Specialty Chemicals (9)

| Ticker | Name |
|---|---|
| `ALB` | Albemarle |
| `APD` | Air Products and Chemicals |
| `DD` | DuPont de Nemours |
| `ECL` | Ecolab |
| `IFF` | International Flavors & Fragrances |
| `LIN` | Linde |
| `LYB` | LyondellBasell Industries |
| `PPG` | PPG Industries |
| `SHW` | The Sherwin-Williams |

##### Other Industrial Metals & Mining (8)

| Ticker | Name |
|---|---|
| `BHP` | BHP Group Limited |
| `CRML` | Critical Metals |
| `GLNCY` | Glencore |
| `LAC` | Lithium Americas |
| `MP` | MP Materials |
| `RIO` | Rio Tinto Group |
| `SGML` | Sigma Lithium |
| `VALE` | Vale |

##### Steel (6)

| Ticker | Name |
|---|---|
| `CLF` | Cleveland-Cliffs |
| `MT` | ArcelorMittal |
| `NUE` | Nucor |
| `PKX` | POSCO Holdings |
| `RS` | Reliance |
| `STLD` | Steel Dynamics |

##### Gold (5)

| Ticker | Name |
|---|---|
| `AEM` | Agnico Eagle Mines Limited |
| `AU` | AngloGold Ashanti |
| `B` | Barrick Mining |
| `NEM` | Newmont |
| `PAAS` | Pan American Silver |

##### Copper (4)

| Ticker | Name |
|---|---|
| `ANFGF` | Antofagasta |
| `FCX` | Freeport-McMoRan |
| `SCCO` | Southern Copper |
| `TECK` | Teck Resources Limited |

##### Agricultural Inputs (3)

| Ticker | Name |
|---|---|
| `CF` | CF Industries Holdings |
| `CTVA` | Corteva |
| `MOS` | The Mosaic |

##### Building Materials (3)

| Ticker | Name |
|---|---|
| `CRH` | CRH |
| `MLM` | Martin Marietta Materials |
| `VMC` | Vulcan Materials |

##### Other Precious Metals & Mining (2)

| Ticker | Name |
|---|---|
| `ANGPY` | Valterra Platinum Limited |
| `SBSW` | Sibanye Stillwater Limited |

##### Aluminum (1)

| Ticker | Name |
|---|---|
| `AA` | Alcoa |

##### Chemicals (1)

| Ticker | Name |
|---|---|
| `DOW` | Dow |

##### Silver (1)

| Ticker | Name |
|---|---|
| `AG` | First Majestic Silver |

#### Communication Services

*38 symbols across 6 industries.*

##### Internet Content & Information (12)

| Ticker | Name |
|---|---|
| `BIDU` | Baidu |
| `BILI` | Bilibili |
| `BZFD` | BuzzFeed |
| `FVRR` | Fiverr International |
| `GOOG` | Alphabet |
| `GOOGL` | Alphabet |
| `META` | Meta Platforms |
| `NBIS` | Nebius Group |
| `RDDT` | Reddit |
| `SPOT` | Spotify Technology |
| `TCEHY` | Tencent Holdings Limited |
| `UPWK` | Upwork |

##### Entertainment (11)

| Ticker | Name |
|---|---|
| `DIS` | The Walt Disney |
| `FOX` | Fox |
| `FOXA` | Fox |
| `IQ` | iQIYI |
| `LYV` | Live Nation Entertainment |
| `NFLX` | Netflix |
| `NWS` | News |
| `NWSA` | News |
| `PSKY` | Paramount Skydance |
| `TKO` | TKO Group Holdings |
| `WBD` | Warner Bros. Discovery |

##### Telecom Services (8)

| Ticker | Name |
|---|---|
| `CHTR` | Charter Communications |
| `CMCSA` | Comcast |
| `ECHO` | EchoStar |
| `LUMN` | Lumen Technologies |
| `SFTBY` | SoftBank Group |
| `T` | AT&T |
| `TMUS` | T-Mobile US |
| `VZ` | Verizon Communications |

##### Advertising Agencies (4)

| Ticker | Name |
|---|---|
| `APP` | AppLovin |
| `OMC` | Omnicom Group |
| `TTD` | The Trade Desk |
| `WIMI` | WiMi Hologram Cloud |

##### Electronic Gaming & Multimedia (2)

| Ticker | Name |
|---|---|
| `RBLX` | Roblox |
| `TTWO` | Take-Two Interactive Software |

##### Broadcasting (1)

| Ticker | Name |
|---|---|
| `BBGI` | Beasley Broadcast Group |

#### Energy

*36 symbols across 8 industries.*

##### Oil & Gas E&P (10)

| Ticker | Name |
|---|---|
| `APA` | APA |
| `COP` | ConocoPhillips |
| `DVN` | Devon Energy |
| `EOG` | EOG Resources |
| `EQT` | EQT |
| `EXE` | Expand Energy |
| `FANG` | Diamondback Energy |
| `OXY` | Occidental Petroleum |
| `TPL` | Texas Pacific Land |
| `WTI` | W&T Offshore |

##### Oil & Gas Midstream (9)

| Ticker | Name |
|---|---|
| `ET` | Energy Transfer LP |
| `FLNG` | FLEX LNG |
| `KMI` | Kinder Morgan |
| `OKE` | ONEOK |
| `TNK` | Teekay Tankers |
| `TRGP` | Targa Resources |
| `TRMD` | TORM |
| `VNOM` | Viper Energy |
| `WMB` | The Williams Companies |

##### Oil & Gas Equipment & Services (4)

| Ticker | Name |
|---|---|
| `BKR` | Baker Hughes |
| `HAL` | Halliburton |
| `LB` | LandBridge Company LLC |
| `SLB` | SLB |

##### Oil & Gas Refining & Marketing (4)

| Ticker | Name |
|---|---|
| `CLNE` | Clean Energy Fuels |
| `MPC` | Marathon Petroleum |
| `PSX` | Phillips 66 |
| `VLO` | Valero Energy |

##### Uranium (4)

| Ticker | Name |
|---|---|
| `CCJ` | Cameco |
| `NXE` | NexGen Energy |
| `SRUUF` | Sprott Physical Uranium Trust Fund |
| `UEC` | Uranium Energy |

##### Oil & Gas Integrated (3)

| Ticker | Name |
|---|---|
| `CVX` | Chevron |
| `SHEL` | Shell |
| `XOM` | ExxonMobil Holdings |

##### Oil & Gas Drilling (1)

| Ticker | Name |
|---|---|
| `RIG` | Transocean |

##### Thermal Coal (1)

| Ticker | Name |
|---|---|
| `BTU` | Peabody Energy |

#### Real Estate

*34 symbols across 9 industries.*

##### REIT - Retail (7)

| Ticker | Name |
|---|---|
| `FRT` | Federal Realty Investment Trust |
| `KIM` | Kimco Realty |
| `MAC` | The Macerich |
| `NNN` | NNN REIT |
| `O` | Realty Income |
| `REG` | Regency Centers |
| `SPG` | Simon Property Group |

##### REIT - Specialty (7)

| Ticker | Name |
|---|---|
| `AMT` | American Tower |
| `CCI` | Crown Castle |
| `DLR` | Digital Realty Trust |
| `EQIX` | Equinix |
| `IRM` | Iron Mountain Incorporated |
| `SBAC` | SBA Communications |
| `WY` | Weyerhaeuser |

##### REIT - Residential (6)

| Ticker | Name |
|---|---|
| `CPT` | Camden Property Trust |
| `ESS` | Essex Property Trust |
| `INVH` | Invitation Homes |
| `MAA` | Mid-America Apartment Communities |
| `MRP` | Millrose Properties |
| `UDR` | UDR |

##### REIT - Healthcare Facilities (4)

| Ticker | Name |
|---|---|
| `DOC` | Healthpeak Properties |
| `SBRA` | Sabra Health Care REIT |
| `VTR` | Ventas |
| `WELL` | Welltower |

##### REIT - Industrial (3)

| Ticker | Name |
|---|---|
| `EXR` | Extra Space Storage |
| `PLD` | Prologis |
| `PSA` | Public Storage |

##### REIT - Office (3)

| Ticker | Name |
|---|---|
| `ARE` | Alexandria Real Estate Equities |
| `BXP` | BXP |
| `SLG` | SL Green Realty |

##### Real Estate Services (2)

| Ticker | Name |
|---|---|
| `CBRE` | CBRE Group |
| `CSGP` | CoStar Group |

##### REIT - Diversified (1)

| Ticker | Name |
|---|---|
| `VICI` | VICI Properties |

##### REIT - Hotel & Motel (1)

| Ticker | Name |
|---|---|
| `HST` | Host Hotels & Resorts |

#### Utilities

*32 symbols across 5 industries.*

##### Utilities - Regulated Electric (23)

| Ticker | Name |
|---|---|
| `AEE` | Ameren |
| `AEP` | American Electric Power Company |
| `CMS` | CMS Energy |
| `CNP` | CenterPoint Energy |
| `D` | Dominion Energy |
| `DTE` | DTE Energy |
| `DUK` | Duke Energy |
| `ED` | Consolidated Edison |
| `EIX` | Edison International |
| `ES` | Eversource Energy |
| `ETR` | Entergy |
| `EVRG` | Evergy |
| `EXC` | Exelon |
| `FE` | FirstEnergy |
| `LNT` | Alliant Energy |
| `NEE` | NextEra Energy |
| `PCG` | PG&E |
| `PEG` | Public Service Enterprise Group Incorporated |
| `PNW` | Pinnacle West Capital |
| `PPL` | PPL |
| `SO` | The Southern |
| `WEC` | WEC Energy Group |
| `XEL` | Xcel Energy |

##### Utilities - Independent Power Producers (4)

| Ticker | Name |
|---|---|
| `CEG` | Constellation Energy |
| `NRG` | NRG Energy |
| `OKLO` | Oklo |
| `VST` | Vistra |

##### Utilities - Diversified (2)

| Ticker | Name |
|---|---|
| `AES` | The AES |
| `SRE` | Sempra |

##### Utilities - Regulated Gas (2)

| Ticker | Name |
|---|---|
| `ATO` | Atmos Energy |
| `NI` | NiSource |

##### Utilities - Regulated Water (1)

| Ticker | Name |
|---|---|
| `AWK` | American Water Works Company |

#### Unclassified Equities

Yahoo returns no `sector` for these — delisted, acquired, or non-standard share structures (warrants, grantor trusts). Left unclassified deliberately.

| Ticker | Name |
|---|---|
| `BBBY` | Bed Bath & Beyond |
| `BCHG` | Grayscale Bitcoin Cash Trust |
| `BSOL` | Bitwise Solana Staking ETF |
| `ETCG` | Grayscale Ethereum Classic Trust (ETC) |
| `EVGOW` | EVgo |
| `FISV` | Fiserv |
| `VMRK` | — |

---

### A.2 Exchange-Traded Funds

*173 ETFs.* Yahoo assigns these no GICS sector, so they are grouped by the function they serve. Leveraged and inverse products are separated out: they are trading vehicles with decay characteristics, not sector exposure, and mixing them into sector buckets would distort any industry-weighting calculation.

All of these now carry `universe = 'etf'` in `ticker_universe`. Until 2026-08-18 every one was labeled `'stock'` — `seed-yahoo-portfolio.mjs` hardcodes that label — so a query filtering `universe = 'stock'` for equities was silently picking up `TQQQ`, `SOXL`, `SQQQ` and every other leveraged product here.

#### Index, Sector & Thematic (72)

| Ticker | Name |
|---|---|
| `AGG` | iShares Core U.S. Aggregate Bond ETF |
| `ARKG` | ARK Genomic Revolution ETF |
| `ARKK` | ARK Innovation ETF |
| `BOTZ` | Global X Robotics & Artificial Intelligence ETF |
| `COPX` | Global X Copper Miners ETF |
| `DAX` | Global X DAX Germany ETF |
| `DIA` | State Street SPDR Dow Jones Industrial Average ETF Trust |
| `EEM` | iShares MSCI Emerging Markets ETF |
| `ELM` | Elm Market Navigator ETF |
| `ETH` | Grayscale Ethereum Mini Trust ETF |
| `EWC` | iShares MSCI Canada ETF |
| `EWG` | iShares MSCI Germany ETF |
| `EWJ` | iShares MSCI Japan ETF |
| `EWL` | iShares MSCI Switzerland ETF |
| `EWU` | iShares MSCI United Kingdom ETF |
| `EWW` | iShares MSCI Mexico ETF |
| `FBL` | GraniteShares 2x Long META Daily ETF |
| `FKU` | First Trust United Kingdom AlphaDEX Fund |
| `FLMX` | Franklin FTSE Mexico ETF |
| `FM` | iShares |
| `FXI` | iShares China Large-Cap ETF |
| `GLD` | SPDR Gold Shares |
| `GLDM` | SPDR Gold MiniShares |
| `GRNY` | Fundstrat Granny Shots US Large Cap ETF |
| `HACK` | Amplify Cybersecurity ETF |
| `IEO` | iShares U.S. Oil & Gas Exploration & Production ETF |
| `IEV` | iShares Europe ETF |
| `IGPT` | Invesco AI and Next Gen Software ETF |
| `IHAK` | iShares Cybersecurity and Tech ETF |
| `IVV` | iShares Core S&P 500 ETF |
| `IWM` | iShares Russell 2000 ETF |
| `KRE` | State Street SPDR S&P Regional Banking ETF |
| `KWEB` | KraneShares CSI China Internet ETF |
| `OIH` | VanEck Oil Services ETF |
| `OUSM` | ALPS O'Shares U.S. Small-Cap Quality Dividend ETF Shares |
| `PBW` | Invesco WilderHill Clean Energy ETF |
| `PPLT` | abrdn Physical Platinum Shares ETF |
| `QQQ` | Invesco QQQ Trust |
| `QTUM` | Defiance Quantum ETF |
| `QYLD` | Global X NASDAQ 100 Covered Call ETF |
| `REMX` | VanEck Rare Earth and Strategic Metals ETF |
| `RKLZ` | Defiance Daily Target 2X Short RKLB ETF |
| `ROBO` | Robo Global Robotics and Automation Index ETF |
| `RSP` | Invesco S&P 500 Equal Weight ETF |
| `SEMI` | Columbia Select Technology ETF |
| `SLV` | iShares Silver Trust |
| `SMH` | VanEck Semiconductor ETF |
| `SPAM` | Themes Cybersecurity ETF |
| `TACK` | Fairlead Tactical Sector Fund |
| `TAN` | Invesco Solar ETF |
| `TLT` | iShares 20+ Year Treasury Bond ETF |
| `TUR` | iShares MSCI Turkey ETF |
| `UCYB` | ProShares Ultra Nasdaq Cybersecurity |
| `UNG` | United States Natural Gas Fund, LP |
| `URA` | Global X Uranium ETF |
| `URNM` | Sprott Uranium Miners ETF |
| `VGK` | Vanguard FTSE Europe ETF |
| `VGT` | Vanguard Information Technology Index Fund ETF Shares |
| `VIS` | Vanguard Industrials Index Fund ETF Shares |
| `VOX` | Vanguard Communication Services Index Fund ETF Shares |
| `VTWO` | Vanguard Russell 2000 Index Fund ETF Shares |
| `VTWV` | Vanguard Russell 2000 Value Index Fund ETF Shares |
| `WANT` | Direxion Daily Cnsmr Discret Bull 3XShrs |
| `WCBR` | WisdomTree Cybersecurity Fund |
| `WEAT` | Teucrium Wheat Fund |
| `WISE` | Themes Generative Artificial Intelligence ETF |
| `XLB` | State Street Materials Select Sector SPDR ETF |
| `XLC` | State Street Communication Services Select Sector SPDR ETF |
| `XLE` | State Street Energy Select Sector SPDR ETF |
| `XLI` | State Street Industrial Select Sector SPDR ETF |
| `XLU` | State Street Utilities Select Sector SPDR ETF |
| `XMAG` | Defiance Large Cap ex-Mag 7 ETF |

#### Leveraged & Inverse (87)

| Ticker | Name |
|---|---|
| `AAPU` | Direxion Daily AAPL Bull 2X Shares |
| `AGQ` | ProShares Ultra Silver |
| `AMZU` | Direxion Daily AMZN Bull 2X Shares |
| `BITU` | Proshares Ultra Bitcoin ETF |
| `BITX` | 2x Bitcoin Strategy ETF |
| `BOIL` | ProShares Ultra Bloomberg Natural Gas |
| `CONL` | GraniteShares 2x Long COIN Daily ETF |
| `CONY` | YieldMax COIN Option Income Strategy ETF |
| `DDM` | ProShares Ultra Dow30 |
| `DOG` | ProShares Short Dow30 |
| `DPST` | Direxion Daily Regional Banks Bull 3X Shares |
| `DRIP` | Direxion Daily S&P Oil & Gas Exp. & Prod. Bear 2X Shares |
| `DRV` | Direxion Daily Real Estate Bear 3X Shares |
| `DUST` | Direxion Daily Gold Miners Index Bear 2X Shares |
| `DXD` | ProShares UltraShort Dow30 |
| `EDC` | Direxion Daily MSCI Emerging Markets Bull 3X Shares |
| `EDZ` | Direxion Daily MSCI Emerging Markets Bear 3X Shares |
| `EEV` | ProShares UltraShort MSCI Emerging Markets |
| `ERX` | Direxion Daily Energy Bull 2X Shares |
| `EUM` | ProShares Short MSCI Emerging Markets |
| `FAZ` | Direxion Daily Financial Bear 3X Shares |
| `GGLL` | Direxion Daily GOOGL Bull 2X Shares |
| `GGLS` | Direxion Daily GOOGL Bear 1X Shares |
| `GLL` | ProShares UltraShort Gold |
| `GUSH` | Direxion Daily S&P Oil & Gas Exp. & Prod. Bull 2X Shares |
| `HOOG` | Leverage Shares 2X Long HOOD Daily ETF |
| `HOOX` | Defiance Daily Target 2X Long HOOD ETF |
| `KOLD` | ProShares UltraShort Bloomberg Natural Gas |
| `LABD` | Direxion Daily S&P Biotech Bear 3X Shares |
| `LABU` | Direxion Daily S&P Biotech Bull 3X Shares |
| `MIDZ` | Direxion Daily Mid Cap Bear 3X Shares |
| `MSFU` | Direxion Daily MSFT Bull 2X Shares |
| `MSTU` | T-Rex 2X Long MSTR Daily Target ETF |
| `MUU` | Direxion Daily MU Bull 2X Shares |
| `MYY` | ProShares Short MidCap400 |
| `NVD` | Graniteshares 2x Short NVDA Daily ETF |
| `NVDL` | GraniteShares 2x Long NVDA Daily ETF |
| `NVDX` | T-Rex 2X Long NVIDIA Daily Target ETF |
| `OKLL` | Defiance Daily Target 2X Long OKLO ETF |
| `PSQ` | ProShares Short QQQ |
| `QBTX` | Tradr 2X Long QBTS Daily ETF |
| `QBTZ` | Defiance Daily Target 2X Short QBTS ETF |
| `QID` | ProShares UltraShort QQQ |
| `RGTX` | Defiance Daily Target 2X Long RGTI ETF |
| `RGTZ` | Defiance Daily Target 2X Short RGTI ETF |
| `RWM` | ProShares Short Russell2000 |
| `SBB` | ProShares Short SmallCap600 |
| `SCO` | ProShares UltraShort Bloomberg Crude Oil |
| `SDOW` | ProShares UltraPro Short Dow30 |
| `SDP` | ProShares UltraShort Utilities |
| `SDS` | ProShares UltraShort S&P500 |
| `SH` | ProShares Short S&P500 |
| `SKF` | ProShares UltraShort Financials |
| `SMDD` | ProShares UltraPro Short MidCap400 |
| `SMST` | Defiance Daily Target 2X Short MSTR ETF |
| `SNDU` | T-REX 2X Long SNDK Daily Target ETF |
| `SOLT` | 2x Solana ETF |
| `SOLZ` | Solana ETF |
| `SOUX` | Defiance Daily Target 2X Long SOUN ETF |
| `SOXL` | Direxion Daily Semiconductor Bull 3X Shares |
| `SOXS` | Direxion Daily Semiconductor Bear 3X Shares |
| `SPXL` | Direxion Daily S&P500 Bull 3X Shares |
| `SPXS` | Direxion Daily S&P 500 Bear 3X Shares |
| `SPXU` | ProShares UltraPro Short S&P500 |
| `SQQQ` | ProShares UltraPro Short QQQ |
| `SRTY` | ProShares UltraPro Short Russell2000 |
| `SSG` | ProShares UltraShort Semiconductors |
| `SZK` | ProShares UltraShort Consumer Staples |
| `TECS` | Direxion Daily Technology Bear 3X Shares |
| `TNA` | Direxion Daily Small Cap Bull 3X Shares |
| `TQQQ` | ProShares UltraPro QQQ |
| `TSDD` | Graniteshares 2x Short TSLA Daily ETF |
| `TSLL` | Direxion Daily TSLA Bull 2X Shares |
| `TSLR` | Graniteshares 2x Long TSLA Daily ETF |
| `TSLS` | Direxion Daily TSLA Bear 1X Shares |
| `TSLZ` | T-Rex 2X Inverse Tesla Daily Target ETF |
| `TWM` | ProShares UltraShort Russell2000 |
| `TZA` | Direxion Daily Small Cap Bear 3X Shares |
| `UCO` | ProShares Ultra Bloomberg Crude Oil |
| `UDOW` | ProShares UltraPro Dow30 |
| `UGL` | ProShares Ultra Gold |
| `UPRO` | ProShares UltraPro S&P500 |
| `UVXY` | ProShares Ultra VIX Short-Term Futures ETF |
| `VIXY` | ProShares VIX Short-Term Futures ETF |
| `YANG` | Direxion Daily FTSE China Bear 3X Shares |
| `YINN` | Direxion Daily FTSE China Bull 3X Shares |
| `ZSL` | ProShares UltraShort Silver |

#### Digital-Asset Funds (14)

| Ticker | Name |
|---|---|
| `BITB` | Bitwise Bitcoin ETF |
| `BITC` | Bitwise Trendwise Bitcoin and Treasuries Rotation Strategy ETF |
| `BITO` | ProShares Bitcoin ETF |
| `BITQ` | Bitwise Crypto Industry Innovators ETF |
| `BTC` | Grayscale Bitcoin Mini Trust ETF |
| `BTF` | CoinShares Bitcoin and Ether ETF |
| `ETHA` | iShares Ethereum Trust ETF |
| `ETHE` | Grayscale Ethereum Staking ETF |
| `ETHV` | VanEck Ethereum ETF |
| `ETHW` | Bitwise Ethereum ETF |
| `FETH` | Fidelity Ethereum Fund |
| `GBTC` | Grayscale Bitcoin Trust ETF |
| `GDLC` | Grayscale CoinDesk Crypto 5 ETF |
| `IBIT` | iShares Bitcoin Trust ETF |

---

### A.3 Non-Equity Instruments

#### Cryptocurrencies (4)

| Ticker | Name |
|---|---|
| `BTC-USD` | Bitcoin USD |
| `DOGE-USD` | Dogecoin USD |
| `ETH-USD` | Ethereum USD |
| `SOL-USD` | Solana USD |

#### Mutual Funds (1)

| Ticker | Name |
|---|---|
| `VTSAX` | Vanguard MStar Total Stk Mkt Idx Admiral |

#### Delisted / No Longer Quoted (26)

Yahoo returns no data for these symbols — they have been acquired, taken private, renamed, or delisted since the export was captured (e.g. `TWTR` → X, `PXD` → acquired by ExxonMobil, `WBA` → taken private). They remain in the export because the portfolio was never pruned. **These are the symbols to exclude from any hydration run**: registering them guarantees a permanent per-symbol fetch failure.

| Ticker |
|---|
| `ACLX` |
| `AGRI` |
| `AZULD` |
| `BTQQF` |
| `CEIX` |
| `CFLT` |
| `CMA` |
| `CTRA` |
| `CYBR` |
| `DFS` |
| `FI` |
| `ML` |
| `MRUS` |
| `NOVA` |
| `PXD` |
| `SAGE` |
| `SLNO` |
| `STKL` |
| `TSVT` |
| `TWTR` |
| `VSCO` |
| `VYGVF` |
| `WBA` |
| `WEICHY` |
| `WEICY` |
| `ZK` |

---

### A.4 Alphabetical Index

Every symbol with its classification, for lookup in one pass.

`Origin`: **Y** = Yahoo portfolio export · **I** = pre-existing index seed.

| Ticker | Name | Type | Sector / Group | Origin |
|---|---|---|---|:-:|
| `A` | Agilent Technologies | Equity | Healthcare → Diagnostics & Research | I |
| `AA` | Alcoa | Equity | Basic Materials → Aluminum | Y |
| `AAPL` | Apple | Equity | Technology → Consumer Electronics | Y |
| `AAPU` | Direxion Daily AAPL Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `ABBV` | AbbVie | Equity | Healthcare → Drug Manufacturers - General | Y |
| `ABNB` | Airbnb | Equity | Consumer Cyclical → Travel Services | I |
| `ABSI` | Absci | Equity | Healthcare → Biotechnology | Y |
| `ABT` | Abbott Laboratories | Equity | Healthcare → Medical Devices | I |
| `ACA` | Arcosa | Equity | Industrials → Engineering & Construction | Y |
| `ACGL` | Arch Capital Group | Equity | Financial Services → Insurance - Diversified | I |
| `ACLX` | — | — | Delisted | Y |
| `ACN` | Accenture | Equity | Technology → Information Technology Services | I |
| `ADBE` | Adobe | Equity | Technology → Software - Application | I |
| `ADI` | Analog Devices | Equity | Technology → Semiconductors | Y |
| `ADM` | Archer-Daniels-Midland | Equity | Consumer Defensive → Farm Products | I |
| `ADP` | Automatic Data Processing | Equity | Technology → Software - Application | Y |
| `ADSK` | Autodesk | Equity | Technology → Software - Application | Y |
| `AEE` | Ameren | Equity | Utilities → Utilities - Regulated Electric | I |
| `AEM` | Agnico Eagle Mines Limited | Equity | Basic Materials → Gold | Y |
| `AEP` | American Electric Power Company | Equity | Utilities → Utilities - Regulated Electric | I |
| `AES` | The AES | Equity | Utilities → Utilities - Diversified | I |
| `AFL` | Aflac Incorporated | Equity | Financial Services → Insurance - Life | I |
| `AFRM` | Affirm Holdings | Equity | Financial Services → Credit Services | Y |
| `AG` | First Majestic Silver | Equity | Basic Materials → Silver | Y |
| `AGG` | iShares Core U.S. Aggregate Bond ETF | ETF | Index / Sector / Thematic | Y |
| `AGQ` | ProShares Ultra Silver | ETF | Leveraged & Inverse | Y |
| `AGRI` | — | — | Delisted | Y |
| `AI` | C3.ai | Equity | Technology → Software - Infrastructure | Y |
| `AIG` | American International Group | Equity | Financial Services → Insurance - Diversified | Y |
| `AIZ` | Assurant | Equity | Financial Services → Insurance - Property & Casualty | I |
| `AJG` | Arthur J. Gallagher & | Equity | Financial Services → Insurance Brokers | Y |
| `AKAM` | Akamai Technologies | Equity | Technology → Software - Infrastructure | I |
| `ALAB` | Astera Labs | Equity | Technology → Semiconductors | Y |
| `ALB` | Albemarle | Equity | Basic Materials → Specialty Chemicals | I |
| `ALGN` | Align Technology | Equity | Healthcare → Medical Instruments & Supplies | Y |
| `ALGT` | Allegiant Travel | Equity | Industrials → Airlines | Y |
| `ALK` | Alaska Air Group | Equity | Industrials → Airlines | Y |
| `ALL` | The Allstate | Equity | Financial Services → Insurance - Property & Casualty | I |
| `ALLE` | Allegion | Equity | Industrials → Security & Protection Services | I |
| `ALLY` | Ally Financial | Equity | Financial Services → Credit Services | Y |
| `ALNY` | Alnylam Pharmaceuticals | Equity | Healthcare → Biotechnology | I |
| `ALV` | Autoliv | Equity | Consumer Cyclical → Auto Parts | Y |
| `AMAT` | Applied Materials | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `AMBA` | Ambarella | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `AMCR` | Amcor | Equity | Consumer Cyclical → Packaging & Containers | I |
| `AMD` | Advanced Micro Devices | Equity | Technology → Semiconductors | Y |
| `AME` | AMETEK | Equity | Industrials → Specialty Industrial Machinery | I |
| `AMGN` | Amgen | Equity | Healthcare → Drug Manufacturers - General | Y |
| `AMKBY` | A.P. Møller - Mærsk A/S | Equity | Industrials → Marine Shipping | Y |
| `AMKR` | Amkor Technology | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `AMP` | Ameriprise Financial | Equity | Financial Services → Asset Management | I |
| `AMPG` | AmpliTech Group | Equity | Technology → Communication Equipment | Y |
| `AMT` | American Tower | Equity | Real Estate → REIT - Specialty | Y |
| `AMZN` | Amazon.com | Equity | Consumer Cyclical → Internet Retail | I |
| `AMZU` | Direxion Daily AMZN Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `ANDE` | The Andersons | Equity | Consumer Defensive → Food Distribution | Y |
| `ANET` | Arista Networks | Equity | Technology → Computer Hardware | Y |
| `ANFGF` | Antofagasta | Equity | Basic Materials → Copper | Y |
| `ANGPY` | Valterra Platinum Limited | Equity | Basic Materials → Other Precious Metals & Mining | Y |
| `AON` | Aon | Equity | Financial Services → Insurance Brokers | I |
| `AOS` | A. O. Smith | Equity | Industrials → Specialty Industrial Machinery | Y |
| `APA` | APA | Equity | Energy → Oil & Gas E&P | I |
| `APD` | Air Products and Chemicals | Equity | Basic Materials → Specialty Chemicals | I |
| `APH` | Amphenol | Equity | Technology → Electronic Components | Y |
| `APLD` | Applied Digital | Equity | Technology → Information Technology Services | Y |
| `APO` | Apollo Global Management | Equity | Financial Services → Asset Management | Y |
| `APP` | AppLovin | Equity | Communication Services → Advertising Agencies | Y |
| `APTV` | Aptiv | Equity | Consumer Cyclical → Auto Parts | I |
| `ARE` | Alexandria Real Estate Equities | Equity | Real Estate → REIT - Office | I |
| `ARES` | Ares Management | Equity | Financial Services → Asset Management | I |
| `ARKG` | ARK Genomic Revolution ETF | ETF | Index / Sector / Thematic | Y |
| `ARKK` | ARK Innovation ETF | ETF | Index / Sector / Thematic | Y |
| `ARM` | Arm Holdings | Equity | Technology → Semiconductors | Y |
| `ARQQ` | Arqit Quantum | Equity | Technology → Software - Infrastructure | Y |
| `AS` | Amer Sports | Equity | Consumer Cyclical → Leisure | Y |
| `ASML` | ASML Holding | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `ASX` | ASE Technology Holding Co. | Equity | Technology → Semiconductors | Y |
| `ATO` | Atmos Energy | Equity | Utilities → Utilities - Regulated Gas | I |
| `ATOM` | Atomera Incorporated | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `ATRO` | Astronics | Equity | Industrials → Aerospace & Defense | Y |
| `AU` | AngloGold Ashanti | Equity | Basic Materials → Gold | Y |
| `AUR` | Aurora Innovation | Equity | Consumer Cyclical → Auto Parts | Y |
| `AVGO` | Broadcom | Equity | Technology → Semiconductors | Y |
| `AVPT` | AvePoint | Equity | Technology → Software - Infrastructure | Y |
| `AVY` | Avery Dennison | Equity | Consumer Cyclical → Packaging & Containers | I |
| `AWK` | American Water Works Company | Equity | Utilities → Utilities - Regulated Water | I |
| `AXON` | Axon Enterprise | Equity | Industrials → Aerospace & Defense | I |
| `AXP` | American Express | Equity | Financial Services → Credit Services | Y |
| `AZO` | AutoZone | Equity | Consumer Cyclical → Auto Parts | I |
| `AZULD` | — | — | Delisted | Y |
| `B` | Barrick Mining | Equity | Basic Materials → Gold | Y |
| `BA` | The Boeing | Equity | Industrials → Aerospace & Defense | Y |
| `BABA` | Alibaba Group Holding Limited | Equity | Consumer Cyclical → Internet Retail | Y |
| `BAC` | Bank of America | Equity | Financial Services → Banks - Diversified | Y |
| `BALL` | Ball | Equity | Consumer Cyclical → Packaging & Containers | I |
| `BAX` | Baxter International | Equity | Healthcare → Medical Instruments & Supplies | I |
| `BBAI` | BigBear.ai Holdings | Equity | Technology → Information Technology Services | Y |
| `BBBY` | Bed Bath & Beyond | Equity | Unclassified | Y |
| `BBGI` | Beasley Broadcast Group | Equity | Communication Services → Broadcasting | Y |
| `BBVA` | Banco Bilbao Vizcaya Argentaria | Equity | Financial Services → Banks - Diversified | Y |
| `BBY` | Best Buy Co. | Equity | Consumer Cyclical → Specialty Retail | I |
| `BCHG` | Grayscale Bitcoin Cash Trust | Equity | Unclassified | Y |
| `BDX` | Becton, Dickinson and | Equity | Healthcare → Medical Instruments & Supplies | I |
| `BEN` | Franklin Templeton | Equity | Financial Services → Asset Management | Y |
| `BF.B` | Brown-Forman | Equity | Consumer Defensive → Beverages - Wineries & Distilleries | I |
| `BG` | Bunge Global SA | Equity | Consumer Defensive → Farm Products | I |
| `BHP` | BHP Group Limited | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `BIDU` | Baidu | Equity | Communication Services → Internet Content & Information | Y |
| `BIIB` | Biogen | Equity | Healthcare → Drug Manufacturers - General | Y |
| `BILI` | Bilibili | Equity | Communication Services → Internet Content & Information | Y |
| `BITB` | Bitwise Bitcoin ETF | ETF | Digital-Asset Fund | Y |
| `BITC` | Bitwise Trendwise Bitcoin and Treasuries Rotation Strategy ETF | ETF | Digital-Asset Fund | Y |
| `BITO` | ProShares Bitcoin ETF | ETF | Digital-Asset Fund | Y |
| `BITQ` | Bitwise Crypto Industry Innovators ETF | ETF | Digital-Asset Fund | Y |
| `BITU` | Proshares Ultra Bitcoin ETF | ETF | Leveraged & Inverse | Y |
| `BITX` | 2x Bitcoin Strategy ETF | ETF | Leveraged & Inverse | Y |
| `BKNG` | Booking Holdings | Equity | Consumer Cyclical → Travel Services | Y |
| `BKR` | Baker Hughes | Equity | Energy → Oil & Gas Equipment & Services | Y |
| `BLDP` | Ballard Power Systems | Equity | Industrials → Electrical Equipment & Parts | Y |
| `BLDR` | Builders FirstSource | Equity | Industrials → Building Products & Equipment | I |
| `BLK` | BlackRock | Equity | Financial Services → Asset Management | Y |
| `BMY` | Bristol-Myers Squibb | Equity | Healthcare → Drug Manufacturers - General | Y |
| `BNY` | The Bank of New York Mellon Cor | Equity | Financial Services → Banks - Diversified | Y |
| `BOIL` | ProShares Ultra Bloomberg Natural Gas | ETF | Leveraged & Inverse | Y |
| `BOTZ` | Global X Robotics & Artificial Intelligence ETF | ETF | Index / Sector / Thematic | Y |
| `BR` | Broadridge Financial Solutions | Equity | Technology → Information Technology Services | I |
| `BRK.B` | Berkshire Hathaway | Equity | Financial Services → Insurance - Diversified | I |
| `BRO` | Brown & Brown | Equity | Financial Services → Insurance Brokers | I |
| `BSOL` | Bitwise Solana Staking ETF | Equity | Unclassified | Y |
| `BSX` | Boston Scientific | Equity | Healthcare → Medical Devices | Y |
| `BSY` | Bentley Systems, Incorporated | Equity | Technology → Software - Application | Y |
| `BTC` | Grayscale Bitcoin Mini Trust ETF | ETF | Digital-Asset Fund | Y |
| `BTC-USD` | Bitcoin USD | Crypto | Cryptocurrency | Y |
| `BTCT` | BTC Digital | Equity | Technology → Computer Hardware | Y |
| `BTF` | CoinShares Bitcoin and Ether ETF | ETF | Digital-Asset Fund | Y |
| `BTQQF` | — | — | Delisted | Y |
| `BTU` | Peabody Energy | Equity | Energy → Thermal Coal | Y |
| `BUD` | Anheuser-Busch InBev SA/NV | Equity | Consumer Defensive → Beverages - Brewers | Y |
| `BURL` | Burlington Stores | Equity | Consumer Cyclical → Apparel Retail | Y |
| `BX` | Blackstone | Equity | Financial Services → Asset Management | Y |
| `BXP` | BXP | Equity | Real Estate → REIT - Office | Y |
| `BYDDF` | BYD Company Limited | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `BYND` | Beyond Meat | Equity | Consumer Defensive → Packaged Foods | Y |
| `BZFD` | BuzzFeed | Equity | Communication Services → Internet Content & Information | Y |
| `C` | Citigroup | Equity | Financial Services → Banks - Diversified | Y |
| `CAG` | Conagra Brands | Equity | Consumer Defensive → Packaged Foods | Y |
| `CAH` | Cardinal Health | Equity | Healthcare → Medical Distribution | I |
| `CAKE` | The Cheesecake Factory Incorporated | Equity | Consumer Cyclical → Restaurants | Y |
| `CARR` | Carrier Global | Equity | Industrials → Building Products & Equipment | I |
| `CART` | Maplebear | Equity | Consumer Cyclical → Internet Retail | Y |
| `CASY` | Casey's General Stores | Equity | Consumer Cyclical → Specialty Retail | I |
| `CAT` | Caterpillar | Equity | Industrials → Farm & Heavy Construction Machinery | Y |
| `CAVA` | CAVA Group | Equity | Consumer Cyclical → Restaurants | Y |
| `CB` | Chubb Limited | Equity | Financial Services → Insurance - Property & Casualty | Y |
| `CBOE` | Cboe Global Markets | Equity | Financial Services → Financial Data & Stock Exchanges | I |
| `CBRE` | CBRE Group | Equity | Real Estate → Real Estate Services | Y |
| `CCEP` | Coca-Cola Europacific Partners | Equity | Consumer Defensive → Beverages - Non-Alcoholic | I |
| `CCI` | Crown Castle | Equity | Real Estate → REIT - Specialty | I |
| `CCJ` | Cameco | Equity | Energy → Uranium | Y |
| `CCL` | Carnival Corporation | Equity | Consumer Cyclical → Travel Services | Y |
| `CDNL` | Cardinal Infrastructure Group | Equity | Industrials → Engineering & Construction | Y |
| `CDNS` | Cadence Design Systems | Equity | Technology → Software - Application | Y |
| `CDW` | CDW | Equity | Technology → Information Technology Services | Y |
| `CEG` | Constellation Energy | Equity | Utilities → Utilities - Independent Power Producers | Y |
| `CEIX` | — | — | Delisted | Y |
| `CF` | CF Industries Holdings | Equity | Basic Materials → Agricultural Inputs | I |
| `CFG` | Citizens Financial Group | Equity | Financial Services → Banks - Regional | Y |
| `CFLT` | — | — | Delisted | Y |
| `CG` | The Carlyle Group | Equity | Financial Services → Asset Management | Y |
| `CHD` | Church & Dwight Co. | Equity | Consumer Defensive → Household & Personal Products | I |
| `CHKP` | Check Point Software Technologies | Equity | Technology → Software - Infrastructure | Y |
| `CHRW` | C.H. Robinson Worldwide | Equity | Industrials → Integrated Freight & Logistics | I |
| `CHTR` | Charter Communications | Equity | Communication Services → Telecom Services | Y |
| `CI` | The Cigna Group | Equity | Healthcare → Healthcare Plans | I |
| `CIEN` | Ciena | Equity | Technology → Communication Equipment | Y |
| `CIFR` | Cipher Digital | Equity | Technology → Information Technology Services | Y |
| `CINF` | Cincinnati Financial | Equity | Financial Services → Insurance - Property & Casualty | I |
| `CL` | Colgate-Palmolive | Equity | Consumer Defensive → Household & Personal Products | I |
| `CLBT` | Cellebrite DI | Equity | Technology → Software - Infrastructure | Y |
| `CLF` | Cleveland-Cliffs | Equity | Basic Materials → Steel | Y |
| `CLNE` | Clean Energy Fuels | Equity | Energy → Oil & Gas Refining & Marketing | Y |
| `CLSK` | CleanSpark | Equity | Financial Services → Capital Markets | Y |
| `CLX` | The Clorox | Equity | Consumer Defensive → Household & Personal Products | I |
| `CMA` | — | — | Delisted | Y |
| `CMCSA` | Comcast | Equity | Communication Services → Telecom Services | I |
| `CME` | CME Group | Equity | Financial Services → Financial Data & Stock Exchanges | I |
| `CMG` | Chipotle Mexican Grill | Equity | Consumer Cyclical → Restaurants | Y |
| `CMI` | Cummins | Equity | Industrials → Specialty Industrial Machinery | Y |
| `CMS` | CMS Energy | Equity | Utilities → Utilities - Regulated Electric | I |
| `CNC` | Centene | Equity | Healthcare → Healthcare Plans | I |
| `CNP` | CenterPoint Energy | Equity | Utilities → Utilities - Regulated Electric | I |
| `COF` | Capital One Financial | Equity | Financial Services → Credit Services | Y |
| `COHR` | Coherent | Equity | Technology → Scientific & Technical Instruments | Y |
| `COIN` | Coinbase Global | Equity | Financial Services → Financial Data & Stock Exchanges | Y |
| `COLB` | Columbia Banking System | Equity | Financial Services → Banks - Regional | Y |
| `CONL` | GraniteShares 2x Long COIN Daily ETF | ETF | Leveraged & Inverse | Y |
| `CONY` | YieldMax COIN Option Income Strategy ETF | ETF | Leveraged & Inverse | Y |
| `COO` | The Cooper Companies | Equity | Healthcare → Medical Instruments & Supplies | I |
| `COP` | ConocoPhillips | Equity | Energy → Oil & Gas E&P | I |
| `COPX` | Global X Copper Miners ETF | ETF | Index / Sector / Thematic | Y |
| `COR` | Cencora | Equity | Healthcare → Medical Distribution | I |
| `CORZ` | Core Scientific | Equity | Technology → Software - Infrastructure | Y |
| `COST` | Costco Wholesale | Equity | Consumer Defensive → Discount Stores | Y |
| `CPA` | Copa Holdings | Equity | Industrials → Airlines | Y |
| `CPAY` | Corpay | Equity | Technology → Software - Infrastructure | I |
| `CPNG` | Coupang | Equity | Consumer Cyclical → Internet Retail | Y |
| `CPRT` | Copart | Equity | Industrials → Specialty Business Services | I |
| `CPT` | Camden Property Trust | Equity | Real Estate → REIT - Residential | I |
| `CRCL` | Circle Internet Group | Equity | Financial Services → Capital Markets | Y |
| `CRDO` | Credo Technology Group Holding | Equity | Technology → Semiconductors | Y |
| `CRESY` | Cresud Sociedad Anónima, Comercial, Inmobiliaria, Financiera y Agropecuaria | Equity | Industrials → Conglomerates | Y |
| `CRH` | CRH | Equity | Basic Materials → Building Materials | Y |
| `CRL` | Charles River Laboratories International | Equity | Healthcare → Diagnostics & Research | I |
| `CRM` | Salesforce | Equity | Technology → Software - Application | Y |
| `CRML` | Critical Metals | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `CRWD` | CrowdStrike Holdings | Equity | Technology → Software - Infrastructure | Y |
| `CRWV` | CoreWeave | Equity | Technology → Software - Infrastructure | Y |
| `CSCO` | Cisco Systems | Equity | Technology → Communication Equipment | Y |
| `CSGP` | CoStar Group | Equity | Real Estate → Real Estate Services | I |
| `CSX` | CSX | Equity | Industrials → Railroads | I |
| `CTAS` | Cintas | Equity | Industrials → Specialty Business Services | Y |
| `CTRA` | — | — | Delisted | Y |
| `CTSH` | Cognizant Technology Solutions | Equity | Technology → Information Technology Services | I |
| `CTVA` | Corteva | Equity | Basic Materials → Agricultural Inputs | I |
| `CVNA` | Carvana | Equity | Consumer Cyclical → Auto & Truck Dealerships | Y |
| `CVS` | CVS Health | Equity | Healthcare → Healthcare Plans | I |
| `CVX` | Chevron | Equity | Energy → Oil & Gas Integrated | I |
| `CXAI` | CXApp | Equity | Technology → Software - Application | Y |
| `CYBR` | — | — | Delisted | Y |
| `D` | Dominion Energy | Equity | Utilities → Utilities - Regulated Electric | Y |
| `DAL` | Delta Air Lines | Equity | Industrials → Airlines | I |
| `DAR` | Darling Ingredients | Equity | Consumer Defensive → Packaged Foods | Y |
| `DASH` | DoorDash | Equity | Consumer Cyclical → Internet Retail | Y |
| `DAX` | Global X DAX Germany ETF | ETF | Index / Sector / Thematic | Y |
| `DD` | DuPont de Nemours | Equity | Basic Materials → Specialty Chemicals | I |
| `DDM` | ProShares Ultra Dow30 | ETF | Leveraged & Inverse | Y |
| `DDOG` | Datadog | Equity | Technology → Software - Application | Y |
| `DE` | Deere & | Equity | Industrials → Farm & Heavy Construction Machinery | I |
| `DECK` | Deckers Outdoor | Equity | Consumer Cyclical → Footwear & Accessories | Y |
| `DELL` | Dell Technologies | Equity | Technology → Computer Hardware | Y |
| `DFS` | — | — | Delisted | Y |
| `DG` | Dollar General | Equity | Consumer Defensive → Discount Stores | I |
| `DGX` | Quest Diagnostics Incorporated | Equity | Healthcare → Diagnostics & Research | I |
| `DHI` | D.R. Horton | Equity | Consumer Cyclical → Residential Construction | I |
| `DHR` | Danaher | Equity | Healthcare → Diagnostics & Research | I |
| `DIA` | State Street SPDR Dow Jones Industrial Average ETF Trust | ETF | Index / Sector / Thematic | Y |
| `DIS` | The Walt Disney | Equity | Communication Services → Entertainment | I |
| `DLR` | Digital Realty Trust | Equity | Real Estate → REIT - Specialty | Y |
| `DLTR` | Dollar Tree | Equity | Consumer Defensive → Discount Stores | I |
| `DOC` | Healthpeak Properties | Equity | Real Estate → REIT - Healthcare Facilities | I |
| `DOCN` | DigitalOcean Holdings | Equity | Technology → Software - Infrastructure | Y |
| `DOG` | ProShares Short Dow30 | ETF | Leveraged & Inverse | Y |
| `DOGE-USD` | Dogecoin USD | Crypto | Cryptocurrency | Y |
| `DOV` | Dover | Equity | Industrials → Specialty Industrial Machinery | I |
| `DOW` | Dow | Equity | Basic Materials → Chemicals | I |
| `DPST` | Direxion Daily Regional Banks Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `DPZ` | Domino's Pizza | Equity | Consumer Cyclical → Restaurants | I |
| `DRI` | Darden Restaurants | Equity | Consumer Cyclical → Restaurants | I |
| `DRIP` | Direxion Daily S&P Oil & Gas Exp. & Prod. Bear 2X Shares | ETF | Leveraged & Inverse | Y |
| `DRV` | Direxion Daily Real Estate Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `DTE` | DTE Energy | Equity | Utilities → Utilities - Regulated Electric | I |
| `DUK` | Duke Energy | Equity | Utilities → Utilities - Regulated Electric | I |
| `DUST` | Direxion Daily Gold Miners Index Bear 2X Shares | ETF | Leveraged & Inverse | Y |
| `DVA` | DaVita | Equity | Healthcare → Medical Care Facilities | I |
| `DVN` | Devon Energy | Equity | Energy → Oil & Gas E&P | I |
| `DXCM` | DexCom | Equity | Healthcare → Medical Devices | I |
| `DXD` | ProShares UltraShort Dow30 | ETF | Leveraged & Inverse | Y |
| `EADSY` | Airbus SE | Equity | Industrials → Aerospace & Defense | Y |
| `EBAY` | eBay | Equity | Consumer Cyclical → Internet Retail | I |
| `ECHO` | EchoStar | Equity | Communication Services → Telecom Services | I |
| `ECL` | Ecolab | Equity | Basic Materials → Specialty Chemicals | I |
| `ED` | Consolidated Edison | Equity | Utilities → Utilities - Regulated Electric | I |
| `EDC` | Direxion Daily MSCI Emerging Markets Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `EDZ` | Direxion Daily MSCI Emerging Markets Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `EEM` | iShares MSCI Emerging Markets ETF | ETF | Index / Sector / Thematic | Y |
| `EEV` | ProShares UltraShort MSCI Emerging Markets | ETF | Leveraged & Inverse | Y |
| `EFX` | Equifax | Equity | Industrials → Consulting Services | Y |
| `EG` | Everest Group | Equity | Financial Services → Insurance - Reinsurance | I |
| `EIX` | Edison International | Equity | Utilities → Utilities - Regulated Electric | Y |
| `EL` | The Estée Lauder Companies | Equity | Consumer Defensive → Household & Personal Products | Y |
| `ELM` | Elm Market Navigator ETF | ETF | Index / Sector / Thematic | Y |
| `ELV` | Elevance Health | Equity | Healthcare → Healthcare Plans | I |
| `EME` | EMCOR Group | Equity | Industrials → Engineering & Construction | Y |
| `EMR` | Emerson Electric | Equity | Industrials → Specialty Industrial Machinery | I |
| `EOG` | EOG Resources | Equity | Energy → Oil & Gas E&P | I |
| `EOSE` | Eos Energy Enterprises | Equity | Industrials → Electrical Equipment & Parts | Y |
| `EQIX` | Equinix | Equity | Real Estate → REIT - Specialty | Y |
| `EQT` | EQT | Equity | Energy → Oil & Gas E&P | Y |
| `ERIE` | Erie Indemnity | Equity | Financial Services → Insurance Brokers | I |
| `ERX` | Direxion Daily Energy Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `ES` | Eversource Energy | Equity | Utilities → Utilities - Regulated Electric | Y |
| `ESS` | Essex Property Trust | Equity | Real Estate → REIT - Residential | I |
| `ESTC` | Elastic | Equity | Technology → Software - Application | Y |
| `ET` | Energy Transfer LP | Equity | Energy → Oil & Gas Midstream | Y |
| `ETCG` | Grayscale Ethereum Classic Trust (ETC) | Equity | Unclassified | Y |
| `ETH` | Grayscale Ethereum Mini Trust ETF | ETF | Index / Sector / Thematic | Y |
| `ETH-USD` | Ethereum USD | Crypto | Cryptocurrency | Y |
| `ETHA` | iShares Ethereum Trust ETF | ETF | Digital-Asset Fund | Y |
| `ETHE` | Grayscale Ethereum Staking ETF | ETF | Digital-Asset Fund | Y |
| `ETHV` | VanEck Ethereum ETF | ETF | Digital-Asset Fund | Y |
| `ETHW` | Bitwise Ethereum ETF | ETF | Digital-Asset Fund | Y |
| `ETN` | Eaton Corporation | Equity | Industrials → Specialty Industrial Machinery | Y |
| `ETR` | Entergy | Equity | Utilities → Utilities - Regulated Electric | I |
| `ETSY` | Etsy | Equity | Consumer Cyclical → Internet Retail | Y |
| `EUM` | ProShares Short MSCI Emerging Markets | ETF | Leveraged & Inverse | Y |
| `EVGOW` | EVgo | Equity | Unclassified | Y |
| `EVR` | Evercore | Equity | Financial Services → Capital Markets | Y |
| `EVRG` | Evergy | Equity | Utilities → Utilities - Regulated Electric | I |
| `EW` | Edwards Lifesciences | Equity | Healthcare → Medical Devices | Y |
| `EWC` | iShares MSCI Canada ETF | ETF | Index / Sector / Thematic | Y |
| `EWG` | iShares MSCI Germany ETF | ETF | Index / Sector / Thematic | Y |
| `EWJ` | iShares MSCI Japan ETF | ETF | Index / Sector / Thematic | Y |
| `EWL` | iShares MSCI Switzerland ETF | ETF | Index / Sector / Thematic | Y |
| `EWU` | iShares MSCI United Kingdom ETF | ETF | Index / Sector / Thematic | Y |
| `EWW` | iShares MSCI Mexico ETF | ETF | Index / Sector / Thematic | Y |
| `EXC` | Exelon | Equity | Utilities → Utilities - Regulated Electric | I |
| `EXE` | Expand Energy | Equity | Energy → Oil & Gas E&P | I |
| `EXPD` | Expeditors International of Washington | Equity | Industrials → Integrated Freight & Logistics | I |
| `EXPE` | Expedia Group | Equity | Consumer Cyclical → Travel Services | Y |
| `EXR` | Extra Space Storage | Equity | Real Estate → REIT - Industrial | I |
| `F` | Ford Motor | Equity | Consumer Cyclical → Auto Manufacturers | I |
| `FANG` | Diamondback Energy | Equity | Energy → Oil & Gas E&P | I |
| `FAST` | Fastenal | Equity | Industrials → Industrial Distribution | Y |
| `FAZ` | Direxion Daily Financial Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `FBIO` | Fortress Biotech | Equity | Healthcare → Biotechnology | Y |
| `FBL` | GraniteShares 2x Long META Daily ETF | ETF | Index / Sector / Thematic | Y |
| `FCX` | Freeport-McMoRan | Equity | Basic Materials → Copper | Y |
| `FDS` | FactSet Research Systems | Equity | Financial Services → Financial Data & Stock Exchanges | I |
| `FDX` | FedEx | Equity | Industrials → Integrated Freight & Logistics | I |
| `FDXF` | FedEx Freight Holding Company | Equity | Industrials → Integrated Freight & Logistics | I |
| `FE` | FirstEnergy | Equity | Utilities → Utilities - Regulated Electric | I |
| `FEMY` | Femasys | Equity | Healthcare → Medical Instruments & Supplies | Y |
| `FER` | Ferrovial | Equity | Industrials → Engineering & Construction | I |
| `FERG` | Ferguson Enterprises | Equity | Industrials → Industrial Distribution | I |
| `FETH` | Fidelity Ethereum Fund | ETF | Digital-Asset Fund | Y |
| `FFIV` | F5 | Equity | Technology → Software - Infrastructure | I |
| `FI` | — | — | Delisted | Y |
| `FICO` | Fair Isaac | Equity | Technology → Software - Application | I |
| `FIS` | Fidelity National Information Services | Equity | Technology → Information Technology Services | I |
| `FISV` | Fiserv | Equity | Unclassified | Y |
| `FITB` | Fifth Third Bancorp | Equity | Financial Services → Banks - Regional | I |
| `FIX` | Comfort Systems USA | Equity | Industrials → Engineering & Construction | I |
| `FKU` | First Trust United Kingdom AlphaDEX Fund | ETF | Index / Sector / Thematic | Y |
| `FLEX` | Flex | Equity | Technology → Electronic Components | I |
| `FLMX` | Franklin FTSE Mexico ETF | ETF | Index / Sector / Thematic | Y |
| `FLNG` | FLEX LNG | Equity | Energy → Oil & Gas Midstream | Y |
| `FM` | iShares | ETF | Index / Sector / Thematic | Y |
| `FMS` | Fresenius Medical Care AG | Equity | Healthcare → Medical Care Facilities | Y |
| `FORM` | FormFactor | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `FOX` | Fox | Equity | Communication Services → Entertainment | I |
| `FOXA` | Fox | Equity | Communication Services → Entertainment | I |
| `FRT` | Federal Realty Investment Trust | Equity | Real Estate → REIT - Retail | I |
| `FSLR` | First Solar | Equity | Technology → Solar | Y |
| `FSLY` | Fastly | Equity | Technology → Software - Application | Y |
| `FTAI` | FTAI Aviation | Equity | Industrials → Aerospace & Defense | Y |
| `FTNT` | Fortinet | Equity | Technology → Software - Infrastructure | Y |
| `FTV` | Fortive | Equity | Technology → Scientific & Technical Instruments | Y |
| `FUTU` | Futu Holdings Limited | Equity | Financial Services → Capital Markets | Y |
| `FVRR` | Fiverr International | Equity | Communication Services → Internet Content & Information | Y |
| `FXI` | iShares China Large-Cap ETF | ETF | Index / Sector / Thematic | Y |
| `GAP` | The Gap | Equity | Consumer Cyclical → Apparel Retail | Y |
| `GBTC` | Grayscale Bitcoin Trust ETF | ETF | Digital-Asset Fund | Y |
| `GD` | General Dynamics | Equity | Industrials → Aerospace & Defense | I |
| `GDDY` | GoDaddy | Equity | Technology → Software - Infrastructure | I |
| `GDLC` | Grayscale CoinDesk Crypto 5 ETF | ETF | Digital-Asset Fund | Y |
| `GE` | GE Aerospace | Equity | Industrials → Aerospace & Defense | I |
| `GEHC` | GE HealthCare Technologies | Equity | Healthcare → Medical Devices | Y |
| `GEN` | Gen Digital | Equity | Technology → Software - Infrastructure | I |
| `GEV` | GE Vernova | Equity | Industrials → Specialty Industrial Machinery | Y |
| `GFAI` | Guardforce AI Co., Limited | Equity | Industrials → Security & Protection Services | Y |
| `GFF` | Griffon | Equity | Industrials → Building Products & Equipment | Y |
| `GGLL` | Direxion Daily GOOGL Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `GGLS` | Direxion Daily GOOGL Bear 1X Shares | ETF | Leveraged & Inverse | Y |
| `GILD` | Gilead Sciences | Equity | Healthcare → Drug Manufacturers - General | Y |
| `GIS` | General Mills | Equity | Consumer Defensive → Packaged Foods | Y |
| `GL` | Globe Life | Equity | Financial Services → Insurance - Life | Y |
| `GLD` | SPDR Gold Shares | ETF | Index / Sector / Thematic | Y |
| `GLDM` | SPDR Gold MiniShares | ETF | Index / Sector / Thematic | Y |
| `GLL` | ProShares UltraShort Gold | ETF | Leveraged & Inverse | Y |
| `GLNCY` | Glencore | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `GLW` | Corning Incorporated | Equity | Technology → Electronic Components | Y |
| `GM` | General Motors | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `GNRC` | Generac Holdings | Equity | Industrials → Specialty Industrial Machinery | Y |
| `GOOG` | Alphabet | Equity | Communication Services → Internet Content & Information | I |
| `GOOGL` | Alphabet | Equity | Communication Services → Internet Content & Information | I |
| `GPC` | Genuine Parts | Equity | Consumer Cyclical → Auto Parts | I |
| `GPCR` | Structure Therapeutics | Equity | Healthcare → Biotechnology | Y |
| `GPN` | Global Payments | Equity | Industrials → Specialty Business Services | I |
| `GRAB` | Grab Holdings Limited | Equity | Technology → Software - Application | Y |
| `GRMN` | Garmin | Equity | Technology → Scientific & Technical Instruments | I |
| `GRNY` | Fundstrat Granny Shots US Large Cap ETF | ETF | Index / Sector / Thematic | Y |
| `GRRR` | Gorilla Technology Group | Equity | Technology → Software - Infrastructure | Y |
| `GS` | The Goldman Sachs Group | Equity | Financial Services → Capital Markets | Y |
| `GTLB` | GitLab | Equity | Technology → Software - Infrastructure | Y |
| `GUSH` | Direxion Daily S&P Oil & Gas Exp. & Prod. Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `GWRE` | Guidewire Software | Equity | Technology → Software - Application | Y |
| `GWW` | W.W. Grainger | Equity | Industrials → Industrial Distribution | I |
| `GXO` | GXO Logistics | Equity | Industrials → Integrated Freight & Logistics | Y |
| `HACK` | Amplify Cybersecurity ETF | ETF | Index / Sector / Thematic | Y |
| `HAIN` | The Hain Celestial Group | Equity | Consumer Defensive → Packaged Foods | Y |
| `HAL` | Halliburton | Equity | Energy → Oil & Gas Equipment & Services | Y |
| `HAS` | Hasbro | Equity | Consumer Cyclical → Leisure | I |
| `HASI` | HA Sustainable Infrastructure Capital | Equity | Financial Services → Asset Management | Y |
| `HBAN` | Huntington Bancshares Incorporated | Equity | Financial Services → Banks - Regional | Y |
| `HCA` | HCA Healthcare | Equity | Healthcare → Medical Care Facilities | I |
| `HD` | The Home Depot | Equity | Consumer Cyclical → Home Improvement Retail | Y |
| `HIG` | The Hartford Insurance Group | Equity | Financial Services → Insurance - Diversified | Y |
| `HII` | Huntington Ingalls Industries | Equity | Industrials → Aerospace & Defense | I |
| `HLT` | Hilton Worldwide Holdings | Equity | Consumer Cyclical → Lodging | Y |
| `HNGE` | Hinge Health | Equity | Healthcare → Health Information Services | Y |
| `HON` | Honeywell International | Equity | Industrials → Conglomerates | I |
| `HONA` | Honeywell Aerospace | Equity | Industrials → Aerospace & Defense | I |
| `HOOD` | Robinhood Markets | Equity | Financial Services → Capital Markets | Y |
| `HOOG` | Leverage Shares 2X Long HOOD Daily ETF | ETF | Leveraged & Inverse | Y |
| `HOOX` | Defiance Daily Target 2X Long HOOD ETF | ETF | Leveraged & Inverse | Y |
| `HPE` | Hewlett Packard Enterprise | Equity | Technology → Communication Equipment | Y |
| `HPQ` | HP | Equity | Technology → Computer Hardware | Y |
| `HRL` | Hormel Foods | Equity | Consumer Defensive → Packaged Foods | Y |
| `HSIC` | Henry Schein | Equity | Healthcare → Medical Distribution | I |
| `HST` | Host Hotels & Resorts | Equity | Real Estate → REIT - Hotel & Motel | I |
| `HSY` | The Hershey | Equity | Consumer Defensive → Confectioners | I |
| `HUBB` | Hubbell Incorporated | Equity | Industrials → Electrical Equipment & Parts | I |
| `HUBS` | HubSpot | Equity | Technology → Software - Application | Y |
| `HUM` | Humana | Equity | Healthcare → Healthcare Plans | I |
| `HUT` | Hut 8 | Equity | Financial Services → Capital Markets | Y |
| `HWM` | Howmet Aerospace | Equity | Industrials → Aerospace & Defense | Y |
| `IBIT` | iShares Bitcoin Trust ETF | ETF | Digital-Asset Fund | Y |
| `IBKR` | Interactive Brokers Group | Equity | Financial Services → Capital Markets | I |
| `IBM` | International Business Machines | Equity | Technology → Information Technology Services | Y |
| `ICE` | Intercontinental Exchange | Equity | Financial Services → Financial Data & Stock Exchanges | Y |
| `IDXX` | IDEXX Laboratories | Equity | Healthcare → Diagnostics & Research | Y |
| `IEO` | iShares U.S. Oil & Gas Exploration & Production ETF | ETF | Index / Sector / Thematic | Y |
| `IEV` | iShares Europe ETF | ETF | Index / Sector / Thematic | Y |
| `IEX` | IDEX | Equity | Industrials → Specialty Industrial Machinery | I |
| `IFF` | International Flavors & Fragrances | Equity | Basic Materials → Specialty Chemicals | I |
| `IGPT` | Invesco AI and Next Gen Software ETF | ETF | Index / Sector / Thematic | Y |
| `IHAK` | iShares Cybersecurity and Tech ETF | ETF | Index / Sector / Thematic | Y |
| `ILMN` | Illumina | Equity | Healthcare → Diagnostics & Research | Y |
| `INCY` | Incyte | Equity | Healthcare → Biotechnology | Y |
| `INFQ` | Infleqtion | Equity | Technology → Software - Infrastructure | Y |
| `INTC` | Intel | Equity | Technology → Semiconductors | Y |
| `INTU` | Intuit | Equity | Technology → Software - Application | I |
| `INVH` | Invitation Homes | Equity | Real Estate → REIT - Residential | I |
| `IONQ` | IonQ | Equity | Technology → Computer Hardware | Y |
| `IOT` | Samsara | Equity | Technology → Software - Infrastructure | Y |
| `IP` | International Paper | Equity | Consumer Cyclical → Packaging & Containers | I |
| `IQ` | iQIYI | Equity | Communication Services → Entertainment | Y |
| `IQV` | IQVIA Holdings | Equity | Healthcare → Diagnostics & Research | I |
| `IR` | Ingersoll Rand | Equity | Industrials → Specialty Industrial Machinery | I |
| `IREN` | IREN Limited | Equity | Financial Services → Capital Markets | Y |
| `IRM` | Iron Mountain Incorporated | Equity | Real Estate → REIT - Specialty | Y |
| `ISRG` | Intuitive Surgical | Equity | Healthcare → Medical Instruments & Supplies | Y |
| `IT` | Gartner | Equity | Technology → Information Technology Services | Y |
| `ITUB` | Itaú Unibanco Holding | Equity | Financial Services → Banks - Regional | Y |
| `ITW` | Illinois Tool Works | Equity | Industrials → Specialty Industrial Machinery | I |
| `IVV` | iShares Core S&P 500 ETF | ETF | Index / Sector / Thematic | Y |
| `IVZ` | Invesco | Equity | Financial Services → Asset Management | I |
| `IWM` | iShares Russell 2000 ETF | ETF | Index / Sector / Thematic | Y |
| `J` | Jacobs Solutions | Equity | Industrials → Engineering & Construction | I |
| `JBHT` | J.B. Hunt Transport Services | Equity | Industrials → Integrated Freight & Logistics | I |
| `JBL` | Jabil | Equity | Technology → Electronic Components | Y |
| `JCI` | Johnson Controls International | Equity | Industrials → Building Products & Equipment | I |
| `JD` | JD.com | Equity | Consumer Cyclical → Internet Retail | Y |
| `JEF` | Jefferies Financial Group | Equity | Financial Services → Capital Markets | Y |
| `JKHY` | Jack Henry & Associates | Equity | Technology → Information Technology Services | I |
| `JKS` | JinkoSolar Holding Co. | Equity | Technology → Solar | Y |
| `JNJ` | Johnson & Johnson | Equity | Healthcare → Drug Manufacturers - General | Y |
| `JOBY` | Joby Aviation | Equity | Industrials → Airports & Air Services | Y |
| `JPM` | JPMorgan Chase & | Equity | Financial Services → Banks - Diversified | Y |
| `KDP` | Keurig Dr Pepper | Equity | Consumer Defensive → Beverages - Non-Alcoholic | I |
| `KEY` | KeyCorp | Equity | Financial Services → Banks - Regional | Y |
| `KEYS` | Keysight Technologies | Equity | Technology → Scientific & Technical Instruments | I |
| `KHC` | The Kraft Heinz | Equity | Consumer Defensive → Packaged Foods | I |
| `KIM` | Kimco Realty | Equity | Real Estate → REIT - Retail | I |
| `KKR` | KKR & Co. | Equity | Financial Services → Asset Management | Y |
| `KLAC` | KLA | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `KLIC` | Kulicke and Soffa Industries | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `KMB` | Kimberly-Clark | Equity | Consumer Defensive → Household & Personal Products | I |
| `KMI` | Kinder Morgan | Equity | Energy → Oil & Gas Midstream | Y |
| `KMX` | CarMax | Equity | Consumer Cyclical → Auto & Truck Dealerships | Y |
| `KNSL` | Kinsale Capital Group | Equity | Financial Services → Insurance - Property & Casualty | Y |
| `KO` | The Coca-Cola | Equity | Consumer Defensive → Beverages - Non-Alcoholic | Y |
| `KOLD` | ProShares UltraShort Bloomberg Natural Gas | ETF | Leveraged & Inverse | Y |
| `KR` | The Kroger | Equity | Consumer Defensive → Grocery Stores | Y |
| `KRE` | State Street SPDR S&P Regional Banking ETF | ETF | Index / Sector / Thematic | Y |
| `KVUE` | Kenvue | Equity | Consumer Defensive → Household & Personal Products | I |
| `KVYO` | Klaviyo | Equity | Technology → Software - Application | Y |
| `KWEB` | KraneShares CSI China Internet ETF | ETF | Index / Sector / Thematic | Y |
| `L` | Loews | Equity | Financial Services → Insurance - Property & Casualty | I |
| `LABD` | Direxion Daily S&P Biotech Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `LABU` | Direxion Daily S&P Biotech Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `LAC` | Lithium Americas | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `LAES` | SEALSQ | Equity | Technology → Semiconductors | Y |
| `LB` | LandBridge Company LLC | Equity | Energy → Oil & Gas Equipment & Services | Y |
| `LCID` | Lucid Group | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `LDOS` | Leidos Holdings | Equity | Technology → Information Technology Services | I |
| `LEN` | Lennar | Equity | Consumer Cyclical → Residential Construction | I |
| `LH` | Labcorp Holdings | Equity | Healthcare → Diagnostics & Research | I |
| `LHX` | L3Harris Technologies | Equity | Industrials → Aerospace & Defense | I |
| `LI` | Li Auto | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `LII` | Lennox International | Equity | Industrials → Building Products & Equipment | I |
| `LIN` | Linde | Equity | Basic Materials → Specialty Chemicals | I |
| `LITE` | Lumentum Holdings | Equity | Technology → Communication Equipment | Y |
| `LKNCY` | Luckin Coffee | Equity | Consumer Cyclical → Restaurants | Y |
| `LLY` | Eli Lilly and | Equity | Healthcare → Drug Manufacturers - General | Y |
| `LMND` | Lemonade | Equity | Financial Services → Insurance - Property & Casualty | Y |
| `LMT` | Lockheed Martin | Equity | Industrials → Aerospace & Defense | Y |
| `LNT` | Alliant Energy | Equity | Utilities → Utilities - Regulated Electric | I |
| `LOW` | Lowe's Companies | Equity | Consumer Cyclical → Home Improvement Retail | I |
| `LRCX` | Lam Research | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `LULU` | lululemon athletica inc. | Equity | Consumer Cyclical → Apparel Retail | I |
| `LUMN` | Lumen Technologies | Equity | Communication Services → Telecom Services | Y |
| `LUNR` | Intuitive Machines | Equity | Industrials → Aerospace & Defense | Y |
| `LUV` | Southwest Airlines | Equity | Industrials → Airlines | I |
| `LVS` | Las Vegas Sands | Equity | Consumer Cyclical → Resorts & Casinos | Y |
| `LWAY` | Lifeway Foods | Equity | Consumer Defensive → Packaged Foods | Y |
| `LYB` | LyondellBasell Industries | Equity | Basic Materials → Specialty Chemicals | I |
| `LYFT` | Lyft | Equity | Technology → Software - Application | Y |
| `LYG` | Lloyds Banking Group | Equity | Financial Services → Banks - Regional | Y |
| `LYV` | Live Nation Entertainment | Equity | Communication Services → Entertainment | Y |
| `MA` | Mastercard Incorporated | Equity | Financial Services → Credit Services | Y |
| `MAA` | Mid-America Apartment Communities | Equity | Real Estate → REIT - Residential | I |
| `MAC` | The Macerich | Equity | Real Estate → REIT - Retail | Y |
| `MAR` | Marriott International | Equity | Consumer Cyclical → Lodging | Y |
| `MARA` | MARA Holdings | Equity | Financial Services → Capital Markets | Y |
| `MAS` | Masco | Equity | Industrials → Building Products & Equipment | I |
| `MBGYY` | Mercedes-Benz Group AG | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `MCD` | McDonald's | Equity | Consumer Cyclical → Restaurants | Y |
| `MCHP` | Microchip Technology Incorporated | Equity | Technology → Semiconductors | Y |
| `MCK` | McKesson | Equity | Healthcare → Medical Distribution | Y |
| `MCO` | Moody's | Equity | Financial Services → Financial Data & Stock Exchanges | I |
| `MDB` | MongoDB | Equity | Technology → Software - Infrastructure | Y |
| `MDLZ` | Mondelez International | Equity | Consumer Defensive → Confectioners | Y |
| `MDT` | Medtronic | Equity | Healthcare → Medical Devices | Y |
| `MELI` | MercadoLibre | Equity | Consumer Cyclical → Internet Retail | Y |
| `MET` | MetLife | Equity | Financial Services → Insurance - Life | I |
| `META` | Meta Platforms | Equity | Communication Services → Internet Content & Information | Y |
| `MGM` | MGM Resorts International | Equity | Consumer Cyclical → Resorts & Casinos | I |
| `MGPI` | MGP Ingredients | Equity | Consumer Defensive → Beverages - Wineries & Distilleries | Y |
| `MHK` | Mohawk Industries | Equity | Consumer Cyclical → Furnishings, Fixtures & Appliances | Y |
| `MIDZ` | Direxion Daily Mid Cap Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `MKC` | McCormick & Company, Incorporated | Equity | Consumer Defensive → Packaged Foods | Y |
| `ML` | — | — | Delisted | Y |
| `MLM` | Martin Marietta Materials | Equity | Basic Materials → Building Materials | Y |
| `MMM` | 3M | Equity | Industrials → Conglomerates | Y |
| `MNST` | Monster Beverage | Equity | Consumer Defensive → Beverages - Non-Alcoholic | I |
| `MO` | Altria Group | Equity | Consumer Defensive → Tobacco | Y |
| `MOD` | Modine Manufacturing | Equity | Consumer Cyclical → Auto Parts | Y |
| `MOS` | The Mosaic | Equity | Basic Materials → Agricultural Inputs | I |
| `MP` | MP Materials | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `MPC` | Marathon Petroleum | Equity | Energy → Oil & Gas Refining & Marketing | Y |
| `MPWR` | Monolithic Power Systems | Equity | Technology → Semiconductors | I |
| `MRK` | Merck & Co. | Equity | Healthcare → Drug Manufacturers - General | Y |
| `MRNA` | Moderna | Equity | Healthcare → Biotechnology | I |
| `MRP` | Millrose Properties | Equity | Real Estate → REIT - Residential | Y |
| `MRSH` | Marsh & McLennan Companies | Equity | Financial Services → Insurance Brokers | I |
| `MRUS` | — | — | Delisted | Y |
| `MRVL` | Marvell Technology | Equity | Technology → Semiconductors | Y |
| `MS` | Morgan Stanley | Equity | Financial Services → Capital Markets | Y |
| `MSCI` | MSCI | Equity | Financial Services → Financial Data & Stock Exchanges | I |
| `MSFT` | Microsoft | Equity | Technology → Software - Infrastructure | Y |
| `MSFU` | Direxion Daily MSFT Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `MSI` | Motorola Solutions | Equity | Technology → Communication Equipment | I |
| `MSTR` | Strategy | Equity | Technology → Software - Application | Y |
| `MSTU` | T-Rex 2X Long MSTR Daily Target ETF | ETF | Leveraged & Inverse | Y |
| `MT` | ArcelorMittal | Equity | Basic Materials → Steel | Y |
| `MTB` | M&T Bank | Equity | Financial Services → Banks - Regional | Y |
| `MTD` | Mettler-Toledo International | Equity | Healthcare → Diagnostics & Research | I |
| `MU` | Micron Technology | Equity | Technology → Semiconductors | Y |
| `MUU` | Direxion Daily MU Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `MYY` | ProShares Short MidCap400 | ETF | Leveraged & Inverse | Y |
| `NBIS` | Nebius Group | Equity | Communication Services → Internet Content & Information | Y |
| `NCLH` | Norwegian Cruise Line Holdings | Equity | Consumer Cyclical → Travel Services | Y |
| `NDAQ` | Nasdaq | Equity | Financial Services → Financial Data & Stock Exchanges | Y |
| `NDSN` | Nordson | Equity | Industrials → Specialty Industrial Machinery | I |
| `NEE` | NextEra Energy | Equity | Utilities → Utilities - Regulated Electric | Y |
| `NEM` | Newmont | Equity | Basic Materials → Gold | Y |
| `NET` | Cloudflare | Equity | Technology → Software - Infrastructure | Y |
| `NFLX` | Netflix | Equity | Communication Services → Entertainment | I |
| `NGVC` | Natural Grocers by Vitamin Cottage | Equity | Consumer Defensive → Grocery Stores | Y |
| `NI` | NiSource | Equity | Utilities → Utilities - Regulated Gas | I |
| `NIO` | NIO | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `NKE` | NIKE | Equity | Consumer Cyclical → Footwear & Accessories | I |
| `NNN` | NNN REIT | Equity | Real Estate → REIT - Retail | Y |
| `NOC` | Northrop Grumman | Equity | Industrials → Aerospace & Defense | Y |
| `NOK` | Nokia Oyj | Equity | Technology → Communication Equipment | Y |
| `NOVA` | — | — | Delisted | Y |
| `NOW` | ServiceNow | Equity | Technology → Software - Application | Y |
| `NRG` | NRG Energy | Equity | Utilities → Utilities - Independent Power Producers | I |
| `NSC` | Norfolk Southern | Equity | Industrials → Railroads | I |
| `NTAP` | NetApp | Equity | Technology → Software - Infrastructure | Y |
| `NTRS` | Northern Trust | Equity | Financial Services → Asset Management | Y |
| `NTSK` | Netskope | Equity | Technology → Software - Infrastructure | Y |
| `NU` | Nu Holdings | Equity | Financial Services → Banks - Regional | Y |
| `NUE` | Nucor | Equity | Basic Materials → Steel | I |
| `NVD` | Graniteshares 2x Short NVDA Daily ETF | ETF | Leveraged & Inverse | Y |
| `NVDA` | NVIDIA | Equity | Technology → Semiconductors | Y |
| `NVDL` | GraniteShares 2x Long NVDA Daily ETF | ETF | Leveraged & Inverse | Y |
| `NVDX` | T-Rex 2X Long NVIDIA Daily Target ETF | ETF | Leveraged & Inverse | Y |
| `NVR` | NVR | Equity | Consumer Cyclical → Residential Construction | I |
| `NWS` | News | Equity | Communication Services → Entertainment | I |
| `NWSA` | News | Equity | Communication Services → Entertainment | I |
| `NXE` | NexGen Energy | Equity | Energy → Uranium | Y |
| `NXPI` | NXP Semiconductors | Equity | Technology → Semiconductors | Y |
| `O` | Realty Income | Equity | Real Estate → REIT - Retail | Y |
| `ODFL` | Old Dominion Freight Line | Equity | Industrials → Trucking | Y |
| `OGN` | Organon & | Equity | Healthcare → Drug Manufacturers - General | Y |
| `OIH` | VanEck Oil Services ETF | ETF | Index / Sector / Thematic | Y |
| `OKE` | ONEOK | Equity | Energy → Oil & Gas Midstream | I |
| `OKLL` | Defiance Daily Target 2X Long OKLO ETF | ETF | Leveraged & Inverse | Y |
| `OKLO` | Oklo | Equity | Utilities → Utilities - Independent Power Producers | Y |
| `OKTA` | Okta | Equity | Technology → Software - Infrastructure | Y |
| `OMC` | Omnicom Group | Equity | Communication Services → Advertising Agencies | I |
| `ON` | ON Semiconductor | Equity | Technology → Semiconductors | I |
| `ONON` | On Holding AG | Equity | Consumer Cyclical → Footwear & Accessories | Y |
| `ONTO` | Onto Innovation | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `ORCL` | Oracle | Equity | Technology → Software - Infrastructure | Y |
| `ORLY` | O'Reilly Automotive | Equity | Consumer Cyclical → Auto Parts | I |
| `OTF` | Blue Owl Technology Finance | Equity | Financial Services → Asset Management | Y |
| `OTIS` | Otis Worldwide | Equity | Industrials → Specialty Industrial Machinery | Y |
| `OUSM` | ALPS O'Shares U.S. Small-Cap Quality Dividend ETF Shares | ETF | Index / Sector / Thematic | Y |
| `OWL` | Blue Owl Capital | Equity | Financial Services → Asset Management | Y |
| `OXY` | Occidental Petroleum | Equity | Energy → Oil & Gas E&P | I |
| `PAAS` | Pan American Silver | Equity | Basic Materials → Gold | Y |
| `PANW` | Palo Alto Networks | Equity | Technology → Software - Infrastructure | Y |
| `PATH` | UiPath | Equity | Technology → Software - Infrastructure | Y |
| `PAYX` | Paychex | Equity | Technology → Software - Application | I |
| `PBW` | Invesco WilderHill Clean Energy ETF | ETF | Index / Sector / Thematic | Y |
| `PCAR` | PACCAR | Equity | Industrials → Farm & Heavy Construction Machinery | I |
| `PCG` | PG&E | Equity | Utilities → Utilities - Regulated Electric | Y |
| `PDD` | PDD Holdings | Equity | Consumer Cyclical → Internet Retail | Y |
| `PEG` | Public Service Enterprise Group Incorporated | Equity | Utilities → Utilities - Regulated Electric | I |
| `PEGA` | Pegasystems | Equity | Technology → Software - Application | Y |
| `PEP` | PepsiCo | Equity | Consumer Defensive → Beverages - Non-Alcoholic | I |
| `PFE` | Pfizer | Equity | Healthcare → Drug Manufacturers - General | I |
| `PFG` | Principal Financial Group | Equity | Financial Services → Asset Management | I |
| `PG` | The Procter & Gamble | Equity | Consumer Defensive → Household & Personal Products | I |
| `PGR` | The Progressive | Equity | Financial Services → Insurance - Property & Casualty | I |
| `PH` | Parker-Hannifin | Equity | Industrials → Specialty Industrial Machinery | I |
| `PHM` | PulteGroup | Equity | Consumer Cyclical → Residential Construction | I |
| `PKG` | Packaging Corporation of America | Equity | Consumer Cyclical → Packaging & Containers | I |
| `PKX` | POSCO Holdings | Equity | Basic Materials → Steel | Y |
| `PL` | Planet Labs PBC | Equity | Industrials → Aerospace & Defense | Y |
| `PLD` | Prologis | Equity | Real Estate → REIT - Industrial | Y |
| `PLTR` | Palantir Technologies | Equity | Technology → Software - Infrastructure | I |
| `PM` | Philip Morris International | Equity | Consumer Defensive → Tobacco | Y |
| `PNC` | The PNC Financial Services Group | Equity | Financial Services → Banks - Regional | Y |
| `PNFP` | Pinnacle Financial Partners | Equity | Financial Services → Banks - Regional | Y |
| `PNR` | Pentair | Equity | Industrials → Specialty Industrial Machinery | I |
| `PNW` | Pinnacle West Capital | Equity | Utilities → Utilities - Regulated Electric | I |
| `PODD` | Insulet | Equity | Healthcare → Medical Devices | Y |
| `PONY` | Pony AI | Equity | Technology → Information Technology Services | Y |
| `PPG` | PPG Industries | Equity | Basic Materials → Specialty Chemicals | I |
| `PPL` | PPL | Equity | Utilities → Utilities - Regulated Electric | I |
| `PPLT` | abrdn Physical Platinum Shares ETF | ETF | Index / Sector / Thematic | Y |
| `PRSO` | Peraso | Equity | Technology → Semiconductors | Y |
| `PRU` | Prudential Financial | Equity | Financial Services → Insurance - Life | I |
| `PSA` | Public Storage | Equity | Real Estate → REIT - Industrial | I |
| `PSKY` | Paramount Skydance | Equity | Communication Services → Entertainment | I |
| `PSQ` | ProShares Short QQQ | ETF | Leveraged & Inverse | Y |
| `PSX` | Phillips 66 | Equity | Energy → Oil & Gas Refining & Marketing | Y |
| `PTC` | PTC | Equity | Technology → Software - Application | I |
| `PWR` | Quanta Services | Equity | Industrials → Engineering & Construction | I |
| `PXD` | — | — | Delisted | Y |
| `PYPL` | PayPal Holdings | Equity | Financial Services → Credit Services | Y |
| `Q` | Qnity Electronics | Equity | Technology → Semiconductor Equipment & Materials | I |
| `QBTS` | D-Wave Quantum | Equity | Technology → Computer Hardware | Y |
| `QBTX` | Tradr 2X Long QBTS Daily ETF | ETF | Leveraged & Inverse | Y |
| `QBTZ` | Defiance Daily Target 2X Short QBTS ETF | ETF | Leveraged & Inverse | Y |
| `QCOM` | QUALCOMM Incorporated | Equity | Technology → Semiconductors | Y |
| `QID` | ProShares UltraShort QQQ | ETF | Leveraged & Inverse | Y |
| `QMCO` | Quantum | Equity | Technology → Computer Hardware | Y |
| `QNC` | Quantum eMotion | Equity | Technology → Software - Infrastructure | Y |
| `QQQ` | Invesco QQQ Trust | ETF | Index / Sector / Thematic | Y |
| `QS` | QuantumScape | Equity | Consumer Cyclical → Auto Parts | Y |
| `QSI` | Quantum-Si incorporated | Equity | Healthcare → Medical Devices | Y |
| `QTUM` | Defiance Quantum ETF | ETF | Index / Sector / Thematic | Y |
| `QUBT` | Quantum Computing | Equity | Technology → Computer Hardware | Y |
| `QXO` | QXO | Equity | Industrials → Industrial Distribution | Y |
| `QYLD` | Global X NASDAQ 100 Covered Call ETF | ETF | Index / Sector / Thematic | Y |
| `RBLX` | Roblox | Equity | Communication Services → Electronic Gaming & Multimedia | Y |
| `RCL` | Royal Caribbean Cruises | Equity | Consumer Cyclical → Travel Services | I |
| `RDDT` | Reddit | Equity | Communication Services → Internet Content & Information | Y |
| `RDW` | Redwire | Equity | Industrials → Aerospace & Defense | Y |
| `REBN` | Reborn Coffee | Equity | Consumer Cyclical → Restaurants | Y |
| `REG` | Regency Centers | Equity | Real Estate → REIT - Retail | I |
| `REGN` | Regeneron Pharmaceuticals | Equity | Healthcare → Biotechnology | Y |
| `REMX` | VanEck Rare Earth and Strategic Metals ETF | ETF | Index / Sector / Thematic | Y |
| `RF` | Regions Financial | Equity | Financial Services → Banks - Regional | Y |
| `RGTI` | Rigetti Computing | Equity | Technology → Computer Hardware | Y |
| `RGTX` | Defiance Daily Target 2X Long RGTI ETF | ETF | Leveraged & Inverse | Y |
| `RGTZ` | Defiance Daily Target 2X Short RGTI ETF | ETF | Leveraged & Inverse | Y |
| `RIG` | Transocean | Equity | Energy → Oil & Gas Drilling | Y |
| `RIO` | Rio Tinto Group | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `RIOT` | Riot Platforms | Equity | Financial Services → Capital Markets | Y |
| `RIVN` | Rivian Automotive | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `RJF` | Raymond James Financial | Equity | Financial Services → Asset Management | Y |
| `RKDA` | Arcadia Biosciences | Equity | Consumer Defensive → Packaged Foods | Y |
| `RKLB` | Rocket Lab | Equity | Industrials → Aerospace & Defense | I |
| `RKLZ` | Defiance Daily Target 2X Short RKLB ETF | ETF | Index / Sector / Thematic | Y |
| `RL` | Ralph Lauren | Equity | Consumer Cyclical → Apparel Manufacturing | I |
| `RLAY` | Relay Therapeutics | Equity | Healthcare → Biotechnology | Y |
| `RMD` | ResMed | Equity | Healthcare → Medical Instruments & Supplies | I |
| `ROBO` | Robo Global Robotics and Automation Index ETF | ETF | Index / Sector / Thematic | Y |
| `ROK` | Rockwell Automation | Equity | Industrials → Specialty Industrial Machinery | Y |
| `ROL` | Rollins | Equity | Consumer Cyclical → Personal Services | I |
| `ROOT` | Root | Equity | Financial Services → Insurance - Property & Casualty | Y |
| `ROP` | Roper Technologies | Equity | Technology → Software - Application | I |
| `ROST` | Ross Stores | Equity | Consumer Cyclical → Apparel Retail | I |
| `RS` | Reliance | Equity | Basic Materials → Steel | Y |
| `RSG` | Republic Services | Equity | Industrials → Waste Management | I |
| `RSP` | Invesco S&P 500 Equal Weight ETF | ETF | Index / Sector / Thematic | Y |
| `RTX` | RTX | Equity | Industrials → Aerospace & Defense | Y |
| `RUN` | Sunrun | Equity | Technology → Solar | Y |
| `RVTY` | Revvity | Equity | Healthcare → Diagnostics & Research | I |
| `RWM` | ProShares Short Russell2000 | ETF | Leveraged & Inverse | Y |
| `RXRX` | Recursion Pharmaceuticals | Equity | Healthcare → Biotechnology | Y |
| `S` | SentinelOne | Equity | Technology → Software - Infrastructure | Y |
| `SAGE` | — | — | Delisted | Y |
| `SAIC` | Science Applications International | Equity | Technology → Information Technology Services | Y |
| `SAN` | Banco Santander | Equity | Financial Services → Banks - Diversified | Y |
| `SAP` | SAP SE | Equity | Technology → Software - Application | Y |
| `SBAC` | SBA Communications | Equity | Real Estate → REIT - Specialty | Y |
| `SBB` | ProShares Short SmallCap600 | ETF | Leveraged & Inverse | Y |
| `SBRA` | Sabra Health Care REIT | Equity | Real Estate → REIT - Healthcare Facilities | Y |
| `SBSW` | Sibanye Stillwater Limited | Equity | Basic Materials → Other Precious Metals & Mining | Y |
| `SBUX` | Starbucks | Equity | Consumer Cyclical → Restaurants | I |
| `SCCO` | Southern Copper | Equity | Basic Materials → Copper | Y |
| `SCHW` | The Charles Schwab | Equity | Financial Services → Capital Markets | Y |
| `SCHW-PD` | The Charles Schwab | Equity | Financial Services → Capital Markets | Y |
| `SCO` | ProShares UltraShort Bloomberg Crude Oil | ETF | Leveraged & Inverse | Y |
| `SDOW` | ProShares UltraPro Short Dow30 | ETF | Leveraged & Inverse | Y |
| `SDP` | ProShares UltraShort Utilities | ETF | Leveraged & Inverse | Y |
| `SDS` | ProShares UltraShort S&P500 | ETF | Leveraged & Inverse | Y |
| `SEB` | Seaboard | Equity | Industrials → Conglomerates | Y |
| `SEMI` | Columbia Select Technology ETF | ETF | Index / Sector / Thematic | Y |
| `SFM` | Sprouts Farmers Market | Equity | Consumer Defensive → Grocery Stores | Y |
| `SFTBY` | SoftBank Group | Equity | Communication Services → Telecom Services | Y |
| `SG` | Sweetgreen | Equity | Consumer Cyclical → Restaurants | Y |
| `SGML` | Sigma Lithium | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `SH` | ProShares Short S&P500 | ETF | Leveraged & Inverse | Y |
| `SHAK` | Shake Shack | Equity | Consumer Cyclical → Restaurants | Y |
| `SHEL` | Shell | Equity | Energy → Oil & Gas Integrated | Y |
| `SHMD` | SCHMID Group | Equity | Industrials → Specialty Industrial Machinery | Y |
| `SHOP` | Shopify | Equity | Technology → Software - Application | Y |
| `SHW` | The Sherwin-Williams | Equity | Basic Materials → Specialty Chemicals | I |
| `SJM` | The J. M. Smucker | Equity | Consumer Defensive → Packaged Foods | I |
| `SKF` | ProShares UltraShort Financials | ETF | Leveraged & Inverse | Y |
| `SKHY` | SK hynix | Equity | Technology → Semiconductors | Y |
| `SLB` | SLB | Equity | Energy → Oil & Gas Equipment & Services | I |
| `SLG` | SL Green Realty | Equity | Real Estate → REIT - Office | Y |
| `SLNO` | — | — | Delisted | Y |
| `SLV` | iShares Silver Trust | ETF | Index / Sector / Thematic | Y |
| `SMCI` | Super Micro Computer | Equity | Technology → Computer Hardware | Y |
| `SMDD` | ProShares UltraPro Short MidCap400 | ETF | Leveraged & Inverse | Y |
| `SMH` | VanEck Semiconductor ETF | ETF | Index / Sector / Thematic | Y |
| `SMST` | Defiance Daily Target 2X Short MSTR ETF | ETF | Leveraged & Inverse | Y |
| `SMTC` | Semtech | Equity | Technology → Semiconductors | Y |
| `SN` | SharkNinja | Equity | Consumer Cyclical → Furnishings, Fixtures & Appliances | Y |
| `SNA` | Snap-on Incorporated | Equity | Industrials → Tools & Accessories | I |
| `SNDK` | Sandisk | Equity | Technology → Computer Hardware | Y |
| `SNDU` | T-REX 2X Long SNDK Daily Target ETF | ETF | Leveraged & Inverse | Y |
| `SNOW` | Snowflake | Equity | Technology → Software - Application | Y |
| `SNPS` | Synopsys | Equity | Technology → Software - Infrastructure | I |
| `SNX` | TD SYNNEX | Equity | Technology → Electronics & Computer Distribution | Y |
| `SO` | The Southern | Equity | Utilities → Utilities - Regulated Electric | I |
| `SOL-USD` | Solana USD | Crypto | Cryptocurrency | Y |
| `SOLT` | 2x Solana ETF | ETF | Leveraged & Inverse | Y |
| `SOLV` | Solventum | Equity | Healthcare → Medical Instruments & Supplies | I |
| `SOLZ` | Solana ETF | ETF | Leveraged & Inverse | Y |
| `SOUN` | SoundHound AI | Equity | Technology → Software - Application | Y |
| `SOUX` | Defiance Daily Target 2X Long SOUN ETF | ETF | Leveraged & Inverse | Y |
| `SOXL` | Direxion Daily Semiconductor Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `SOXS` | Direxion Daily Semiconductor Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `SPAM` | Themes Cybersecurity ETF | ETF | Index / Sector / Thematic | Y |
| `SPCX` | Space Exploration Technologies | Equity | Industrials → Aerospace & Defense | Y |
| `SPG` | Simon Property Group | Equity | Real Estate → REIT - Retail | I |
| `SPGI` | S&P Global | Equity | Financial Services → Financial Data & Stock Exchanges | I |
| `SPOT` | Spotify Technology | Equity | Communication Services → Internet Content & Information | Y |
| `SPWR` | SunPower | Equity | Technology → Solar | Y |
| `SPXL` | Direxion Daily S&P500 Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `SPXS` | Direxion Daily S&P 500 Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `SPXU` | ProShares UltraPro Short S&P500 | ETF | Leveraged & Inverse | Y |
| `SQQQ` | ProShares UltraPro Short QQQ | ETF | Leveraged & Inverse | Y |
| `SRE` | Sempra | Equity | Utilities → Utilities - Diversified | I |
| `SRNE` | Sorrento Therapeutics | Equity | Healthcare → Biotechnology | Y |
| `SRRK` | Scholar Rock Holding | Equity | Healthcare → Biotechnology | Y |
| `SRTA` | Strata Critical Medical | Equity | Healthcare → Medical Care Facilities | Y |
| `SRTY` | ProShares UltraPro Short Russell2000 | ETF | Leveraged & Inverse | Y |
| `SRUUF` | Sprott Physical Uranium Trust Fund | Equity | Energy → Uranium | Y |
| `SSG` | ProShares UltraShort Semiconductors | ETF | Leveraged & Inverse | Y |
| `STE` | STERIS | Equity | Healthcare → Medical Devices | I |
| `STKL` | — | — | Delisted | Y |
| `STLD` | Steel Dynamics | Equity | Basic Materials → Steel | I |
| `STT` | State Street | Equity | Financial Services → Asset Management | I |
| `STX` | Seagate Technology Holdings | Equity | Technology → Computer Hardware | Y |
| `STZ` | Constellation Brands | Equity | Consumer Defensive → Beverages - Brewers | I |
| `SW` | Smurfit Westrock Plc | Equity | Consumer Cyclical → Packaging & Containers | I |
| `SWK` | Stanley Black & Decker | Equity | Industrials → Tools & Accessories | I |
| `SWKS` | Skyworks Solutions | Equity | Technology → Semiconductors | I |
| `SYF` | Synchrony Financial | Equity | Financial Services → Credit Services | Y |
| `SYK` | Stryker | Equity | Healthcare → Medical Devices | I |
| `SYM` | Symbotic | Equity | Industrials → Specialty Industrial Machinery | Y |
| `SYY` | Sysco | Equity | Consumer Defensive → Food Distribution | I |
| `SZK` | ProShares UltraShort Consumer Staples | ETF | Leveraged & Inverse | Y |
| `T` | AT&T | Equity | Communication Services → Telecom Services | Y |
| `TACK` | Fairlead Tactical Sector Fund | ETF | Index / Sector / Thematic | Y |
| `TAN` | Invesco Solar ETF | ETF | Index / Sector / Thematic | Y |
| `TAP` | Molson Coors Beverage | Equity | Consumer Defensive → Beverages - Brewers | I |
| `TBHC` | The Brand House Collective | Equity | Consumer Cyclical → Home Improvement Retail | Y |
| `TCEHY` | Tencent Holdings Limited | Equity | Communication Services → Internet Content & Information | Y |
| `TDC` | Teradata | Equity | Technology → Software - Infrastructure | Y |
| `TDG` | TransDigm Group Incorporated | Equity | Industrials → Aerospace & Defense | Y |
| `TDOC` | Teladoc Health | Equity | Healthcare → Health Information Services | Y |
| `TDY` | Teledyne Technologies Incorporated | Equity | Technology → Scientific & Technical Instruments | I |
| `TEAM` | Atlassian | Equity | Technology → Software - Application | Y |
| `TECH` | Bio-Techne | Equity | Healthcare → Biotechnology | I |
| `TECK` | Teck Resources Limited | Equity | Basic Materials → Copper | Y |
| `TECS` | Direxion Daily Technology Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `TEL` | TE Connectivity | Equity | Technology → Electronic Components | I |
| `TER` | Teradyne | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `TEX` | Terex | Equity | Industrials → Farm & Heavy Construction Machinery | Y |
| `TFC` | Truist Financial | Equity | Financial Services → Banks - Regional | Y |
| `TGE` | The Generation Essentials Group | Equity | Financial Services → Asset Management | Y |
| `TGT` | Target | Equity | Consumer Defensive → Discount Stores | I |
| `TH` | Target Hospitality | Equity | Industrials → Specialty Business Services | Y |
| `TIGR` | UP Fintech Holding Limited | Equity | Financial Services → Capital Markets | Y |
| `TJX` | The TJX Companies | Equity | Consumer Cyclical → Apparel Retail | Y |
| `TKO` | TKO Group Holdings | Equity | Communication Services → Entertainment | I |
| `TLT` | iShares 20+ Year Treasury Bond ETF | ETF | Index / Sector / Thematic | Y |
| `TMO` | Thermo Fisher Scientific | Equity | Healthcare → Diagnostics & Research | Y |
| `TMUS` | T-Mobile US | Equity | Communication Services → Telecom Services | Y |
| `TNA` | Direxion Daily Small Cap Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `TNK` | Teekay Tankers | Equity | Energy → Oil & Gas Midstream | Y |
| `TOL` | Toll Brothers | Equity | Consumer Cyclical → Residential Construction | Y |
| `TOST` | Toast | Equity | Technology → Software - Infrastructure | Y |
| `TPL` | Texas Pacific Land | Equity | Energy → Oil & Gas E&P | Y |
| `TPR` | Tapestry | Equity | Consumer Cyclical → Luxury Goods | I |
| `TQQQ` | ProShares UltraPro QQQ | ETF | Leveraged & Inverse | Y |
| `TRGP` | Targa Resources | Equity | Energy → Oil & Gas Midstream | I |
| `TRI` | Thomson Reuters | Equity | Industrials → Specialty Business Services | I |
| `TRMB` | Trimble | Equity | Technology → Scientific & Technical Instruments | I |
| `TRMD` | TORM | Equity | Energy → Oil & Gas Midstream | Y |
| `TROW` | T. Rowe Price Group | Equity | Financial Services → Asset Management | I |
| `TRV` | The Travelers Companies | Equity | Financial Services → Insurance - Property & Casualty | I |
| `TSCO` | Tractor Supply | Equity | Consumer Cyclical → Specialty Retail | I |
| `TSDD` | Graniteshares 2x Short TSLA Daily ETF | ETF | Leveraged & Inverse | Y |
| `TSLA` | Tesla | Equity | Consumer Cyclical → Auto Manufacturers | I |
| `TSLL` | Direxion Daily TSLA Bull 2X Shares | ETF | Leveraged & Inverse | Y |
| `TSLR` | Graniteshares 2x Long TSLA Daily ETF | ETF | Leveraged & Inverse | Y |
| `TSLS` | Direxion Daily TSLA Bear 1X Shares | ETF | Leveraged & Inverse | Y |
| `TSLZ` | T-Rex 2X Inverse Tesla Daily Target ETF | ETF | Leveraged & Inverse | Y |
| `TSM` | Taiwan Semiconductor Manufacturing Company Limited | Equity | Technology → Semiconductors | Y |
| `TSN` | Tyson Foods | Equity | Consumer Defensive → Farm Products | I |
| `TSVT` | — | — | Delisted | Y |
| `TT` | Trane Technologies | Equity | Industrials → Building Products & Equipment | I |
| `TTD` | The Trade Desk | Equity | Communication Services → Advertising Agencies | Y |
| `TTWO` | Take-Two Interactive Software | Equity | Communication Services → Electronic Gaming & Multimedia | Y |
| `TUR` | iShares MSCI Turkey ETF | ETF | Index / Sector / Thematic | Y |
| `TW` | Tradeweb Markets | Equity | Financial Services → Capital Markets | Y |
| `TWLO` | Twilio | Equity | Technology → Software - Infrastructure | Y |
| `TWM` | ProShares UltraShort Russell2000 | ETF | Leveraged & Inverse | Y |
| `TWTR` | — | — | Delisted | Y |
| `TXN` | Texas Instruments Incorporated | Equity | Technology → Semiconductors | I |
| `TXT` | Textron | Equity | Industrials → Aerospace & Defense | I |
| `TYL` | Tyler Technologies | Equity | Technology → Software - Application | I |
| `TZA` | Direxion Daily Small Cap Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `U` | Unity Software | Equity | Technology → Software - Application | Y |
| `UAL` | United Airlines Holdings | Equity | Industrials → Airlines | I |
| `UBER` | Uber Technologies | Equity | Technology → Software - Application | Y |
| `UCAR` | U Power Limited | Equity | Consumer Cyclical → Auto & Truck Dealerships | Y |
| `UCO` | ProShares Ultra Bloomberg Crude Oil | ETF | Leveraged & Inverse | Y |
| `UCTT` | Ultra Clean Holdings | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `UCYB` | ProShares Ultra Nasdaq Cybersecurity | ETF | Index / Sector / Thematic | Y |
| `UDOW` | ProShares UltraPro Dow30 | ETF | Leveraged & Inverse | Y |
| `UDR` | UDR | Equity | Real Estate → REIT - Residential | I |
| `UEC` | Uranium Energy | Equity | Energy → Uranium | Y |
| `UGL` | ProShares Ultra Gold | ETF | Leveraged & Inverse | Y |
| `UHS` | Universal Health Services | Equity | Healthcare → Medical Care Facilities | Y |
| `UI` | Ubiquiti | Equity | Technology → Communication Equipment | Y |
| `ULTA` | Ulta Beauty | Equity | Consumer Cyclical → Specialty Retail | Y |
| `UNG` | United States Natural Gas Fund, LP | ETF | Index / Sector / Thematic | Y |
| `UNH` | UnitedHealth Group Incorporated | Equity | Healthcare → Healthcare Plans | I |
| `UNP` | Union Pacific | Equity | Industrials → Railroads | Y |
| `UPRO` | ProShares UltraPro S&P500 | ETF | Leveraged & Inverse | Y |
| `UPS` | United Parcel Service | Equity | Industrials → Integrated Freight & Logistics | I |
| `UPST` | Upstart Holdings | Equity | Financial Services → Credit Services | Y |
| `UPWK` | Upwork | Equity | Communication Services → Internet Content & Information | Y |
| `URA` | Global X Uranium ETF | ETF | Index / Sector / Thematic | Y |
| `URI` | United Rentals | Equity | Industrials → Rental & Leasing Services | Y |
| `URNM` | Sprott Uranium Miners ETF | ETF | Index / Sector / Thematic | Y |
| `USB` | U.S. Bancorp | Equity | Financial Services → Banks - Regional | I |
| `UVXY` | ProShares Ultra VIX Short-Term Futures ETF | ETF | Leveraged & Inverse | Y |
| `V` | Visa | Equity | Financial Services → Credit Services | Y |
| `VALE` | Vale | Equity | Basic Materials → Other Industrial Metals & Mining | Y |
| `VECO` | Veeco Instruments | Equity | Technology → Semiconductor Equipment & Materials | Y |
| `VEEV` | Veeva Systems | Equity | Healthcare → Health Information Services | I |
| `VGK` | Vanguard FTSE Europe ETF | ETF | Index / Sector / Thematic | Y |
| `VGT` | Vanguard Information Technology Index Fund ETF Shares | ETF | Index / Sector / Thematic | Y |
| `VICI` | VICI Properties | Equity | Real Estate → REIT - Diversified | I |
| `VIPS` | Vipshop Holdings Limited | Equity | Consumer Cyclical → Internet Retail | Y |
| `VIRT` | Virtu Financial | Equity | Financial Services → Capital Markets | Y |
| `VIS` | Vanguard Industrials Index Fund ETF Shares | ETF | Index / Sector / Thematic | Y |
| `VIXY` | ProShares VIX Short-Term Futures ETF | ETF | Leveraged & Inverse | Y |
| `VKTX` | Viking Therapeutics | Equity | Healthcare → Biotechnology | Y |
| `VLO` | Valero Energy | Equity | Energy → Oil & Gas Refining & Marketing | Y |
| `VLRS` | Controladora Vuela Compañía de Aviación, S.A.B. de C.V. | Equity | Industrials → Airlines | Y |
| `VLTO` | Veralto | Equity | Industrials → Pollution & Treatment Controls | I |
| `VMC` | Vulcan Materials | Equity | Basic Materials → Building Materials | Y |
| `VMRK` | — | Equity | Unclassified | I |
| `VNOM` | Viper Energy | Equity | Energy → Oil & Gas Midstream | Y |
| `VOX` | Vanguard Communication Services Index Fund ETF Shares | ETF | Index / Sector / Thematic | Y |
| `VRSK` | Verisk Analytics | Equity | Industrials → Consulting Services | I |
| `VRSN` | VeriSign | Equity | Technology → Software - Infrastructure | I |
| `VRT` | Vertiv Holdings Co | Equity | Industrials → Electrical Equipment & Parts | Y |
| `VRTX` | Vertex Pharmaceuticals Incorporated | Equity | Healthcare → Biotechnology | Y |
| `VSCO` | — | — | Delisted | Y |
| `VST` | Vistra | Equity | Utilities → Utilities - Independent Power Producers | Y |
| `VTR` | Ventas | Equity | Real Estate → REIT - Healthcare Facilities | Y |
| `VTRS` | Viatris | Equity | Healthcare → Drug Manufacturers - Specialty & Generic | I |
| `VTSAX` | Vanguard MStar Total Stk Mkt Idx Admiral | Fund | Mutual Fund | Y |
| `VTWO` | Vanguard Russell 2000 Index Fund ETF Shares | ETF | Index / Sector / Thematic | Y |
| `VTWV` | Vanguard Russell 2000 Value Index Fund ETF Shares | ETF | Index / Sector / Thematic | Y |
| `VYGVF` | — | — | Delisted | Y |
| `VZ` | Verizon Communications | Equity | Communication Services → Telecom Services | Y |
| `WAB` | Westinghouse Air Brake Technologies | Equity | Industrials → Railroads | Y |
| `WAL` | Western Alliance Bancorporation | Equity | Financial Services → Banks - Regional | Y |
| `WANT` | Direxion Daily Cnsmr Discret Bull 3XShrs | ETF | Index / Sector / Thematic | Y |
| `WAT` | Waters | Equity | Healthcare → Diagnostics & Research | I |
| `WBA` | — | — | Delisted | Y |
| `WBD` | Warner Bros. Discovery | Equity | Communication Services → Entertainment | Y |
| `WCBR` | WisdomTree Cybersecurity Fund | ETF | Index / Sector / Thematic | Y |
| `WDAY` | Workday | Equity | Technology → Software - Application | I |
| `WDC` | Western Digital | Equity | Technology → Computer Hardware | Y |
| `WEAT` | Teucrium Wheat Fund | ETF | Index / Sector / Thematic | Y |
| `WEC` | WEC Energy Group | Equity | Utilities → Utilities - Regulated Electric | I |
| `WEICHY` | — | — | Delisted | Y |
| `WEICY` | — | — | Delisted | Y |
| `WELL` | Welltower | Equity | Real Estate → REIT - Healthcare Facilities | Y |
| `WEN` | The Wendy's | Equity | Consumer Cyclical → Restaurants | Y |
| `WFC` | Wells Fargo & | Equity | Financial Services → Banks - Diversified | Y |
| `WHR` | Whirlpool | Equity | Consumer Cyclical → Furnishings, Fixtures & Appliances | Y |
| `WIMI` | WiMi Hologram Cloud | Equity | Communication Services → Advertising Agencies | Y |
| `WISE` | Themes Generative Artificial Intelligence ETF | ETF | Index / Sector / Thematic | Y |
| `WIT` | Wipro Limited | Equity | Technology → Information Technology Services | Y |
| `WM` | Waste Management | Equity | Industrials → Waste Management | I |
| `WMB` | The Williams Companies | Equity | Energy → Oil & Gas Midstream | I |
| `WMT` | Walmart | Equity | Consumer Defensive → Discount Stores | Y |
| `WRB` | W. R. Berkley | Equity | Financial Services → Insurance - Property & Casualty | I |
| `WSM` | Williams-Sonoma | Equity | Consumer Cyclical → Specialty Retail | I |
| `WST` | West Pharmaceutical Services | Equity | Healthcare → Medical Instruments & Supplies | I |
| `WTI` | W&T Offshore | Equity | Energy → Oil & Gas E&P | Y |
| `WTW` | Willis Towers Watson Public Limited | Equity | Financial Services → Insurance Brokers | I |
| `WULF` | TeraWulf | Equity | Financial Services → Capital Markets | Y |
| `WY` | Weyerhaeuser | Equity | Real Estate → REIT - Specialty | Y |
| `WYNN` | Wynn Resorts, Limited | Equity | Consumer Cyclical → Resorts & Casinos | Y |
| `XEL` | Xcel Energy | Equity | Utilities → Utilities - Regulated Electric | I |
| `XLB` | State Street Materials Select Sector SPDR ETF | ETF | Index / Sector / Thematic | Y |
| `XLC` | State Street Communication Services Select Sector SPDR ETF | ETF | Index / Sector / Thematic | Y |
| `XLE` | State Street Energy Select Sector SPDR ETF | ETF | Index / Sector / Thematic | Y |
| `XLI` | State Street Industrial Select Sector SPDR ETF | ETF | Index / Sector / Thematic | Y |
| `XLU` | State Street Utilities Select Sector SPDR ETF | ETF | Index / Sector / Thematic | Y |
| `XMAG` | Defiance Large Cap ex-Mag 7 ETF | ETF | Index / Sector / Thematic | Y |
| `XOM` | ExxonMobil Holdings | Equity | Energy → Oil & Gas Integrated | I |
| `XP` | XP | Equity | Financial Services → Capital Markets | Y |
| `XPEV` | XPeng | Equity | Consumer Cyclical → Auto Manufacturers | Y |
| `XYL` | Xylem | Equity | Industrials → Specialty Industrial Machinery | I |
| `XYZ` | Block | Equity | Technology → Software - Infrastructure | Y |
| `YANG` | Direxion Daily FTSE China Bear 3X Shares | ETF | Leveraged & Inverse | Y |
| `YINN` | Direxion Daily FTSE China Bull 3X Shares | ETF | Leveraged & Inverse | Y |
| `YMM` | Full Truck Alliance Co. | Equity | Technology → Software - Application | Y |
| `YQ` | 17 Education & Technology Group | Equity | Consumer Defensive → Education & Training Services | Y |
| `YUM` | Yum! Brands | Equity | Consumer Cyclical → Restaurants | Y |
| `ZBH` | Zimmer Biomet Holdings | Equity | Healthcare → Medical Devices | I |
| `ZBRA` | Zebra Technologies | Equity | Technology → Communication Equipment | I |
| `ZION` | Zions Bancorporation, National Association | Equity | Financial Services → Banks - Regional | Y |
| `ZK` | — | — | Delisted | Y |
| `ZM` | Zoom Communications | Equity | Technology → Software - Application | Y |
| `ZS` | Zscaler | Equity | Technology → Software - Infrastructure | Y |
| `ZSL` | ProShares UltraShort Silver | ETF | Leveraged & Inverse | Y |
| `ZTS` | Zoetis | Equity | Healthcare → Drug Manufacturers - Specialty & Generic | Y |

