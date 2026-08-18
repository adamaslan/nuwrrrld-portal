# NuWrrrld Small-Model Engine — An Adaptive Loop Designed for Cheap/Free Models

**v1 — 2026-08-12.** Sibling to `nuwrrrld-adaptive-engine.md`. That doc made the loop smarter; this one makes it smarter **on small models** — the free OpenRouter chain, Gemini Flash, Groq-hosted 8B–70B models, GPT-mini-class. The premise: the reason the current engine drifts into mush (10/10 HOLD, silent fallbacks, invented-feeling numbers) isn't model size — it's that the pipeline hands a model a huge fuzzy job. Small models are fine when the job is small and sharp. Design for that, and the free-model chain the Monday automation maintains becomes the *primary* engine, not the fallback.

**The one-sentence thesis: the LLM should never compute, never fetch, and never freestyle — it should classify, rank, and explain, over pre-digested categorical inputs, into schema-locked outputs, with deterministic guardrails on both sides.**

---

## 1. Division of labor: code does math, models do judgment

Small models fail at arithmetic, long-context retrieval, and open-ended synthesis. They're good at classification, short structured reasoning, and explanation. So split every task accordingly:

| Layer | Who | Examples |
|---|---|---|
| Fetch | code | yfinance, Finnhub, options chains |
| Compute | code | RSI, MACD, ADX, IV rank, put/call, breadth, alignment scores |
| Discretize | code | RSI 71.3 → `"overbought"`; MACD hist +3.4 rising → `"bull_momentum"` |
| Classify / rank | **small model** | verdict per symbol, regime label, sentiment bucket |
| Explain | **small model** | 2-sentence narrative per symbol, citing only supplied tokens |
| Validate | code | schema check, citation check, consistency check |
| Adjudicate | **mid model, rarely** | only when small models disagree or guardrails trip |

The current automation asks one model to do all seven layers in one prompt. That's the bug.

---

## 2. Pre-digestion: feed models tokens, not floats

Every signal is computed in code, then **discretized into a small vocabulary** before any model sees it. A small model reasoning over `rsi: "overbought", macd: "bear_cross", trend: "above_200dma", iv_rank: "high"` is dramatically more reliable than one reasoning over four decimals — and it physically cannot miscompute what it never computes.

The signal card, built per symbol per timeframe, entirely in code:

```json
{
  "symbol": "NVDA",
  "timeframe": "daily",
  "price": 188.42,
  "tokens": {
    "rsi": "neutral_bullish",
    "macd": "bull_momentum",
    "trend": "above_50dma_above_200dma",
    "volume": "normal",
    "bollinger": "mid_band",
    "vs_sector": "outperforming",
    "iv_rank": "low",
    "put_call": "neutral",
    "x_sentiment": "positive_low_volume",
    "macro_regime": "risk_on_weak"
  },
  "numeric_appendix": { "rsi": 58.06, "macd_hist": 3.41, "iv_rank": 22 }
}
```

Rules:

- **Fixed vocabulary.** Each token field has an enumerated set of 3–7 values, defined once in `universe.json` (§5) and reused everywhere — prompts, few-shots, validators.
- **The numeric appendix is for the human briefing**, injected back by code after the model responds. The model may echo appendix numbers but the validator (§4) rejects any number in its output that isn't in the appendix — which makes hallucinated statistics mechanically impossible.
- Discretization thresholds live in config, not prompts, so tuning them never touches a prompt.

---

## 3. Small tasks, one at a time: the task ladder

Never send a small model the whole market. Decompose into single-purpose calls, each with a context under ~1,500 tokens and an output under ~150:

1. **Per-symbol verdict** (one call per symbol per timeframe): signal card in → `{action, conviction_bucket, primary_driver, one_liner}` out. Ten symbols × two timeframes = 20 tiny calls; on free/cheap models this costs ~nothing and each call is easy.
2. **Regime vote**: index + context-asset cards in → one regime label + driver out.
3. **Sentiment bucketing**: raw X posts in batches of 10 → per-post `{bullish|bearish|neutral, confidence}`; code aggregates the score. Never ask a small model to "summarize sentiment overall."
4. **Cross-timeframe reconcile**: the 20 verdicts (already structured, tiny) in → per-symbol alignment note out ("daily bullish vs weekly bearish → wait for weekly confirm").
5. **Narrative assembly**: top-N structured verdicts in → briefing prose out. This is the only "writing" task, and it's paste-and-polish, not analysis.

Each rung has its own prompt template with 2–3 few-shot examples using the exact token vocabulary and exact output schema. Few-shots matter more for small models than any instruction paragraph.

**Forced distribution guardrail:** the verdict prompt requires ranking, not just labeling — "of these 10 symbols, identify the 2 strongest and 2 weakest regardless of overall lean." Small models default to the safe middle (that's your 10/10 HOLD); ranking makes uniform mush structurally impossible.

---

## 4. Guardrails: the sandwich around every model call

Every call sits between deterministic pre- and post-processing:

**Before (code):**
- Schema-check the inputs; if a signal card is incomplete, the call doesn't happen — the symbol is marked `insufficient_data`, never guessed.
- Data freshness gate: quotes older than X hours → the run is labeled `degraded` in the briefing, loudly (the fix for July's silent-fallback month).

**After (code), in order:**
1. **Schema validation.** Output must parse against the JSON schema (enums only for action/conviction). On failure: one retry with the parse error appended. On second failure: **rules-based fallback verdict** — a deterministic function from the token card (e.g. 2+ bearish tokens on rising volume → SELL-lean) — labeled `"source": "rules"` in the briefing. The pipeline literally cannot fail to produce a verdict, and never silently.
2. **Citation check.** Every number in the output must appear in the numeric appendix; every claim token must appear in the input card. Violations → strip or retry.
3. **Consistency check.** Verdict must be *reachable* from the tokens: a BUY with `rsi: overbought` + `macd: bear_cross` + no positive token is rejected with the contradiction named, and retried once.
4. **Conviction caps.** Conviction is capped by measured factors the model doesn't control: signal-family alignment score, data freshness, and that symbol's rolling hit-rate from the scorer. A small model can *propose* "high" but only earn it when the record supports it.
5. **Damping.** Regime flips require two consecutive runs agreeing before any alert fires; verdict flips on a symbol within 48h are flagged `whipsaw_watch` instead of broadcast.
6. **Options gate.** Any options suggestion must be defined-risk (spread), on an `options.underlyings` symbol, consistent with the IV token (no premium-selling suggestions when `iv_rank: low`), educational framing, never sizing. Checked by regex + schema, not model goodwill.

---

## 5. The universe file: swap stocks / ETFs / options without touching prompts

Same `universe.json` idea as the adaptive-engine doc, extended with the small-model machinery — vocabulary, thresholds, and per-instrument guardrails all live here, so **changing the universe or the rules never means editing a prompt or an automation**:

```json
{
  "schemaVersion": 2,
  "instruments": [
    { "symbol": "SPY",  "type": "etf",   "role": "index", "enabled": true },
    { "symbol": "NVDA", "type": "stock", "role": "core",  "enabled": true,
      "guardrails": { "max_conviction": "high", "earnings_blackout_days": 2 } },
    { "symbol": "IBIT", "type": "etf",   "role": "spec",  "enabled": true,
      "guardrails": { "max_conviction": "medium", "note": "vol haircut always" } },
    { "symbol": "TSLA", "type": "stock", "role": "spec",  "enabled": false }
  ],
  "options": {
    "enabled": true,
    "underlyings": ["SPY", "QQQ", "NVDA"],
    "structures_allowed": ["vertical_spread", "iron_condor"],
    "hard_rules": ["defined_risk_only", "no_sizing", "iv_token_must_match"]
  },
  "vocabulary": {
    "rsi": ["oversold", "neutral_bearish", "neutral", "neutral_bullish", "overbought"],
    "action": ["BUY", "HOLD", "SELL"],
    "conviction": ["low", "medium", "high"]
  },
  "thresholds": { "rsi_overbought": 70, "rsi_oversold": 40, "stale_quote_hours": 6 },
  "models": {
    "ladder": [
      { "tier": "classify", "model": "openrouter:<free-chain-head>", "tasks": ["verdict", "sentiment", "regime_vote"] },
      { "tier": "reconcile", "model": "gemini-flash-free", "tasks": ["cross_timeframe", "narrative"] },
      { "tier": "adjudicate", "model": "zo:deepseek/deepseek-v4-pro", "tasks": ["disputes_only"], "budget_per_day": 2 }
    ]
  }
}
```

- `enabled: false` drops a symbol from every loop, keeps its history.
- Adding options coverage = appending to `underlyings`. Adding an asset class = new `type`; the fetch layer routes by type.
- Per-instrument `guardrails` cap what any model can claim about volatile names — a config-level answer to spec-ticker overconfidence.
- The `models.ladder` is the Monday free-model-chain refresh's real purpose: that automation keeps the `classify` tier pointed at the best currently-free model. Fill in `/root/.free-model-env` and the two systems finally connect.

---

## 6. Escalation: spend big-model tokens only on disagreement

The expensive model is a judge, not a worker:

1. Run the classify tier. Compute per-symbol **dissent**: do daily and weekly verdicts conflict? Did two different free models (run both when free) disagree? Did a guardrail trip twice?
2. **No dissent (typical day: ~8/10 symbols):** small-model verdict stands. Zero big-model tokens.
3. **Dissent:** escalate *only those symbols* to the adjudicate tier with both conflicting outputs + the signal card, capped at `budget_per_day`. The judge picks a side and must name the deciding token.
4. Beyond budget, remaining disputes ship as `"contested"` with both views shown — honest uncertainty beats forced resolution, and "the models disagree on TSLA" is genuinely useful information.

Expected economics: ~25 tiny free calls + 0–2 mid calls per loop, with the full council reasoning reserved for the one daily main briefing — versus today's single monolithic expensive run that still produces mush.

---

## 7. The loops (cadences small models make affordable)

Because each pass is ~25 free micro-calls, more loops cost nothing:

| Loop | When (ET) | Tiers used | Output |
|---|---|---|---|
| Pre-market plan | 8:30 | classify | levels to watch, gap notes → Telegram compact |
| Open check | 10:15 | classify | did the plan survive the open? one-line delta |
| **Main briefing** | 12:15 | all three | full council, visuals, email + site publish |
| Post-close scorer | 16:30 | code only | grade every verdict vs realized close; update hit-rates |
| Weekly calibrator | Sun | reconcile | tune thresholds, retire underperforming tokens, per-model scorecard |

The scorer is what closes the loop for small models specifically: per-model, per-task hit-rates accumulate in `data/performance.json`, the weekly calibrator demotes a free model whose verdict accuracy decays, and conviction caps (§4.4) tighten automatically. The system doesn't need to *trust* small models — it measures them.

---

## 8. Migration order (each step ships alone)

1. Write `universe.json` + vocabulary; point the current automation's step 1 at it. *(1 hr)*
2. Build the discretizer + signal cards in the existing fetch step; add freshness gate + loud `degraded` labeling. *(half day — kills silent fallbacks forever)*
3. Split the monolithic council prompt into the per-symbol verdict task with schema validation + rules fallback. *(half day)*
4. Add the consistency/citation validators and forced-distribution ranking. *(2 hrs — kills 10/10 HOLD)*
5. Add the post-close scorer + hit-rate-driven conviction caps. *(half day)*
6. Wire the model ladder to the free-model chain (fill `/root/.free-model-env`; the Monday automation starts earning its keep). *(1 hr)*
7. Add escalation-on-dissent with a 2/day judge budget. *(2 hrs)*
8. Add the extra loops (pre-market, open check) and the weekly calibrator. *(half day)*

Steps 1–4 alone convert the engine from "one big model doing everything vaguely" to "many small models doing tiny things verifiably" — and every later step is measurement and polish on top of that foundation.
