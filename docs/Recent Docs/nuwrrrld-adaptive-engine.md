# NuWrrrld Adaptive Engine — Design for a Smarter, Self-Correcting Loop

**v1 — 2026-08-12.** Successor design to the current Daily Engine (one run/day, 10 hard-coded tickers, one timeframe, silent fallbacks). Companion to `nuwrrrld-robustness-plan.md` (infrastructure) and `how-i-use-zo.md` (current state). This doc covers the *intelligence* layer: more loops, more signals, more timeframes, and a config file so the universe (stocks / ETFs / options) changes without touching any automation.

The three design principles, each fixing a real observed failure:

1. **Config over code.** The watchlist lived inside the automation instruction, so changing it meant editing a prompt. Now it lives in one JSON file.
2. **Loops over a single daily shot.** One 12:15 PM run means stale-by-open data and no reaction to anything. Multiple cheap passes at different cadences build a layered picture.
3. **Fail loud, learn from the record.** The engine ran on fallback for a month without saying so. Every run now grades itself, and yesterday's accuracy feeds tomorrow's confidence.

---

## 1. The config file: `site_data/universe.json`

One file defines everything tradeable. Every loop reads it at the start of every run — so changing the universe is editing a file (or telling Zo "add PLTR to the watchlist"), never editing an automation.

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-08-12T22:00:00Z",
  "instruments": [
    { "symbol": "SPY",  "type": "etf",   "role": "index",  "enabled": true,  "weight": 1.0 },
    { "symbol": "QQQ",  "type": "etf",   "role": "index",  "enabled": true,  "weight": 1.0 },
    { "symbol": "NVDA", "type": "stock", "role": "core",   "enabled": true,  "weight": 1.2 },
    { "symbol": "AAPL", "type": "stock", "role": "core",   "enabled": true,  "weight": 1.0 },
    { "symbol": "GLD",  "type": "etf",   "role": "hedge",  "enabled": true,  "weight": 0.8 },
    { "symbol": "IBIT", "type": "etf",   "role": "spec",   "enabled": true,  "weight": 0.6 },
    { "symbol": "TSLA", "type": "stock", "role": "spec",   "enabled": false, "weight": 0.6,
      "note": "disabled 2026-08-12 — chop; re-enable after earnings" }
  ],
  "options": {
    "enabled": true,
    "underlyings": ["SPY", "QQQ", "NVDA"],
    "signals": ["put_call_ratio", "iv_rank", "unusual_volume", "max_pain"],
    "suggest_structures": true,
    "max_risk_note": "defined-risk structures only (spreads), educational framing, never sizing advice"
  },
  "context_assets": ["^VIX", "^TNX", "DX-Y.NYB", "CL=F", "BTC-USD"],
  "timeframes": {
    "intraday": { "enabled": true,  "bars": "15m", "lookback_days": 5 },
    "daily":    { "enabled": true,  "bars": "1d",  "lookback_days": 200 },
    "weekly":   { "enabled": true,  "bars": "1wk", "lookback_days": 730 },
    "monthly":  { "enabled": true,  "bars": "1mo", "lookback_days": 1825 }
  },
  "thresholds": {
    "rsi_overbought": 70, "rsi_oversold": 40,
    "vix_riskoff": 25, "vix_riskon": 20,
    "conviction_floor": 0.55,
    "note": "auto-tuned monthly by the calibration loop (§4); manual edits win until next tune"
  }
}
```

Rules:

- `enabled: false` keeps an instrument's history but drops it from scoring — nothing else to clean up.
- `role` drives how the council weighs it: `index` anchors regime, `core` gets full analysis, `hedge` is read contrarian, `spec` gets a volatility haircut on confidence.
- Adding an option underlying = appending to `options.underlyings`. Adding a new asset class (futures, FX, crypto) = a new `type` value; the fetch layer routes by type.
- The briefing JSON records which universe version produced it (`universeUpdatedAt`), so backtests stay honest when the list changes.

---

## 2. The signal stack: five families, cross-checked

Today's engine uses one family (RSI/MACD daily) plus a macro score. The adaptive engine gathers five, and — the important part — **scores their agreement**. Five bullish technicals mean less if breadth and options flow disagree.

| Family | Signals | Source (free) | Timeframes |
|---|---|---|---|
| **Technicals** | RSI, MACD, ADX, Bollinger, 50/200 MA cross, volume ratio | yfinance | intraday, daily, weekly, monthly |
| **Macro** | Fed tone, CPI/PCE surprises, yield curve (^TNX), DXY, oil | web_research + yfinance | daily, weekly |
| **Sentiment** | X cashtag score + mention velocity, fear/greed proxies | x_search | intraday, daily |
| **Breadth & flow** | % of universe above 50-DMA, new highs–lows, sector rotation | computed from universe | daily, weekly |
| **Options flow** | put/call ratio, IV rank vs 52-wk range, unusual volume, max pain | yfinance option chains | daily |

Per instrument, per timeframe, each family emits a score in [-1, +1]. Then:

- **Alignment score** = weighted agreement across families. High alignment → conviction; disagreement → the verdict is capped at HOLD and the *disagreement itself* becomes the story ("technicals bullish but IV rank 92nd percentile and put/call spiking — someone is paying up for protection").
- **Timeframe stack** = the same verdict computed at each enabled timeframe. A BUY on daily inside a SELL on weekly gets labeled `counter-trend bounce`, not `BUY`. The composed verdict is explicit about horizon: `swing (1–10d)`, `position (2–12w)`, `investment (6m+)`.
- **Regime** is no longer a single label — it's a vector: `{ intraday: "Risk-On", weekly: "Transitioning", monthly: "Risk-On" }` plus one composed headline. Flips are only alerted when the *weekly* regime flips (kills the daily Risk-On↔Transitioning noise visible in the delivery log).

---

## 3. The loop structure: four cadences instead of one

Not one big run — four small ones, each cheap, each reading the previous one's output. All on Zo automations; all write to the same day's working file `site_data/intraday/<date>.json` so state accumulates through the day.

| Loop | When (ET) | Model tier | Job |
|---|---|---|---|
| **Pre-market brief** | 8:30 AM daily | full (council) | Overnight futures, Asia/Europe, gap analysis vs yesterday's verdicts, today's catalysts (earnings, data prints). Produces the *plan*. |
| **Open check** | 10:15 AM daily | cheap/fast | Did the open confirm or violate the pre-market plan? One paragraph delta only. Telegram only, and **only if** something violated the plan (else silent). |
| **Main briefing** | 12:15 PM daily | full (council) | Full five-family, multi-timeframe run → briefing.json v3 → site + email + Telegram. This is today's engine, upgraded. |
| **Post-close scorer** | 5:00 PM daily | cheap/fast | Grade every open verdict against closing prices. Append to `data/scorecard.jsonl`. No delivery unless hit-rate drops below floor. |
| **Weekly calibrator** | Sun 6:00 PM | full | Read the whole scorecard: which signal families were right, which thresholds fired badly, propose `thresholds` updates + universe suggestions ("GEV: 6 straight HOLDs, no edge — disable?"). Writes a diff for approval, never auto-applies universe changes. |

Plus one **event-driven trigger** the cron loops can't cover: the main and open-check loops each end by checking VIX and futures against `thresholds`. If VIX > `vix_riskoff` intraday or a weekly regime flip is detected, the run sends an immediate alert instead of waiting for the next scheduled pass. (True streaming triggers would need one of the free-tier pipelines from `how-i-use-zo.md` §10 — a Cloudflare Worker cron every 15 min checking one number is comfortably free — but the four-loop version needs nothing beyond Zo.)

Cost control: the two cheap loops use a fast model and are instructed to stay silent when nothing changed. The expensive council reasoning runs twice a day, not five times.

---

## 4. The AI layer: council that argues, memory that calibrates

Where "smarter" actually lives:

**Adversarial council.** Instead of one model writing both views, the main briefing runs three passes: a **bull brief** (strongest data-cited case up), a **bear brief** (strongest case down), and a **judge** pass that reads both plus the alignment scores and issues the verdict with explicit "what would change my mind" levels (e.g. "BUY invalidated below $171.50 — the 50-DMA"). Disagreement between bull and bear that the judge can't resolve = automatic HOLD with `contested: true` flagged in the briefing. Same tools, same data — just three prompts instead of one, and it kills the mushy single-voice consensus that produced 10/10 HOLDs.

**Calibrated confidence.** Confidence is no longer the model's vibe. The scorer (§3) tracks realized hit-rate *per signal family, per timeframe, per confidence bucket*. The council receives this table every run: "your high-confidence daily technical calls hit 48% over 30 days — that is a coin flip; stop issuing high confidence on that family." Confidence becomes a claim the system audits, and the weekly calibrator turns persistent miscalibration into threshold changes.

**Memory of theses, not just verdicts.** Each verdict carries a short thesis and invalidation level into `data/theses.jsonl`. The next run's first job is checking open theses against reality — *"you said NVDA holds above $171.50; it closed $168.90 — the thesis is invalidated, say so and flip or explain."* This is the difference between a daily hot take and a position that's actually tracked.

**Data-source health, fail-loud.** Every fetch records source + freshness into the briefing's `provenance` block. If a primary source dies (the GCP digest lesson), the run continues on fallback **and** the delivery subject line says so: `NuWrrrld Daily — Risk-On | ⚠ degraded (fallback data)`. Three consecutive degraded runs trigger a separate "fix me" email listing exactly what's broken. Silence is never an acceptable failure mode again.

---

## 5. Options, concretely

Free options data via yfinance chains is enough for a signal layer (not an execution layer):

- **Per-underlying dashboard row:** put/call volume ratio, IV rank (current IV vs 52-week range), open-interest walls (nearest big strikes = magnet/max-pain levels), unusual volume flags.
- **As a signal:** IV rank feeds the council as a *contrarian volatility* input — IV rank > 80 with bullish technicals reads as "upside is expensive; market expects the move," and caps conviction.
- **As output (when `suggest_structures: true`):** for the top pick and top risk, the briefing names one defined-risk structure consistent with the verdict and IV context — e.g. "BUY + IV rank 25 → call debit spread profile fits; SELL + IV rank 85 → put spread over long puts (vol is rich)." Always spreads, always educational framing, never sizing. The scorer grades these too (did the structure's thesis pay?), so the calibration loop covers options claims the same as equity calls.

Turning all of this off is one flag: `options.enabled: false`.

---

## 6. Briefing schema v3 (delta from v2)

```
+ universeUpdatedAt        // which watchlist produced this
+ regime: {intraday, daily, weekly, monthly, composed}   // was: single string
+ signals[].timeframes: {daily: {...}, weekly: {...}}    // per-TF verdicts
+ signals[].alignment      // cross-family agreement, -1..1
+ signals[].horizon        // swing | position | investment
+ signals[].invalidation   // price level that kills the thesis
+ signals[].contested      // bull/bear judge couldn't resolve
+ council: {bull, bear, judge, what_would_change_my_mind}
+ options: [{symbol, put_call, iv_rank, oi_walls, structure_idea}]
+ provenance: [{source, fetchedAt, status}]              // fail-loud block
+ calibration: {hit_rate_30d, by_family, by_confidence}  // from scorecard
```

The site reads v3 with graceful fallback to v2 fields, so the frontend never breaks mid-migration.

---

## 7. Migration order (each step ships alone)

1. **Universe file** — extract the hard-coded list into `universe.json`; point the current engine at it. Zero behavior change, immediate configurability. *(30 min)*
2. **Fail-loud provenance** — the ⚠-degraded subject line + fix-me email. Would have caught the July silent fallback in one day. *(1 hr)*
3. **Post-close scorer** — new small automation; starts accumulating the scorecard that everything in §4 depends on. *(1–2 hrs)*
4. **Multi-timeframe technicals** — weekly + monthly bars into the existing signal step; regime becomes a vector. *(half day)*
5. **Adversarial council** — bull/bear/judge prompts replace the single council prompt. *(half day)*
6. **Pre-market + open-check loops** — the two new cadences. *(half day)*
7. **Options layer** — chains, IV rank, structures. *(1 day)*
8. **Weekly calibrator** — closes the self-tuning loop. Last because it needs ~30 days of scorecard data to say anything. *(half day, then wait)*

Steps 1–3 are the highest value-per-effort in the whole doc: config, honesty, and memory. Everything else is leverage on top of those three.
