# The 60 Most Challenging Tickers to Track

Which of the 933 active universe tickers are closest to falling out of
coverage, and why — ranked from live probe data, not guesswork.

**Written 2026-08-28.** Companion to
[running-universe-hydration-locally.md](running-universe-hydration-locally.md).

---

## Two different questions, easy to conflate

"Hard to track" can mean two different things in this pipeline, and the
previous doc's mention of `SKHY` blurred them:

1. **Already lost** — 50 tickers were deactivated by
   [PR #73](https://github.com/adamaslan/nuwrrrld-portal/pull/73)
   (`chore(universe): prune tickers no data source can ever card`) because
   Alpaca will never serve them at all. They are not in the ranking below —
   they're not "hard," they're **out**.
2. **Still in, but fragile** — the 933 currently active tickers, some of
   which sit right at the edge of the pipeline's own thresholds. This is
   what the table below ranks.

`SKHY` (SK hynix) is case 2, not case 1, and the prune commit says so
explicitly: *"SKHY has 28 bars and traded yesterday: newly listed, short of
the 40-bar minimum, and very much alive."* It was the one ticker **kept**
specifically because it will resolve itself as history accumulates — pruning
it would have been the wrong call the prune already had to reason about
directly.

---

## Where the 981 vs. 933 vs. 60 numbers come from

| Number | What it counts |
|---:|---|
| **983** | Every row ever registered in `ticker_universe` (the 981 in `universe-by-industry.md` was accurate on 2026-08-18; 2 more were added since) |
| **50** | Deactivated by PR #73 — confirmed uncardable, kept in the table (not deleted) for history |
| **933** | Currently active — the universe this document ranks |
| **60** | The most fragile of the 933, below |

None of these numbers are wrong; they answer different questions. If a count
looks off, ask which of the three it's counting.

---

## How difficulty was actually measured

Not inferred from `ticker_cards` alone — that table only shows what already
computed cleanly. Ranking "hardest to track" from it would undercount, because
a ticker that fails outright never gets a row to look degraded in.

Instead: a direct probe of Alpaca's 120-day bar window (the same window
`hydrate-local.mjs` uses) for all 933 active tickers, scored against the
pipeline's own thresholds, hard-coded in `scripts/hydrate-local.mjs` and
`scripts/lib/hydrate-indicators.mjs`:

| Threshold | Value | What breaks below it |
|---|---:|---|
| `MIN_BARS` | 40 | Row becomes `status: "error", error: "insufficient history"` — no card at all |
| MACD cross window | 35 (slow+signal) | `macdCross` silently omitted — the exact `data_quality=0.8` degradation seen in the live table |
| ADX window | 28 | ADX returns `null` |
| Volatility percentile window | 40+ | Returns `null` |

Score components, roughly in order of severity: zero bars or an Alpaca-rejected
symbol (100, hard fail); under 40 bars (90, hard fail — no card is written);
under ~50 bars (60, thin margin above the floor); under 65 bars (30, marginal);
close to the MACD floor specifically (+25, since that's the one degradation
the stored cards already show); any zero-volume trading day in the window
(illiquidity); strings of unchanged closing prices (`flat`, another
illiquidity marker); low median dollar volume; and sub-$5 share price (penny
stocks carry noisier indicator math generally).

**Verified against a live re-run, not just computed:** re-hydrating the
worst offenders confirmed the two hard failures reproduce
(`SKHY`, `VSCO` → `ERROR insufficient history`) while several tickers that
showed `data_quality=0.8` in stored cards (`BBY`, `SCHW`, `SHEL`, `BDX`,
`BBAI`, `SGML`...) computed cleanly on re-run. Those six are **not** in the
table below — see the note after it.

A full `--dry-run` sweep of all 933 (2026-08-28) reproduces this: only
**2 calc-errors**, 0 post-failures, 933 written. The pipeline is far healthier
than the stored `ticker_cards` snapshot alone suggests.

---

## The 60, ranked

| # | Ticker | Type | Name | Bars (120d) | Med $ vol/day | Med px | Zero-vol days | Flat-close days | Score | Why |
|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|
| 1 | `EVGOW` | stock | EVgo, Inc. | 42 | $2k | $0.01 | 0 | 0 | 100 | bars=42 (only 2 above floor); $vol=2k; px=$0.01 |
| 2 | `SKHY` | stock | SK hynix Inc. | 36 | $5048.0M | $155.37 | 0 | 0 | 90 | bars=36<40 HARD-FAIL |
| 3 | `VSCO` | stock |  | 21 | $107.4M | $50.28 | 0 | 0 | 90 | bars=21<40 HARD-FAIL |
| 4 | `YQ` | stock | 17 Education & Technology Gr | 83 | $10k | $2.31 | 3 | 9 | 72 | zeroVol=3d; flatCloses=9d; $vol=10k; px=$2.31 |
| 5 | `UCAR` | stock | U Power Limited | 83 | $284k | $1.19 | 0 | 8 | 48 | flatCloses=8d; $vol=284k; px=$1.19 |
| 6 | `BTCT` | stock | BTC Digital Ltd. | 83 | $195k | $1.10 | 0 | 7 | 47 | flatCloses=7d; $vol=195k; px=$1.10 |
| 7 | `BZFD` | stock | BuzzFeed, Inc. | 83 | $905k | $1.33 | 0 | 4 | 40 | $vol=905k; px=$1.33 |
| 8 | `CXAI` | stock | CXApp Inc. | 83 | $913k | $0.16 | 0 | 0 | 40 | $vol=913k; px=$0.16 |
| 9 | `FEMY` | stock | Femasys Inc. | 83 | $361k | $2.92 | 0 | 2 | 40 | $vol=361k; px=$2.92 |
| 10 | `GFAI` | stock | Guardforce AI Co., Limited | 83 | $107k | $0.40 | 0 | 2 | 40 | $vol=107k; px=$0.40 |
| 11 | `HAIN` | stock | The Hain Celestial Group, In | 83 | $466k | $0.60 | 0 | 0 | 40 | $vol=466k; px=$0.60 |
| 12 | `PRSO` | stock | Peraso Inc. | 83 | $389k | $0.82 | 0 | 1 | 40 | $vol=389k; px=$0.82 |
| 13 | `REBN` | stock | Reborn Coffee, Inc. | 83 | $48k | $1.50 | 0 | 0 | 40 | $vol=48k; px=$1.50 |
| 14 | `RKDA` | stock | Arcadia Biosciences, Inc. | 83 | $40k | $0.70 | 0 | 3 | 40 | $vol=40k; px=$0.70 |
| 15 | `TGE` | stock | The Generation Essentials Gr | 83 | $29k | $0.97 | 0 | 4 | 40 | $vol=29k; px=$0.97 |
| 16 | `WIMI` | stock | WiMi Hologram Cloud Inc. | 83 | $162k | $1.50 | 0 | 5 | 40 | $vol=162k; px=$1.50 |
| 17 | `IQ` | stock | iQIYI, Inc. | 83 | $6.8M | $1.13 | 0 | 9 | 34 | flatCloses=9d; $vol=6.8M; px=$1.13 |
| 18 | `CLNE` | stock | Clean Energy Fuels Corp. | 83 | $2.8M | $1.99 | 0 | 7 | 32 | flatCloses=7d; $vol=2.8M; px=$1.99 |
| 19 | `FDXF` | stock | FedEx Freight Holding Compan | 63 | $196.3M | $150.29 | 0 | 0 | 30 | bars=63 thin margin |
| 20 | `HONA` | stock | Honeywell Aerospace Inc. | 53 | $646.0M | $207.51 | 0 | 3 | 30 | bars=53 thin margin |
| 21 | `SPCX` | stock | Space Exploration Technologi | 54 | $11421.8M | $139.65 | 0 | 0 | 30 | bars=54 thin margin |
| 22 | `BBGI` | stock | Beasley Broadcast Group, Inc | 83 | $578k | $21.00 | 0 | 0 | 25 | $vol=578k |
| 23 | `BITC` | etf | Bitwise Trendwise Bitcoin an | 83 | $63k | $37.86 | 0 | 5 | 25 | $vol=63k |
| 24 | `BTF` | etf | CoinShares Bitcoin and Ether | 83 | $82k | $17.45 | 0 | 0 | 25 | $vol=82k |
| 25 | `EEV` | etf | ProShares UltraShort MSCI Em | 83 | $268k | $11.36 | 0 | 0 | 25 | $vol=268k |
| 26 | `ELM` | etf | Elm Market Navigator ETF | 83 | $541k | $29.17 | 0 | 0 | 25 | $vol=541k |
| 27 | `FBIO` | stock | Fortress Biotech, Inc. | 83 | $1.3M | $2.82 | 0 | 1 | 25 | $vol=1.3M; px=$2.82 |
| 28 | `FKU` | etf | First Trust United Kingdom A | 83 | $99k | $53.99 | 0 | 0 | 25 | $vol=99k |
| 29 | `FLMX` | etf | Franklin FTSE Mexico ETF | 83 | $248k | $37.36 | 0 | 0 | 25 | $vol=248k |
| 30 | `MYY` | etf | ProShares Short MidCap400 | 83 | $34k | $15.30 | 0 | 2 | 25 | $vol=34k |
| 31 | `QNC` | stock | Quantum eMotion Corp. | 83 | $1.6M | $2.77 | 0 | 4 | 25 | $vol=1.6M; px=$2.77 |
| 32 | `QSI` | stock | Quantum-Si incorporated | 83 | $3.3M | $0.88 | 0 | 0 | 25 | $vol=3.3M; px=$0.88 |
| 33 | `SBB` | etf | ProShares Short SmallCap600 | 83 | $17k | $22.42 | 0 | 0 | 25 | $vol=17k |
| 34 | `SDP` | etf | ProShares UltraShort Utiliti | 83 | $80k | $21.92 | 0 | 0 | 25 | $vol=80k |
| 35 | `SEMI` | etf | Columbia Select Technology E | 83 | $307k | $38.12 | 0 | 0 | 25 | $vol=307k |
| 36 | `SKF` | etf | ProShares UltraShort Financi | 83 | $370k | $24.93 | 0 | 0 | 25 | $vol=370k |
| 37 | `SMDD` | etf | ProShares UltraPro Short Mid | 83 | $58k | $7.96 | 0 | 0 | 25 | $vol=58k |
| 38 | `SPAM` | etf | Themes Cybersecurity ETF | 83 | $70k | $40.90 | 0 | 0 | 25 | $vol=70k |
| 39 | `SPWR` | stock | SunPower Inc. | 83 | $2.1M | $0.64 | 0 | 1 | 25 | $vol=2.1M; px=$0.64 |
| 40 | `SZK` | etf | ProShares UltraShort Consume | 83 | $24k | $21.05 | 0 | 0 | 25 | $vol=24k |
| 41 | `TACK` | etf | Fairlead Tactical Sector Fun | 83 | $418k | $31.69 | 0 | 0 | 25 | $vol=418k |
| 42 | `UCYB` | etf | ProShares Ultra Nasdaq Cyber | 83 | $363k | $76.13 | 0 | 0 | 25 | $vol=363k |
| 43 | `WISE` | etf | Themes Generative Artificial | 83 | $178k | $37.95 | 0 | 0 | 25 | $vol=178k |
| 44 | `WIT` | stock | Wipro Limited | 83 | $17.5M | $1.97 | 0 | 6 | 21 | flatCloses=6d; px=$1.97 |
| 45 | `BBAI` | stock | BigBear.ai Holdings, Inc. | 83 | $106.4M | $3.52 | 0 | 1 | 15 | px=$3.52 |
| 46 | `BLDP` | stock | Ballard Power Systems Inc. | 83 | $22.7M | $3.46 | 0 | 3 | 15 | px=$3.46 |
| 47 | `BYND` | stock | Beyond Meat, Inc. | 83 | $20.9M | $0.71 | 0 | 0 | 15 | px=$0.71 |
| 48 | `GRAB` | stock | Grab Holdings Limited | 83 | $160.5M | $3.58 | 0 | 1 | 15 | px=$3.58 |
| 49 | `LAC` | stock | Lithium Americas Corp. | 83 | $35.8M | $3.79 | 0 | 1 | 15 | px=$3.79 |
| 50 | `LAES` | stock | SEALSQ Corp | 83 | $40.1M | $2.87 | 0 | 1 | 15 | px=$2.87 |
| 51 | `MSTU` | etf | T-Rex 2X Long MSTR Daily Tar | 83 | $162.9M | $2.43 | 0 | 3 | 15 | px=$2.43 |
| 52 | `NIO` | stock | NIO Inc. | 83 | $129.0M | $4.97 | 0 | 2 | 15 | px=$4.97 |
| 53 | `NVD` | etf | Graniteshares 2x Short NVDA  | 83 | $321.5M | $4.75 | 0 | 1 | 15 | px=$4.75 |
| 54 | `OKLL` | etf | Defiance Daily Target 2X Lon | 83 | $58.7M | $4.78 | 0 | 2 | 15 | px=$4.78 |
| 55 | `QBTZ` | etf | Defiance Daily Target 2X Sho | 83 | $16.4M | $4.29 | 0 | 0 | 15 | px=$4.29 |
| 56 | `RGTZ` | etf | Defiance Daily Target 2X Sho | 83 | $19.0M | $3.96 | 0 | 0 | 15 | px=$3.96 |
| 57 | `RKLZ` | etf | Defiance Daily Target 2X Sho | 83 | $39.7M | $3.12 | 0 | 1 | 15 | px=$3.12 |
| 58 | `RXRX` | stock | Recursion Pharmaceuticals, I | 83 | $56.8M | $3.26 | 0 | 2 | 15 | px=$3.26 |
| 59 | `TIGR` | stock | UP Fintech Holding Limited | 83 | $12.3M | $4.80 | 0 | 1 | 15 | px=$4.80 |
| 60 | `TZA` | etf | Direxion Daily Small Cap Bea | 83 | $949.8M | $4.71 | 0 | 2 | 15 | px=$4.71 |

**Reading the table:** Score is relative severity, not a probability of
failure — it exists to rank, not to threshold. Only rows tagged `HARD-FAIL`
(`SKHY`, `VSCO`) actually failed to card on the live re-run; everything else
computed a real card but sits closer to one of the four thresholds above than
the rest of the universe.

---

## Why 6 previously-degraded tickers aren't on this list

The stored `ticker_cards` table currently shows 14 rows at
`data_quality=0.8` (missing `macdCross`): `BBAI`, `BBBY`, `BBGI`, `BBVA`,
`BBY`, `BDX`, `BEN`, `BG`, `SCHW`, `SGML`, `SHAK`, `SHEL`, `SHMD`, `VSCO`
— all from the **same run** (`bar_date=2026-08-18`), and all falling into
**four consecutive 10-symbol chunks** (chunk indices 8, 9, 59, 60 in the
alphabetically-sorted stock lane). That clustering — not the tickers'
individual liquidity — is the signal: it points at something that happened
to those specific chunks during that specific run (a partial API response, a
timing edge at the 35-bar MACD floor that day, or similar), not a durable
property of `BBY` or `SCHW`, both of which are among the most liquid, easiest
to track names in the entire universe.

Re-running `node scripts/hydrate-local.mjs --symbols=BBY,BDX,SCHW,SHEL,BBAI,SGML --dry-run`
today computed every one cleanly with no `macdCross` gap. **Treat that
14-row cluster as a one-run anomaly to watch for recurrence, not as a
standing list of hard tickers** — which is exactly why they're excluded from
the ranking above and `VSCO`/`SKHY` (the two that stayed genuinely hard on
re-run) are included instead.

If this cluster reappears on a future run at the same chunk boundaries,
that's worth its own investigation — a transient fault that recurs at fixed
positions is usually not transient.

---

## What actually resolves each category

- **Newly listed, under 40 bars** (`SKHY`, and likely `EVGOW`/`VSCO` on some
  days): nothing to fix. They self-resolve as trading days accrue. Re-check
  with the bar-count probe below rather than assuming a fixed date.
- **Illiquid / OTC-adjacent** (low $ volume, flat closes, zero-volume days):
  will likely never fully clear the noise floor. These are candidates for the
  *next* prune pass, using the same live/stale/never/reject classification
  `scripts/prune-universe.mjs` already implements — re-run it against a
  longer window before deciding, per the finding in PR #73 that bar-count
  alone would have pruned a live symbol.
- **Sub-$5 price**: not independently actionable — improves only alongside
  the liquidity issue it usually travels with.

## Re-deriving this ranking

The probe queries Alpaca directly (not `ticker_cards`) so it reflects today's
bar availability, not a stale snapshot:

```bash
# 1. Confirm current failures reproduce
node scripts/hydrate-local.mjs --dry-run 2>&1 | grep -E 'ERROR|calc-errors'

# 2. Check any specific ticker's live bar count against the four thresholds
node scripts/hydrate-local.mjs --symbols=TICKER --dry-run
```

A from-scratch re-rank requires pulling raw bars per symbol (bar count,
median dollar volume, zero-volume days, flat-close days) rather than relying
on `hydrate-local.mjs`'s own output, since it only reports pass/fail, not the
underlying margin. That's a one-off script, not a committed one — this
document is itself the durable record until coverage shifts enough to
re-run it.

---

## Related

- [running-universe-hydration-locally.md](running-universe-hydration-locally.md) — how to run hydration
- `scripts/prune-universe.mjs` — the live/stale/never/reject classifier
- `scripts/hydrate-local.mjs` — `MIN_BARS`, `LOOKBACK_DAYS`, per-symbol error handling
- `scripts/lib/hydrate-indicators.mjs` — RSI/MACD/ADX/volatility window requirements
- `docs/wiki-portal/entity-ticker-universe-pipeline.md` — pipeline entity page, "failure 12" section covers PR #73 in full
