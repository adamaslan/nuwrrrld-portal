# Top 10 Deficiencies Blocking Credible Stock Recommendations

**Written 2026-09-15**, from evidence gathered during a full 933-ticker `locrun` scan
(929 resolved) plus a codebase audit of `lib/`, `app/`, and `deploy/universe-hydration/`.

The engine is *internally sound* — all twelve inverse/leveraged ETF mirror pairs in the
universe resolved opposite as they mechanically must, so the indicator math is not
reading noise. Everything below is about what sits **around** that math. The ranking is
by how hard each item blocks the sentence *"the app recommends this stock"*, not by
implementation effort.

Companion to [universe-by-industry.md](universe-by-industry.md) and
[risk-off-rotation.html](risk-off-rotation.html) (the scan this came from).

---

## 1. Recommendations rest on four booleans and nothing else

`ai_score = 50 + (bullish − bearish) × 12.5` over exactly four tests: RSI > 55,
MACD histogram > 0, price > SMA20, volume > 1.2×. That is the entire basis on which a
symbol becomes a BUY.

Consequences, both observed in the live scan:

- **Only nine possible scores exist** (0, 12, 25, 38, 50, 62, 75, 88, 100). 24 stocks
  tied at a perfect 100, so any "top 10" is decided by an arbitrary tiebreak, not the model.
- **All four signals weigh the same.** A 1.2× volume blip counts exactly as much as a
  MACD cross, and no weight was fit to anything.

Reproduce the tie problem:

```bash
cd /Users/adamaslan/code/nuwrrrld-portal
mamba run -n fin-ai1 python /Users/adamaslan/code/homebase/locrun.py \
  --universe all --no-firestore --no-gcp3 --no-finnhub --output /tmp 2>/dev/null \
  | grep -oE 'score= *[0-9]+' | sort | uniq -c | sort -rn
```
Expect: a handful of discrete buckets, never a continuous distribution.

**What it needs:** a continuous score with fitted weights, and a documented rationale for
each input's contribution.

---

## 2. No fundamentals of any kind exist in the codebase

An audit for the vocabulary of company analysis returns nothing:

```bash
cd /Users/adamaslan/code/nuwrrrld-portal
for k in '\bearnings\b' '\bpeRatio\b|\bpe_ratio\b' '\bmarketCap\b|\bmarket_cap\b' '\brevenue\b' '\bfcf\b|free_cash_flow'; do
  printf "%-34s %s\n" "$k" "$(grep -rliE "$k" lib app --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules | wc -l | tr -d ' ')"
done
```
Expect: `0` for every row. (Word boundaries matter here — an unanchored `valuation`
matches the word *evaluation* in unrelated comments, and an unanchored `atr` matches
inside ordinary words. Both produced false hits during this audit.)

Without earnings, valuation, revenue growth, debt, or margins, the app cannot distinguish
a cheap compounder from a value trap, and a recommendation is a statement about *price
history only*. A falling knife with a bounce scores identically to a healthy uptrend.

**What it needs:** at minimum a market-cap and earnings-date field per symbol before any
output is framed as a recommendation.

---

## 3. Nothing validates that the score predicts anything

`lib/backtest.ts` exists and is **disabled by default** — it requires `SIGNALS_ENGINE_URL`,
and every call returns `null` when unset. It is also a client for a *separate* FastAPI
service, not an in-repo backtester.

```bash
cd /Users/adamaslan/code/nuwrrrld-portal
grep -c '^SIGNALS_ENGINE_URL=.\+' .env.local || echo "unset — all backtest calls return null"
```
Expect: `0` / `unset`.

So there is **no hit rate, no forward-return study, and no calibration** for the scoring
model. "Score 100" carries no evidenced probability of anything. This is the single
largest gap between the current output and a recommendation.

**What it needs:** an in-repo forward-return harness — for each historical bar, the score
and the realized N-day return — producing a hit rate per score bucket.

---

## 4. 81% of the universe has no sector, so concentration is invisible

Sector data exists only as a hand-maintained TypeScript literal in
`lib/shared/paper-sectors.ts`, scoped to the paper-portfolio ticker list. `ticker_universe`
itself carries only `universe text CHECK (universe IN ('etf','stock'))` — no sector column
([schema.sql](../lib/db/schema.sql) L353–359).

| Scope | Count | Share |
|---|---:|---:|
| Active universe | 933 | 100% |
| Has a sector in `paper-sectors.ts` | 176 | 18.9% |
| **No sector at all** | **757** | **81.1%** |

The codebase already knows: `lib/portfolio-health-policy.ts:128` states *"only `etf`/`stock`,
not sector, so genuine sector concentration is invisible."*

**This produces a live contradiction — see #5.**

**What it needs:** a `sector` column on `ticker_universe`, populated at seed time from the
same source that supplies names.

---

## 5. A sector cap is configured that cannot be enforced universe-wide

`lib/shared/paper-policy.ts` defines `sectorCapPct` for all six accounts (0.15–0.35), and
`lib/shared/paper-engine-core.ts:178` actively enforces it:

```ts
const room = policy.sectorCapPct - (sectorWeight.get(sector) ?? 0);
```

That enforcement is only as good as `paper-sectors.ts`, whose own header concedes it is
*"a best-effort GICS-style classification… close to, but not a guaranteed exact match"*
for the design doc's aggregate counts. Outside the ~176 mapped tickers there is no sector
to cap against.

```bash
cd /Users/adamaslan/code/nuwrrrld-portal
grep -rn "sectorCapPct" lib --include="*.ts" | grep -v node_modules
```

So a risk control that reads as enforced is, for 81% of the universe, unenforceable — the
most dangerous class of deficiency here, because the guardrail *appears* to exist.

**What it needs:** #4, then a startup assertion that every investable symbol resolves to a
sector, failing loudly rather than defaulting.

---

## 6. No risk model, position sizing, or stop logic

```bash
cd /Users/adamaslan/code/nuwrrrld-portal
grep -rniE '\bATR\b|stop_loss|position_size|\bkelly\b|drawdown' lib app --include="*.ts" | grep -v node_modules
```
Expect **three matches, none of them an implementation**:

| Match | What it actually is |
|---|---|
| `lib/grounding/taxonomy.ts:27` | a *comment* — "e.g. ATR or VIX percentile rank" |
| `lib/analytics.ts:91` | the string `"position_size"` as an analytics **event name** |
| `lib/customer-profile-rules.ts:51` | `position_sizes` classified as a *conversation topic* |

So the vocabulary appears while the capability does not. Volatility itself *is* computed —
`_volatility_percentile()` in `deploy/universe-hydration/modal_app.py` — but it feeds the
confluence score, never a size or a stop.

The scan's own top-10 put **W&T Offshore at $4.13 beside F5 at $430.88 with no size
guidance** — equal-ranked, though one is a microcap whose spread and liquidity make the
signal far less actionable. A recommendation without a size and an invalidation level is
not an executable instruction.

**What it needs:** route the existing volatility percentile into an ATR-derived stop and a
volatility-scaled size, attached to every recommended symbol.

---

## 7. No liquidity or market-cap floor on the universe

Nothing filters by dollar volume, float, or price. Microcaps rank on the same scale as
mega-caps, so the top of the list is systematically biased toward thin names, whose
indicators move on volume that would not fill a real order.

**What it needs:** a minimum median-dollar-volume gate applied before ranking, with the
threshold recorded alongside results.

---

## 8. Upstream failures are logged but never surfaced

Three distinct failures occurred during this session's runs. **All three printed to stdout
and none changed the exit status, the report, or any alert.**

| Failure | Observed | Effect |
|---|---|---|
| Finnhub `/news-sentiment` | HTTP **403**, every symbol | zero sentiment reached any signal |
| GCP3 `/refresh/bake`, `/refresh/ai-summary` | HTTP **401** | live backend never refreshed |
| 4 tickers unresolved | "possibly delisted" | silently absent from output |

The run then reported `Done. 929 signals` — indistinguishable from a clean run. A scan
missing its entire sentiment input should not be able to present as success.

**What it needs:** a per-source health block in the report, and a non-zero exit when a
declared input contributes 0% of expected rows.

---

## 9. Share-class notation diverges between store and vendor

`ticker_universe` stores dot notation (`BRK.B`, `BF.B`) because that is Alpaca's
convention; Yahoo requires a hyphen (`BRK-B`). Passing the dot form to yfinance returns
*"possibly delisted; no price data found"* — **a live mega-cap presenting as a dead
symbol**. Berkshire Hathaway was dropped from a 933-ticker scan this way.

`normalizeTicker` ([lib/shared/signal-policy.ts](../lib/shared/signal-policy.ts) L16–21)
accepts both spellings and canonicalizes neither, so both can register as separate rows —
and both do:

```bash
cd /Users/adamaslan/code/nuwrrrld-portal
node --env-file=.env.local -e "
const {neon}=require('@neondatabase/serverless');const sql=neon(process.env.DATABASE_URL);
sql\`SELECT ticker,active FROM ticker_universe WHERE ticker LIKE '%.%' OR ticker LIKE '%-%' ORDER BY ticker\`.then(r=>console.table(r));"
```
Expect: `BF.B` and `BRK.B` active, `BF-B` and `BRK-B` inactive — four rows for two securities.

**Status:** the *fetch* half is fixed — `to_yahoo_symbol()` in `homebase/locrun.py`
translates at the vendor boundary while still reporting under the upstream spelling
(verified: BRK.B → $516.76, BF.B → $26.18). The **duplicate-row half is still open**, and
canonicalizing `normalizeTicker` is a data-plane key change that needs its own review —
it is used by enqueue, drain, and the watchlist route.

---

## 10. One bar, one timeframe, and a universe that is not an index

Three sampling problems that compound:

- **Single daily close.** No multi-timeframe confirmation; a weekly downtrend is invisible
  to a daily signal.
- **No earnings-date awareness.** A symbol can score 100 the day before a catastrophic print.
- **The universe is a portfolio, not an index.** Per
  [universe-by-industry.md](universe-by-industry.md), the registered set is a Yahoo
  portfolio export (680) unioned with a partial large-cap seed (301), and
  *"there is no index-membership column — `ticker_universe.universe` carries only
  `stock` | `etf`."*

So breadth figures describe *this book*, not the market: they inherit whatever selection
bias the original export carried, and cannot be reproduced against a benchmark.

**What it needs:** an index-membership column so breadth can be computed on a defined
benchmark, plus a weekly-timeframe confirmation input.

---

## Summary

| # | Deficiency | Blocks |
|---|---|---|
| 1 | Four-boolean score, 9 discrete values | ranking credibility |
| 2 | No fundamentals anywhere | distinguishing quality from bounce |
| 3 | Backtest disabled — no validation | any probability claim |
| 4 | 81% of universe has no sector | concentration awareness |
| 5 | `sectorCapPct` enforced on absent data | a risk control that looks real |
| 6 | No sizing, stops, or risk model | executability |
| 7 | No liquidity floor | bias toward unfillable names |
| 8 | Upstream 403/401 fail silently | trusting any given run |
| 9 | Share-class notation split | universe integrity |
| 10 | One bar, non-index universe | generalizing beyond this book |

**The cheapest high-value fixes are #4 (a `sector` column) and #8 (source-health
reporting).** Both are small, both unblock later work, and #8 is what would have made the
other failures in this session visible without a manual audit.

**#3 is the one that matters most.** Until forward returns are measured, every item above
is an argument about plausibility rather than performance — and nothing here should be
called a recommendation.
