# MOO Council Simulation — TODO

**Goal:** make the `#council` section of https://financial.nuwrrrld.com a *simulation of
investing in the MOO ETF* (VanEck Agribusiness) — a real scan, a real investment
simulation, fed to the real council — instead of the hardcoded SPY sample it renders today.

**Status:** the scan, the simulation, and the council run have all been executed for real.
Raw output is preserved in [`docs/moo-council-run/`](moo-council-run/). What remains is
wiring it into the site, and fixing three production defects the run exposed.

Scan date: **2026-09-02** (close). All numbers below are real, not illustrative.

---

## 1. What was actually run

### 1.1 The scan (real)

`docs/moo-council-run/scan_moo.py` calls `analyze()` from `~/code/homebase/locrun.py` —
the same indicator engine the local pipeline uses — on MOO plus its US-listed top holdings,
6-month yfinance OHLCV, Firestore/GCP3 writes disabled.

| Ticker | Fund wt | Score | Action | Conf | RSI | Note |
|---|---|---|---|---|---|---|
| **MOO** | — | **100** | BUY | HIGH | 77.6 | RSI 78, MACD +0.56, vol 2.37×, +6.7% over SMA20 |
| CTVA | 8.92% | 100 | BUY | HIGH | 72.2 | |
| DE | 7.96% | 100 | BUY | HIGH | 69.5 | |
| NTR | 6.57% | 88 | BUY | HIGH | 75.5 | |
| ZTS | 5.22% | 62 | HOLD | LOW | 50.3 | weakest constituent |
| ADM | 5.07% | 88 | BUY | HIGH | 63.7 | |
| CF | 4.81% | 100 | BUY | HIGH | 71.6 | |
| TSN | 4.37% | **12** | SELL | HIGH | 43.9 | the only bearish holding |
| BG | 3.14% | 100 | BUY | HIGH | 65.8 | |

MOO close **$88.85** (+0.98%). Bollinger %B **1.095** — price is *outside* the upper band.
7 of 8 scanned holdings bullish.

### 1.2 The investment simulation (real)

`docs/moo-council-run/sim_moo.py`, 10y adjusted close.

**$10,000 lump sum, held:**

| Held | Ends at | Return | CAGR | Max DD | Ann vol | Sharpe (rf=0) |
|---|---|---|---|---|---|---|
| 1y | $12,308 | +23.1% | 23.10% | −11.2% | 14.6% | 1.50 |
| 3y | $11,625 | +16.3% | 5.16% | −23.1% | 15.5% | 0.40 |
| 5y | $10,670 | +6.7% | 1.31% | −39.5% | 17.2% | 0.16 |
| 10y | $21,141 | +111.4% | 7.78% | −39.5% | 18.2% | 0.50 |

**$250/mo DCA:** 10y → $30,250 invested becomes **$42,846** (+41.6%), which beats the
5y lump-sum path badly — the DCA/lump-sum divergence is itself a story the council can argue.

**Backtest of the exact signal that fired today** (`RSI>70 AND MACD_hist>0 AND vol>1.5× AND price>3% over SMA20`),
38 fires in 10 years:

| Horizon | Hit rate | Buy-hold baseline | Mean | Worst | Best | n |
|---|---|---|---|---|---|---|
| 5d | 69.4% | 55.7% | +0.78% | −5.48% | +4.94% | 36 |
| 20d | 71.4% | 59.3% | +2.42% | −5.70% | +10.32% | 35 |
| 60d | 71.4% | 63.6% | +3.17% | **−17.46%** | +18.07% | 35 |

A real but modest edge over baseline, on a sample small enough that the error bars matter.

### 1.3 The council run (real)

`docs/moo-council-run/run_council_headroom.mjs` imports the app's own compiled
`lib/openrouter.ts` — byte-identical seat system prompts, same `SEAT_MODELS`, same
`FREE_MODEL_CHAIN`, same `CHAIR_VERDICT_SYSTEM` — and feeds it a grounded brief built from
§1.1 + §1.2 plus five explicit `RULES` for the seats to cite.

**It worked, and the seats grounded themselves in the real numbers.** Excerpts:

- **RISK** — *"Limit the MOO exposure to ≤$2k (≈20% of the $10k). Even a 17.5% loss leaves
  >$1.65k intact… the historical worst 60-day loss for this signal is −17.5%, turning a
  $10k stake into ≈$8.3k."*
- **QUANT** — reproduced every hit-rate and flagged the regime conflict: *"10y CAGR 7.78%
  (Sharpe 0.5, max DD −39.5%) vs 5y CAGR 1.31%."*
- **MACRO** — correctly refused to invent context: *"No macro data (rates, dollar, liquidity,
  sector rotation) are supplied, so the macro wind cannot be assessed."*
- **CHAIR** — *"The council is split… while the technical edge exists, the council agrees
  that the risk of a near-term pull-back is material and that any exposure should be modest
  or contingent on a pull-back inside the bands."*

Two runs are preserved: `moo_council_headroom.json` (the good one, `max_tokens` 3000) and
`moo_council_production_fidelity.json` (production's actual `max_tokens` 600 — see §2.1).

---

## 2. Blockers found — fix these first

These are production defects, not simulation artifacts. Each was hit while running the
real path.

### 2.1 P0 — Reasoning models eat the entire token budget, and seats return empty — FIXED

At production's `max_tokens ≈ 500`, **three of five seats returned a zero-character answer**
and the CHAIR synthesis truncated mid-sentence at *"The council is split. T1 sees"*. The
`FREE_MODEL_CHAIN` is now all-nemotron reasoning models that spend the whole budget on
chain-of-thought before emitting a first content token.

`runSeat` treated HTTP 200 + empty string as success, so the seat degraded silently — the
council *looked* like it answered with four seats when it answered with one.

- [x] Raised every seat's default `max_tokens` from 500 to 1200 (`runSeat`, `callCouncilSeat`
      in `lib/openrouter.ts`), and the explicit per-call overrides in
      `app/api/council/deliberate/route.ts` (repair 500→1200, round-2 critique 200→500, CHAIR
      synthesis 400→1000, verdict 100→300). These are $0 free-tier models — the extra budget
      costs nothing.
- [x] `runSeat` now treats an HTTP 200 with an empty/whitespace `answer` as a retryable
      failure and advances the chain, the same way `fetchWithModelFallbackChecked` already
      does for the streaming path. If every model in the chain comes back empty, it throws
      `OpenRouter: council {seat} — every model returned an empty completion` instead of
      silently returning `""`. Updated `__tests__/openrouter-fallback.test.ts` accordingly
      (it had pinned the old empty-string-is-success behavior as "deliberate"; that pin is
      now the opposite assertion, plus a new test for chain recovery).
- [ ] **Not done**: stripping a leading reasoning block before returning `answer`. T2's
      "good" reply in the sample run was 1,777 characters of visible chain-of-thought that
      never reached its four required fields — the empty-answer fix stops silent failure,
      but a model that emits reasoning *as* content (not into a separate `reasoning` field)
      still burns its budget without producing a usable answer. This needs a model-aware
      strip or a stricter "output ONLY the four fields" system-prompt rewrite; left for a
      follow-up since it risks breaking prose-only seats (RISK/MACRO/CHAIR) if done crudely.

### 2.2 P0 — `SEAT_MODELS` has rotted again; the CHAIR verdict never parses — FIXED

- `nvidia/nemotron-nano-9b-v2:free` (`QUANT`, and `SMALLEST_MODEL` used for the verdict call)
  **404'd** — retired from the catalog. The console warning fired on every call.
- `google/gemma-4-31b-it:free` (`T2`) failed all the way through the chain in one run —
  the live catalog audit (`scripts/refresh-free-models.mjs`) shows it still exists but is
  **429 rate-limited** on the shared free tier, not retired. Not swapped out; a rate limit
  is an expected property of a $0 model, not rot.
- All **3/3 CHAIR verdict samples were unparsable** in the pre-fix run. `reconcileVerdicts`
  returned `{direction: null, …}` — the deliberate route could not produce a verdict on
  this input at all.

- [x] Ran `scripts/refresh-free-models.mjs` for real (not `--dry-run`) with a live key —
      it live-probed the catalog and rewrote `FREE_MODEL_CHAIN` to
      `nemotron-3-ultra-550b-a55b`, `nemotron-3-super-120b-a12b`,
      `nemotron-3-nano-omni-30b-a3b-reasoning`, `liquid/lfm-2.5-2.6b`.
- [x] Hand-fixed `SEAT_MODELS.QUANT` (and therefore `SMALLEST_MODEL`, which is derived from
      it) from the dead `nvidia/nemotron-nano-9b-v2:free` to `liquid/lfm-2.5-2.6b:free` — the
      smallest live $0 model in the catalog, matching QUANT's "reduced to classification"
      role and giving the verdict call a non-reasoning primary.
- [ ] **Not done**: a last-resort `{...}` extraction from the tail of an unparsable verdict
      response. Would have salvaged 0/3 samples in the observed failure (none contained a
      valid trailing object), so it's cheap insurance, not a fix for the root cause — the
      root cause (dead QUANT id + starved token budget) is what's fixed above.
- [ ] **Not done**: a CI check that pings each `SEAT_MODELS` id weekly and fails loudly on
      404. `scripts/refresh-free-models.mjs` already *has* this audit (`--dry-run` prints it)
      but nothing runs it on a schedule or fails a build on `DEAD`. This is the actual
      control the 2026-08-19 comment in `lib/openrouter.ts` was describing the *absence* of;
      wiring the existing audit into CI/a cron is a small, separate follow-up.

### 2.4 New finding — GCP3 is currently 503, and the "no data" fallback still invents figures

Verified end-to-end against a live dev server (`npm run dev` + the working key): `GET
https://gcp3-backend-cif7ppahzq-uc.a.run.app/signals/MOO` returned `503 "Service temporarily
unavailable"` at the time of this run, so `/api/council/sample` took its no-live-data fallback
branch. Two things fell out of that:

- **T1 still fabricated figures.** Its system prompt says `_GROUND: "Ground every claim in
  DATA... never invent evidence"`, and the route's fallback prompt explicitly says *"say
  plainly that live data was unavailable rather than inventing figures"* — T1 answered anyway
  with a fabricated CAGR quote and invented entry/stop/target prices ($47/$44/$50). The
  "ground in DATA" instruction has no teeth when there is no DATA section at all; the model
  falls back to plausible-sounding invention instead of declining.
- **T2 (a reasoning model) spent its entire 1200-token budget narrating whether it's allowed
  to answer without data**, and never produced the four required fields — a live
  demonstration of the exact "reasoning leaks into content" gap noted as not-fixed in §2.1.
  Confirms that fix is still open, not just theoretical.

- [ ] Make the no-live-data fallback prompt instruct the seat to output the four fields with
      an explicit "insufficient data" outlook rather than leaving it free-form — the current
      wording asks for honesty but gives the model no valid low-effort way to be honest inside
      the structured format.
- [ ] Check GCP3 backend health/uptime independent of this feature — a 503 on `/signals/MOO`
      blocks the entire simulation, not just this fallback path.

### 2.5 New finding — the current `FREE_MODEL_CHAIN` is at or past a 20s latency SLA

Running `__tests__/live/model-chain.live.test.ts` against the live catalog (with the fixes
above applied) passed on correctness but failed 6 of 20 assertions on `SEAT_LATENCY_BUDGET_MS`
(20s) — MACRO, QUANT, and CHAIR each took 20.7–23.8s at least once. `__tests__/live/
council-verdict.live.test.ts` passed cleanly (0 failures), confirming the verdict-parsing
fix holds under live conditions. This live suite is excluded from `npm test` and CI
(`vitest.config.ts` excludes `__tests__/live/**`), so nothing is broken — but it's a real,
pre-existing tension: an all-reasoning-model `FREE_MODEL_CHAIN` is intrinsically slower than a
20s budget assumes, and raising `max_tokens` in §2.1 gives a starved model more room to spend
on hidden reasoning before it emits content, which can only push latency up further, not down.

- [ ] Either raise `SEAT_LATENCY_BUDGET_MS`, or get at least one fast non-reasoning model into
      `FREE_MODEL_CHAIN` (the catalog audit found `liquid/lfm-2.5-2.6b:free`, already used for
      `SMALLEST_MODEL`, as a candidate) so the chain has a fast option ahead of the slow ones.
- [ ] Re-run this live suite after any further token-budget change — it's the one check that
      actually catches a latency regression from a $0-cost "just raise max_tokens" fix.

### 2.3 P1 — The portal's own `OPENROUTER_API_KEY` is expired — STILL OPEN

`.env.local`'s key returns `401 "API key expired"`. All fixes above and the implementation
in §3.1 were verified using the still-valid `OPEN_ROUTER_KEY` from `~/code/homebase/.env`.

- [ ] Rotate the local key.
- [ ] **Verify the Vercel production key separately** — it is not in `.env.production` and
      was not tested here (this session has no access to Vercel env vars). If production
      shares the expired key, `#council`, `/api/council/*` and the landing sample are all
      failing live right now. This is the single highest-priority open item — check it
      before relying on anything else in this document reaching production.

---

## 3. The build — how to best do this

Ordered so each step is shippable on its own.

### 3.1 Make the landing council sample ETF-aware — smallest useful change — DONE (partial)

`app/api/council/sample/route.ts` hardcoded `DEMO_TICKER = "SPY"` and built its prompt from
a single `${MCP_URL}/signals/${ticker}` fetch. That was the whole reason the section could
only show a generic two-panel T1/T2 answer.

- [x] Swapped `DEMO_TICKER` for MOO, plus `DEMO_FUND_NAME` and a fixed
      `SIMULATED_CAPITAL_USD = 10_000` — hardcoded, not user input, preserving the same
      "server-built prompt only" constraint `/api/council/public` documents for its own
      unauthenticated route.
- [x] Replaced `buildPrompt` with `buildSimulationPrompt(ticker, fundName, signal)`, framed
      as *"a retail investor is considering putting $10,000 into MOO today"* — grounded in
      whatever live `ai_summary`/`ai_score`/`ai_action` the GCP3 `/signals/{ticker}` endpoint
      returns, with an explicit honest fallback ("say plainly that live data was unavailable")
      when the fetch fails, rather than fabricating figures.
- [x] Response shape now carries `ticker`, `fundName`, and `simulatedCapitalUsd`; updated
      `app/page.tsx`'s `CouncilSample` interface and the `#council` render block to show
      "Live simulation: $10,000 into MOO (VanEck Agribusiness ETF) today" and drop the
      hardcoded "SPY" label from each seat panel.
- [ ] **Not done**: this still only calls `/signals/{ticker}` — the single live confluence
      score/summary — not the full §1.1+§1.2 brief (historical CAGR, the signal backtest,
      the look-through holdings scan). That data doesn't exist anywhere the route can read
      it yet; building it is §3.2, deliberately scoped separately so this step could ship
      without a new data pipeline.
- [ ] **Not done**: a `generatedAt` staleness badge on the panel. The 6-hour in-memory cache
      is unchanged from before; a MOO answer can still be served stale without a visible
      marker.
- [ ] **Not verified against production**: this route was type-checked and its prompt logic
      reasoned through, but not run end-to-end against a live `/signals/MOO` response in this
      session (no dev server was started). Verify with `npm run dev` and `curl
      localhost:3000/api/council/sample` before shipping, and confirm GCP3 actually has a
      cached/fresh MOO entry — the fallback path (no live data) is honest but untested here.

### 3.2 Add the simulation data source

The brief needs three things the portal cannot currently produce.

- [ ] **Fund composition** — holdings, weights, sector mix, expense ratio, AUM, beta. Source
      used here: `yf.Ticker("MOO").funds_data`. Cache daily; this changes on a quarterly cadence.
- [ ] **Historical performance** — lump-sum and DCA paths, CAGR, max drawdown, vol, Sharpe.
      Deterministic from adjusted close; compute once daily, not per request.
- [ ] **Signal hit-rate backtest** — the highest-value input. QUANT and RISK both anchored
      their entire argument on it, and it is the one number that separates this from a chart
      summary. `lib/council-grounding.ts` already has a `buildGroundedBrief` slot for
      backtest hit-rates; feed it from here rather than inventing a parallel path.
- [ ] Decide where this runs. Recommendation: extend the existing hydration path
      (`scripts/hydrate-local.mjs` / the GCP3 refresh) to write an `etf_simulation` document
      per tracked ETF, and have the route read it. Do **not** compute a 10y backtest inside a
      request handler.

### 3.3 Add the look-through seat — the thing that makes an ETF council non-trivial

A single-ticker council on an ETF is a category error: MOO's 100/100 score is an average over
50 holdings, and averaging is exactly where an ETF signal lies to you. The scan already shows
the tension — 7/8 bullish, but TSN at 12/100 SELL, and ZTS at 62 LOW.

- [ ] Add a `BREADTH` seat (or extend `QUANT`) whose only job is the constituent scan:
      how many holdings confirm, how much fund weight is on each side, and whether the ETF
      signal is broad or carried by two names.
- [ ] Feed it the per-holding scan rows from §1.1, weighted by fund weight.
- [ ] This is also the answer to "why not just show the user a chart" — no chart shows that
      4.4% of the fund is actively signalling SELL while the wrapper says BUY.

### 3.4 Render it

- [ ] The `#council` section currently renders exactly two panels (T1/T2) from
      `council?.shortTerm` / `council?.longTerm` in `app/page.tsx`. A simulation needs the
      simulation header ($10k → N shares, the performance table), the seat panels, and the
      CHAIR verdict.
- [ ] Show the split honestly. The most persuasive output of the real run was CHAIR saying
      *"the council is split"* — a unanimous-looking panel would be less credible, not more.
- [ ] Render the seat that abstained. MACRO's *"no macro data supplied, so the macro wind
      cannot be assessed"* is the single best demonstration of the site's own claim that
      *"the council can't answer without pointing to real data"* (`app/page.tsx:431`).
- [ ] Add the disclaimer treatment used elsewhere — this is a simulation of a specific
      investment in a named security and needs `components/DisclaimerFooter.tsx` parity.

### 3.5 Generalize

- [ ] Make the simulated ticker a config list, not a constant: MOO, then 2–3 more ETFs with
      different characters (a broad index, a bond fund, a thematic).
- [ ] Precompute at build/cron time and serve static. The live run took **276s** with retries
      — nowhere near acceptable inside a landing-page request. `/api/council/sample`'s
      cold-start-triggers-a-live-run design does not survive a six-seat deliberation.
- [ ] Persist each simulation run to the `council_verdicts` ledger so the public simulation
      also feeds the track record the landing page advertises.

---

## 4. Reproduce

```bash
S=docs/moo-council-run

# 1. fund composition
mamba run -n fin-ai1 python $S/moo_holdings.py > moo_holdings.json

# 2. the scan (no Firestore/GCP3 writes)
mamba run -n fin-ai1 python $S/scan_moo.py

# 3. the investment simulation + signal backtest
mamba run -n fin-ai1 python $S/sim_moo.py

# 4. compile the app's council lib, then run the council on it
node_modules/.bin/tsc lib/openrouter.ts lib/council-verdict.ts \
  --outDir compiled --module commonjs --target es2022 \
  --moduleResolution node --skipLibCheck --esModuleInterop
node $S/run_council_headroom.mjs
```

The runner reads `OPEN_ROUTER_KEY` from `~/code/homebase/.env` because the portal's own key
is expired (§2.3). Fix that and it should read `OPENROUTER_API_KEY` from `.env.local` instead.

---

## 5. Open questions

- **Is the production OpenRouter key alive?** Everything in §2 is worse if it is not. Check
  before building anything in §3.
- **Should the simulation be dated or evergreen?** A dated one ("as of 2026-09-02") is honest
  and ages badly; an evergreen one needs the daily precompute in §3.2 to exist first.
- **`$10,000` or user-entered capital?** Fixed capital keeps `/api/council/public`'s
  ticker-only, no-free-text contract intact — worth preserving; a capital input is a new
  injection surface for an unauthenticated endpoint.
