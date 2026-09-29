# Paper Trading v3 — Eight Bots, Real Books, Real Stories

**Repo:** `nuwrrrld-portal` · **Written:** 2026-09-29 (~05:40 UTC, before today's first slot)
**Supersedes the plan parts of:** [2026-09-26 report](ai-paper-trading-report-2026-09-26.md), [2026-09-27 summary](paper-trading-session-2026-09-27-summary.md), [2026-09-29 summary](paper-trading-session-2026-09-29-summary.md)
**Triggered by:** [issue #202](https://github.com/adamaslan/nuwrrrld-portal/issues/202) ("Paper portfolios (settle) failed 2026-09-29")

Everything below was checked against production on 2026-09-29. Where a claim comes from a
read-only Neon query, a GitHub/Vercel API call, or a local simulation using the repo's own
pure planner (`lib/shared/paper-engine-core.ts::planRun`), the section says which one.
Claims that could not be verified are marked **(suspected)**.

---

## 0. TL;DR

The 2026-09-29 summary said paper trading went "live and trading." That's too generous.
It placed **one trade**, **under the wrong policy version**, **after market close**, into
**accounts that were never funded the way the design says**. Its **benchmarks hold 100%
cash**, and the six "AI bots" are **one signal with six sizing rules**. They will all buy the
same stock at 09:00 ET today.

Ranked by how much each one undermines the experiment. F13 was found by the local simulator
(§7) while writing this, not by reading the code:

| # | Finding | Impact | Evidence |
|---|---|---|---|
| F1 | **The seed book was never bought.** All 8 accounts are $10,000 cash (risk: $9,699.55 + 1 position). `equal` and `spy` hold nothing. | There is no benchmark. Every "vs control" number would compare against flat cash. | Neon: `paper_positions` has 1 row. `scripts/seed-paper-portfolios.mjs` only inserts `paper_accounts` and `paper_watchlists`, and nothing reads `in_seed_book`. |
| F2 | **The first "v2" run actually executed v1 code.** Vercel finished deploying #188 at `03:15:06Z`. The route was called at `03:15:08Z`, before the alias moved. | The only trade on record has a mislabeled policy. | Every outcome matches the v1 thresholds exactly (see §1.2). The rows are stamped `v2` because `policy_version` is copied from the `paper_accounts` row, not from the running code. |
| F3 | **All 6 bots will open UNH today.** Cards are coarse (12 distinct scores across the 450 watchlist rows; 14 names tied at 54), and ties break **alphabetically**. | The "council" doesn't differ in picks, only in size. There is no story to tell. | §2, reproducible via `paper-sim.ts` (§7); the tool prints the overlap directly. |
| F4 | **T1 and T2 read identical cards.** 0 of 978 ticker pairs differ in score or tokens, apart from the `horizon` label. | "Short-term vs long-term" is a label, not a signal. | Neon: `ticker_cards` self-join. |
| F5 | **Stop-losses can be blocked by the turnover cap.** In `planRun`, a `stop` sell that would exceed `maxTurnoverPerRun` is skipped (`continue`). | T2 (8% max position vs 3% turnover) can **never** exit a full-size position, not even on a 25% stop. MACRO (6% vs 6%) can't exit once a winner grows. | `lib/shared/paper-engine-core.ts`, sells loop. |
| F6 | **Slots are resolved from the wall clock, and GitHub starts crons hours late.** On 2026-09-28 there were zero preopen/midday runs, and 6 runs resolved to `settle` between 18:09 and 21:11 ET. | The design runs 4 slots a day. In practice it gets about 1.5, mostly mislabeled. | `gh run list --workflow paper-portfolios.yml` |
| F7 | **Nothing checks how old a price is.** `getLivePrices` ignores `traded_at`. The first trade filled at 23:15 ET on prices from 13:12–16:57 ET, labeled `preopen`. | A missed price refresh means trades fill at yesterday's price. | `lib/live-price-db.ts::getLivePrices`; `live_prices` min/max `traded_at`. |
| F8 | **Arbitration is blind and leaves no record.** The model sees only the ticker, % of NAV, the price, and a one-line flag. It gets 80 tokens and no rationale is stored. RISK's arbitration persona is "devil's advocate: argue AGAINST", and it judges its own buys. | That's where the narrative should come from, and today it records nothing. RISK is built to veto itself. | `lib/paper-arbitration.ts`; `lib/openrouter.ts` RISK prompt. |
| F9 | **The narrative columns exist but nothing writes them.** `paper_positions.thesis / invalidation / stop_price / target_price / exit_by` are all `NULL`. | The schema already allows for stories. The engine never writes one. | Neon: `information_schema.columns` + the HRL row. |
| F10 | **CHAIR is not a consensus.** The design (§2) says "consensus of the five, weighted by agreement". The code gives CHAIR its own threshold on the same cards. | The one bot meant to synthesize the others ignores them. | `PAPER_POLICY.chair` vs `docs/council-paper-portfolios.md` §2 and §11 Q1. |
| F11 | **Issue spam.** Every failed run opens a new issue. There are 35 open `Paper portfolios (...) failed` issues (through #202), all the same pre-#188 defect. | Real failures get lost in the noise. | `gh issue list --label pipeline-failure` |
| F13 | **A stopped-out position is re-bought in the same run.** `planRun`'s sells loop does `positionsByTicker.delete(ticker)`; the buys loop then reads `positionWeight(ticker)` as 0 and re-enters at full size, because the card score is unchanged by the stop. | The stop is defeated — the bot exits and immediately re-enters at the bottom, paying two lots of slippage, with the trailing stop reset to the new low. A trailing-stop bot can churn on this indefinitely. | `lib/shared/paper-engine-core.ts`. **Reproduced locally**: §7.3's what-if marks HRL down 30% and RISK emits `sell HRL` then `buy HRL` in one plan. |
| F12 | Smaller correctness items: `turnoverUsed` is recorded **before** arbitration (T2 shows 3% turnover with 0 orders); `getScreenCandidates` / `getLivePrices` swallow errors and return empty, which looks like a quiet market; `runsHeld` counts `settle` runs; `ticker_cards` keeps only the latest `bar_date`, so no past decision can be replayed; cards computed 22:11 ET 9/28 are labeled `bar_date = 2026-09-29` **(suspected UTC date label)**; PFE and KMB get small-cap slippage (15 bps). | Each one skews a metric or hides a failure. | Code + Neon, cited inline in §5. |

**Issue #202 itself** was already fixed by #188. The run was on commit `2dc4d5e`, before #188
merged at `03:13:37Z`, and failed at the old `gh secret list` step. Close it along with its 34
siblings (§6, Step 1).

---

## 1. What actually happened (timeline, all UTC, 2026-09-28 → 29)

### 1.1 The failing runs

| Time | Event | Slot resolved | Result |
|---|---|---|---|
| 20:01, 20:17 | scheduled | preclose | fail — `Verify required secrets exist` (`gh secret list` 403) → #194, #195 |
| 22:09, 22:36, 23:56, 00:28, 00:34, 01:11 | scheduled | **settle ×6** | fail, same step → #197–#202 |
| 03:13:37 | PR #188 merged (`179f271`) | — | — |
| 03:13:41 | Vercel starts production build | — | — |
| 03:14:14 | manual `workflow_dispatch slot=preopen skip_market_check=true` | preopen | — |
| 03:15:06 | Vercel: "Deployment has completed". `live_prices` refreshed (176 rows) | — | — |
| 03:15:08 | route writes the first `paper_runs` row | preopen, `trade_date=2026-09-28` | 8 × `ok`, 1 order |

No preopen or midday run fired on 9/28. Eight crons exist, but GitHub delayed them by hours.
The wall-clock gate then labeled whatever arrived after 16:30 ET as `settle`.

### 1.2 Why we know the trade ran v1, not v2

| Account | v1 buy threshold | v2 buy threshold | Best card on its watchlist | What happened | Consistent with |
|---|---|---|---|---|---|
| risk | 80 | 60 | HRL 100, then KMB/PFE/UNH 60 | bought **only HRL** | v1 (v2 would also have bought KMB and PFE) |
| t2 | 60 | 20 | UNH 60 | UNH flagged as a **score tie**, then vetoed | v1 (60 − 60 = 0 falls inside the 5-point tie band; under v2 the margin is 40) |
| t1 | 70 | 40 | UNH 60, then seven names at 54 | 0 orders | v1 (v2 would have bought 3) |
| macro / quant / chair | 65 / 75 / 70 | 30 / 50 / 40 | 60 | 0 orders | v1 |

Every row stamped `policy_version = 'v2'`. The stamp comes from `dbAccount.policyVersion`
(`lib/paper-engine.ts`, the `paper_runs` insert), not from the `PAPER_POLICY_VERSION`
constant in the code that ran.

### 1.3 What the book looks like right now

| Account | Cash | Positions | NAV |
|---|---:|---:|---:|
| t1, t2, macro, quant, chair | $10,000.00 | 0 | $10,000.00 |
| risk | $9,699.55 | HRL 15.015 sh @ $20.01 | $9,999.55 |
| **equal** (benchmark) | $10,000.00 | **0** (should be 50 × $200) | $10,000.00 |
| **spy** (benchmark) | $10,000.00 | **0** (should be 100% IVV) | $10,000.00 |

---

## 2. Forecast: what each bot will do at today's preopen if nothing changes

**Method:** `scripts/paper-sim.ts` (added in this branch, §7), which imports the repo's own
`planRun` + `selectArbitrationCandidates` + `fillOrders` and runs them against real inputs.
**Reproduce it in one command:** `npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite`.
Verified identical from the local SQLite snapshot and from read-only Neon. Those inputs are each
account's live `paper_watchlists`, the latest `ticker_cards` (`bar_date = 2026-09-29`), the
current `live_prices`, and current positions (RISK holds HRL). Read-only; nothing was written.
09:00 prices will differ slightly, so share counts will too. The **picks** are score-driven and
will match unless a price goes missing.

| Bot | Buys (% of NAV) | Turnover | Model calls |
|---|---|---:|---|
| T1 | **UNH 6%**, DASH 6%, DUK 3% | 15% | 0 (no score near its threshold) |
| T2 | **UNH 3%** | 3% (its cap) | 0 |
| RISK | KMB 3%, PFE 3%, **UNH 2%** | 8% | **3**: all three are exact ties at 60 |
| MACRO | **UNH 6%** | 6% (its cap) | 0 |
| QUANT | **UNH 4%**, DUK 4%, HD 4% | 12% | 0 (by design) |
| CHAIR | **UNH 5%**, DUK 3% | 8% | 0 |
| equal / spy | nothing | — | — |

**All six bots buy UNH.** The six books will hold UNH at 2–6% each, and that one name will
drive a large share of their P&L. The cause:

- `scoreCard` (`lib/shared/card-policy.ts`) builds scores from 6 categorical tokens. UNH =
  (moderate bullish 30 + MACD bullish cross 20) × 1.2 trending = **60**. The 54 cluster = (30 +
  RSI oversold 15) × 1.2 = **54**. That cluster covers 14 watchlist names: BRO, D, DASH, DUK,
  GIS, HD, NEE, O, PEP, ROP, RTX, SO, XEL, XLU.
- `planRun` breaks ties with `a.ticker.localeCompare(b.ticker)`. Among the 54s, **D, DASH and
  DUK beat HD, NEE, PEP, RTX, SO and XLU purely on spelling.**
- MACRO, the ETF-rotation bot, buys a single healthcare stock. Its 6% turnover cap is used up by
  UNH before XLU (54) is reached.

That's the core narrative problem. The bots' personalities live only in their sizing, so there
is nothing to narrate. §4 fixes the inputs so that different bots make different decisions.

---

## 3. The v3 cast — who each bot is, and how it should differ

Each bot below has a **mandate** (the design), **today's reality** (what the code does), and
**v3** (what changes). The personas stay mechanical, and the model never sets a size (the
guardrail stays). What changes is that each bot gets its own **way of choosing** among equal
scores, and its own **voice** for explaining what it did.

### T1 — "The Tactician" (short-term, 1–60 days) · model `nex-agi/nex-n2.5-mini:free`
- **Mandate:** trade catalysts on a high-beta pool (PLTR, COIN, MSTR, SMCI…) plus the Core 50.
- **Today:** buy ≥ 40, 6% max, 15% turnover, fixed 8% stop. Picks UNH/DASH/DUK, the same as everyone.
- **v3 tie-break:** a *fresh* event first, i.e. `macd = bullish_cross` beats `rsi = oversold`
  beats the rest. Then higher volatility (it wants movement). Then a deterministic hash
  (below), never the alphabet.
- **v3 exits:** add a **time stop** (`exit_by` = entry + 15 trading days if the thesis event hasn't moved price ≥ 3%).
- **Voice:** terse and specific about the trigger. *"Bought the cross, not the company. If
  UNH gives back the cross by Friday I'm out."*
- **The story to watch:** does a catalyst-chaser beat buy-and-hold on a 1–3 week hold, net of
  slippage? This bot turns over its book the most, so friction shows up here first.

### T2 — "The Compounder" (3–12 months) · model `poolside/laguna-s-2.1:free`
- **Mandate:** toll-booth businesses, a 20-run minimum hold, rarely trades.
- **Today:** buy ≥ 20, 8% max, **3% turnover**, fixed 25% stop. That stop can **never fire** on
  a position above 3% of NAV (F5). The minimum hold counts settle runs, so 20 runs ≈ 5 trading
  days, not months.
- **v3:** stops ignore the turnover cap. The minimum hold becomes **20 trading days**. Tie-break
  on `vol = low` → `adx = trending` → names in its own 25 compounder extras.
  Needs its own **t2 card** (F4) before its signal differs from T1's at all.
- **Voice:** patient and business-first. *"Nothing to do. Four positions, all inside thesis. The
  best trade this week was not trading."* A no-trade diary entry is a feature for this bot.
- **The story to watch:** does doing almost nothing win?

### RISK — "The Survivor" (survive being wrong) · model `inclusionai/ling-3.0-flash-fin:free`
- **Mandate:** defensive tilt, 15% cash floor, 3% cap, trailing 5% stop, 15% sector cap.
- **Today:** buy ≥ 60, which on today's cards is exactly the 60 cluster, so **every buy is an
  arbitration tie**. Its arbitration persona is the council's *devil's advocate* ("argue the
  case AGAINST the prevailing direction"), so the bot judging RISK's buys is prompted to argue
  against them.
- **v3:** an arbitration persona written for the book it runs: *"Veto only if this trade breaks
  survive-being-wrong: correlated with what we hold, sector already heavy, or no clear stop."*
  Tie-break on the lowest `vol`, then the sector with the **most headroom** under its cap.
- **Voice:** thinks in drawdowns. *"Bought HRL at 3%. If I'm wrong I lose $15, because the stop
  sits at $19.01. What I care about is not owning three food companies that fall together."*
- **The story to watch:** smallest max drawdown vs `spy`, and whether the trailing stop saves
  more than it costs in whipsaws.

### MACRO — "The Rotator" (rates / dollar / liquidity / sectors) · model `dots-studio/dots-3-note-preview:free`
- **Mandate:** express views through **sector ETFs** (XLE, XLU, TLT, GLD, EEM…).
- **Today:** buys UNH, a single stock, because ties go alphabetical and its 6% turnover is gone
  after one order.
- **v3:** rank by **sector breadth** first: the share of bullish cards among
  that ETF's sector in `ticker_cards` (computable in the same SQL as SCREEN). ETFs get a
  preference within equal breadth. Stops ignore the turnover cap (6% position == 6% turnover
  today, so a grown winner is stuck).
- **Voice:** top-down. *"Utilities breadth is 7 of 9 bullish, the widest of any sector. Rotating
  in through XLU rather than picking a utility."*
- **The story to watch:** does sector timing beat stock picking with the same cards?

### QUANT — "The Control Inside the Council" (numbers only) · no model, ever
- **Mandate:** `data_quality ≥ 0.95`, zero model calls, the in-council control.
- **Today:** correct as designed. 969 of 978 cards clear its gate, so the gate barely filters anything.
- **v3:** keep it dumb **on purpose**. Tie-break on `data_quality` desc, then the hash. Its
  narration is **template-only** (no model) so it's the control for the narrative layer too.
- **Voice:** a table, not prose. *"UNH 60 ≥ 50 → buy 4%. DUK 54 → buy 4%. HD 54 → buy 4%.
  Turnover 12/12%."*
- **The story to watch:** if QUANT matches the model-arbitrated bots, the models add nothing.
  That's the most important result this experiment can produce.

### CHAIR — "The Consensus" · model `nvidia/nemotron-3-ultra-550b-a55b:free`
- **Mandate:** "consensus of the five, weighted by agreement" (§2, §11 Q1 in the design doc).
- **Today:** just another threshold (≥ 40) on the same cards (F10).
- **v3:** CHAIR runs **last** in each slot. It buys a name only if **≥ 3 of the 5 seats' plans**
  proposed it in the same run, sized at `5% × votes / 5`. It sells when ≥ 3 seats sell. This is
  pure and deterministic: the planner already computes the other five plans.
- **Voice:** it reports the vote. *"4 of 5 seats wanted UNH (T1, T2, MACRO, QUANT; RISK
  abstained on correlation). Bought 4%. Only T1 wanted DASH, so no."*
- **The story to watch:** does agreement predict returns better than any single seat?

### EQUAL — "The Index Fund of Our Own Universe" · no model
- **Mandate:** Core 50 at $200 each, never rebalanced.
- **Today:** holds nothing (F1).
- **v3:** buy it (§6, Step 4), then do nothing forever. It answers "did any bot beat just
  owning the list?"

### SPY — "The Market" · no model
- **Mandate:** 100% IVV, buy and hold.
- **Today:** holds nothing (F1).
- **v3:** buy it. Every bot's headline number becomes **excess return vs SPY**.

---

## 4. The narrative layer (spec)

**The rule:** numbers come from the database, and the model only adds voice. A model sentence
may never add a number that isn't in the facts it was given, and it never changes an order.

### 4.1 Trade ticket (every order, deterministic, no model needed)

Written at FILL time into `paper_positions` (the columns already exist: `thesis`,
`invalidation`, `stop_price`, `target_price`, `exit_by`) and copied onto the order row's
`detail`. The template is built from the card tokens and the policy:

```
{BOT} {buys|sells} {TICKER} — {pct}% of NAV at ${fill} ({slippage} bps).
Why: card {score} ({direction}/{confluence}; {macd event}; RSI {rsi}; ADX {adx}; vol {vol}).
Picked over: {n} other names tied at {score} — tie-break: {rule}.
Stop: {kind} {pct}% → ${stop_price}.  Exit on signal if card < {sellThreshold} after {minHold} {runs|days}.
Exit by: {exit_by or "no time stop"}.
```

**Worked example (real, the one trade on record):**

> **RISK buys HRL** at 3.0% of NAV, filled at $20.01 (15 bps). *Why:* card 100, the maximum:
> strong bullish confluence, MACD bullish cross, RSI oversold, trending ADX, low volatility.
> *Stop:* trailing 5% from high-water → **$19.01**. *Exit on signal* if the card falls below
> +10 after 4 runs. *Exit by:* none.

**Worked example (forecast, T1 at 09:00):**

> **T1 buys UNH** at 6.0% of NAV at ~$378.13 (5 bps). *Why:* card 60, moderate bullish
> confluence and a fresh MACD bullish cross, trending ADX, low volatility. *Picked over:*
> nothing, since it's the only 60 on T1's list. *Stop:* fixed 8% → **~$347.88**. *Exit on
> signal* if the card falls below −10.

### 4.2 Arbitration with evidence and a reason (`lib/paper-arbitration.ts`)

| | Today | v3 |
|---|---|---|
| Prompt facts | ticker, % of NAV, price, reason, one flag line | **plus** the card tokens, score vs threshold, the names it beat in the tie, current book (cash %, sector weights, whether we already hold something correlated), the stop price from the ticket |
| Persona | `seatSystemPrompt(seat)` (the debate prompt) | a per-seat **arbitration persona** (RISK especially: see §3) |
| Output schema | `{"action","downsize_pct"}` | `{"action","downsize_pct","why"}`, with `why` ≤ 25 words |
| `max_tokens` | 80 | 160 |
| Stored | action + model in `paper_runs.detail.arbitration` | **plus** `why`, the prompt's fact hash, latency, and `raw` when parsing failed |
| Parse failure | CONFIRM-none (keep) | CONFIRM-none (keep), plus a `parse_failed: true` counter so the rate is visible |

Guardrail #5 is unchanged: the model still can't pick a ticker or a size.

### 4.3 Settle diary (one per bot per trading day)

New table `paper_journal (account, trade_date, kind, facts jsonb, body text, model, created_at)`.
It's written at `settle` after metrics. `kind` ∈ `diary | weekly_letter`.

1. **Facts (deterministic):** day return vs SPY, trades with tickets, vetoes with `why`, positions near
   their stop (≥ 80% of the way there), the biggest mover, cash %.
2. **Body:** the bot's model writes ≤ 120 words from `facts` only, in its voice (§3). QUANT's
   body is the facts rendered as a table.
3. **Number lint (a guard, not a suggestion):** every number that appears in `body` must appear
   in `facts`. A diary that fails the lint is stored with `body = NULL` and `lint_failed = true`,
   and the page shows the facts table instead. The model can't invent a return.

### 4.4 Weekly letter (CHAIR, Friday settle)

CHAIR gets all eight diaries plus the leaderboard, and writes ≤ 300 words. It covers who's
ahead of SPY and by how much, where the seats disagreed and who turned out right, and one
thing the council will watch next week. The same number lint applies.

### 4.5 Where it shows up
`/dashboard/council/portfolios` (`PaperPortfoliosClient.tsx`): a per-bot card with the
latest diary, open positions with ticket text and a distance-to-stop bar, a veto log, and the
weekly letter pinned at the top. That page has **never been viewed signed-in against real
data** (2026-09-29 summary), so the first click-through is part of PR F.

---

## 5. Engine and ops changes (explicit)

### 5.1 Correctness (PR B): `lib/shared/paper-engine-core.ts`, `lib/paper-engine.ts`, `lib/live-price-db.ts`, `lib/paper-db.ts`

1. **Stops and voids ignore turnover.** In `planRun`'s sells loop, apply
   `if (turnoverUsed + notional > turnoverCapNotional) continue;` only when
   `reason === "score_exit"`. Evaluate sells in priority order `void → stop → score_exit`
   (today they follow insertion order). Test: T2 with one 8% position at −26% must produce a
   `stop` sell.
2. **Price freshness.** `getLivePrices` returns `{price, tradedAt}`, and the engine drops any
   price older than `MAX_PRICE_AGE_MIN` (proposed: 30 for trading slots, 24 h for settle). If a
   held position has no fresh price, carry it at the last mark and record
   `detail.stale_prices: [...]`.
3. **Stamp the code's version.** Insert `PAPER_POLICY_VERSION` (the constant) into
   `paper_runs.policy_version`. If it differs from `paper_accounts.policy_version`, fail that
   account with `skip_reason = 'policy_version_mismatch'` instead of silently mixing versions.
4. **`turnoverUsed` after arbitration.** Recompute from `arbitratedOrders` before persisting.
5. **Stop swallowing errors.** `getScreenCandidates` and `getLivePrices` rethrow (or return a
   `{ok:false}`), and the route records `status = 'failed'`, `skip_reason = 'screen_error'`.
   An empty candidate list must mean "nothing qualified", never "the query broke".
6. **A ticker sold this run cannot be re-bought this run (F13).** Track exits in a
   `soldThisRun: Set<string>` in `planRun` and add `.filter((c) => !soldThisRun.has(c.ticker))`
   to `buyCandidates`. A stop must end the position for the run, not hand it back. Test: the
   §7.3 what-if (HRL −30%) must produce exactly one `sell HRL` and no `buy HRL`.
7. **Deterministic, non-alphabetical last tie-break:** `hash(ticker + trade_date)`. This
   changes daily and is reproducible. Persona tie-breaks (§3) sort before it.
8. **Card snapshot on the order.** Add `state_key` (already on `ticker_cards`) to the order's
   stored detail. `ticker_cards` keeps only the latest `bar_date`, so without this no decision
   can be replayed.
9. **Slippage table.** PFE and KMB got 15 bps in the forecast (not in
   `isMegaOrLargeCap`). Extend the list or switch to a market-cap lookup.

### 5.2 Scheduling (PR A): `.github/workflows/paper-portfolios.yml`

1. **Resolve the slot from the cron that fired, not the clock:**
   ```bash
   case "${{ github.event.schedule }}" in
     '0 14 * * 1-5'|'0 13 * * 1-5')   SLOT=preopen ;;
     '30 17 * * 1-5'|'30 16 * * 1-5') SLOT=midday ;;
     '45 20 * * 1-5'|'45 19 * * 1-5') SLOT=preclose ;;
     '30 21 * * 1-5'|'30 20 * * 1-5') SLOT=settle ;;
   esac
   ```
   Keep the wall-clock window only for `workflow_dispatch` without `slot`.
2. **Lateness guard:** a trading slot that starts outside 09:30–16:00 ET runs **mark-only**
   (new route param `mode=mark`, recorded as `skip_reason = 'outside_market_hours'`). That
   includes a manual dispatch like the 23:15 ET "preopen" on 9/28.
3. **Move `preopen` from 09:00 to 09:45 ET** (proposed; decision D3). At 09:00, IEX "latest
   trade" is yesterday's close or thin premarket, so preopen really trades at the prior close.
4. **Wait for the deploy.** Add `GET /api/paper/version` → `{sha: process.env.VERCEL_GIT_COMMIT_SHA, policy: PAPER_POLICY_VERSION}`,
   and have the workflow poll it (≤ 5 min) until `sha == github.sha` before calling the run route. This closes F2.
5. **One issue per failure mode, not per run.** Replace `gh issue create` with
   find-or-comment:
   ```bash
   N=$(gh issue list --repo "$GITHUB_REPOSITORY" --label pipeline-failure --state open \
        --search "Paper portfolios in:title" --json number -q '.[0].number')
   if [ -n "$N" ]; then gh issue comment "$N" --repo "$GITHUB_REPOSITORY" --body "Failed again: $RUN_URL (slot $SLOT)";
   else gh issue create ...; fi
   ```
6. **Price refresh is no longer fire-and-forget.** Keep `continue-on-error`, but pass the step's
   outcome to the route (`prices=stale`) so the run records it and trades only on prices that
   pass the freshness check in §5.1.2.

### 5.3 Proposed policy v3 (`lib/shared/paper-policy.ts`, bump `PAPER_POLICY_VERSION = "v3"`)

The v2 thresholds were set against a card distribution nobody had looked at. The real
distribution on 2026-09-29 (978 tickers): 784 score 0, and the rest cluster at 38 / 45 / 46 /
50 / 51 / 54 / 60 / 100 and their negatives. Thresholds should sit **between** clusters, not on them:

| | t1 | t2 | risk | macro | quant | chair |
|---|---|---|---|---|---|---|
| buy (v2 → **v3**) | 40 → **45** | 20 → **45** | 60 → **55** + require `vol = low` | 30 → **45** | 50 → **50** | 40 → *consensus ≥ 3/5* |
| sell | −10 | −40 → **−35** | 10 | −20 | 0 | *consensus ≥ 3/5* |
| turnover / run | 15% | 3% → **6%** | 8% | 6% → **10%** | 12% | 8% |
| min hold | 1 run | 20 runs → **20 trading days** | 4 runs | 8 runs | 1 run | 4 runs |
| stops vs turnover | — | **exempt (all)** | | | | |

Every value here is **chosen, not derived**. The v3 PR must say so, the same way
`BUY_TIE_BAND`'s comment does.

**Two things the simulator (§7) disproved about this table — measured, not assumed:**

1. **Thresholds alone do not fix F3.** Running `--policy=v3` still buys UNH in **6 of 6** bots,
   and takes DUK from 3 bots to 4. Raising a threshold changes *how many* names clear it, not
   *which* name wins a tie. Only the persona tie-breaks (§3) and separate t1/t2 cards (§5.4)
   change the picks. Do not ship §5.3 expecting the books to diverge.
2. **No RISK threshold both clears the 60s and avoids flagging every buy.** `BUY_TIE_BAND` is
   5 points and the gap from the 54 cluster to the 60 cluster is 6, so a threshold of 55 leaves
   a margin of exactly 5 — still inside the band, still 3 arbitration calls. Dropping to 54 does
   silence the flags but pulls the whole 54 cluster in (4 eligible → 14). Measured:

   | RISK buy≥ | eligible | arbitration calls |
   |---:|---:|---:|
   | 60 (v2) | 4 | 3 |
   | 55 | 4 | 3 |
   | 54 | 14 | 0 |

   So the fix isn't the threshold — it's that `BUY_TIE_BAND` is an absolute point band on a
   distribution with only 12 distinct values. **Recommendation:** keep RISK at 55, narrow
   `BUY_TIE_BAND` from 5 to 3, and cap arbitration at the 2 orders closest to the threshold per
   run, so a whole cluster can't consume the budget.

### 5.4 Upstream: separate the horizons (PR D, card pipeline)

T1 and T2 cards are identical because the card writer (`source = 'hydrate-local'`,
`CARD_SCORE_V1`) feeds the same indicator state into `buildCard(…, horizon)` for both
horizons. v3 needs t1 tokens from a **daily/short** frame (e.g. RSI-14, MACD 12/26 on daily
bars) and t2 tokens from a **weekly/long** frame (weekly RSI, 50/200 trend, 52-week
position). Until that lands, T1 vs T2 only tests sizing rules, and the doc and dashboard
must say so.

Find the writer:

```bash
cd ~/code/nuwrrrld-portal-paper-prices && git grep -n "hydrate-local" -- lib scripts app | head
```

### 5.5 Metrics that tell the story (`lib/shared/paper-metrics-core.ts`)

Per bot, shown at settle and on the dashboard: **excess return vs SPY**, excess vs EQUAL,
max drawdown, hit rate (closed trades), average hold, turnover, slippage paid,
**veto rate and veto hindsight** (did the vetoed name go up or down over the next 5
days?), **stop saves vs whipsaws**, and **overlap with other bots** (Jaccard on
holdings; this tells you whether they actually differ). None of these mean anything until F1 is fixed.

---

## 6. Runbook: do these in order

> Everything here is copy-paste. Steps marked ⚠️ write to **production** Neon or GitHub,
> and each one waits for your explicit yes. Read-only checks use the main checkout's
> `.env.local`, which is where `DATABASE_URL` lives. The worktree's `.env.local` doesn't have it.

### Step 1: close the 35 stale failure issues (through #202), all pre-#188

**1a. List them (read-only).**

```bash
gh issue list --repo adamaslan/nuwrrrld-portal --label pipeline-failure --state open \
  --search "Paper portfolios in:title" --limit 100 \
  --json number,title,createdAt -q '.[] | select(.createdAt < "2026-09-29T03:13:37Z") | "\(.number)\t\(.title)"'
```
Expect ~35 rows (35 on 2026-09-29), all created before #188 merged.

**1b. ⚠️ Close them with a pointer to the fix.**

```bash
gh issue list --repo adamaslan/nuwrrrld-portal --label pipeline-failure --state open \
  --search "Paper portfolios in:title" --limit 100 \
  --json number,createdAt -q '.[] | select(.createdAt < "2026-09-29T03:13:37Z") | .number' \
| while read n; do
    gh issue close "$n" --repo adamaslan/nuwrrrld-portal \
      --comment "Pre-#188 failure at the old \`gh secret list\` step (403 under GITHUB_TOKEN). Fixed by #188 (179f271). Tracking v3 work in docs/paper-trading-v3.md." \
    && echo "closed #$n"
  done
```

**1c. Verify.**

```bash
gh issue list --repo adamaslan/nuwrrrld-portal --label pipeline-failure --state open --search "Paper portfolios in:title" --limit 100 --json number -q 'length'
```
Expect `0`.

### Step 2: watch today's first real v2 slot (read-only)

The next scheduled trading slot runs today on the correct code. §2's forecast says what should happen.

**2a. After ~13:00 UTC (09:00 ET, often late), see whether the run fired and which slot it resolved to.**

```bash
gh run list --repo adamaslan/nuwrrrld-portal --workflow paper-portfolios.yml --limit 5 \
  --json databaseId,createdAt,event,conclusion,headSha -q '.[] | "\(.databaseId) \(.createdAt) \(.event) \(.conclusion) \(.headSha[0:7])"'
```

**2b. Compare to the forecast.**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local --input-type=module -e '
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
console.table(await sql`SELECT r.account, r.trade_date, r.slot, r.policy_version, r.orders_n, r.model_calls,
  (SELECT string_agg(o.ticker || ${" "} || round((o.notional / 100)::numeric, 1)::text || ${"%"}, ${", "}) FROM paper_orders o WHERE o.run_id = r.id) AS orders
  FROM paper_runs r WHERE r.trade_date = (now() AT TIME ZONE ${"America/New_York"})::date ORDER BY r.started_at`);
console.table(await sql`SELECT account, detail->${"arbitration"} AS arbitration FROM paper_runs WHERE model_calls > 0 ORDER BY started_at DESC LIMIT 6`);
'
```
Expect rows matching §2, with every bot holding UNH. RISK should show 3 model calls
(KMB, PFE, UNH). If the slot shows `settle` instead of a trading slot, that's F6 again.
(`% of NAV` ≈ notional / 100 while NAV ≈ $10,000.)

### Step 3: decide the open questions

| # | Decision | Recommendation |
|---|---|---|
| D1 | How to fund the seed book (F1) | **Buy it now on top of the existing cash**, as a one-time `seed` run (Step 4). Trading accounts get `min($200, (cash − cashFloor × NAV) / 50)` per name, so RISK's 15% floor holds. `equal` gets 50 × $200. `spy` gets 100% IVV. A full reseed is blocked by design: `seed-paper-portfolios.mjs --force-reseed` refuses once run history exists, and `paper_orders` is append-only. |
| D2 | The 9/28 "v2" rows that really ran v1 | **Annotate, don't rewrite:** add `detail.actual_policy = 'v1'` plus a note (Step 5). History stays true to what was recorded, and readers see the correction. |
| D3 | Move preopen to 09:45 ET | **Yes.** At 09:00 the "live" price is the prior close. |
| D4 | Narration models | Keep the free chain for arbitration. Consider one paid small model for diaries only (≈ 6 diaries/day × 150 tokens), since free models rotate and the voices would drift. |

### Step 4: ⚠️ fund the seed book (after D1, and after PR C lands)

PR C adds `scripts/seed-paper-book.mjs`, following the same structure as
`seed-paper-portfolios.mjs`: `--dry-run`, manifest, `--undo`. It also adds a migration that
allows `slot = 'seed'` in `paper_runs` / `paper_nav`. Today the `CHECK` only allows the four
trading slots, so the migration touches `migrations/` and needs the sensitive-surface
confirmation.

**4a. Preflight.**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && git fetch origin main && git log --oneline origin/main -1 && ls scripts/seed-paper-book.mjs
```
Expect: the PR C merge commit on top, and the file exists. If the file is missing, PR C hasn't
merged, so stop here.

**4b. Dry run (prints the plan, writes nothing).**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local scripts/seed-paper-book.mjs --dry-run
```
Expect: 7 accounts × 50 buys plus `spy` × 1 IVV buy, each account's post-seed cash ≥ its `cashFloor`.

**4c. ⚠️ For real (during market hours, so prices are fresh).**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local scripts/seed-paper-book.mjs
```

**4d. Verify.**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local --input-type=module -e '
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
console.table(await sql`SELECT a.account, round(a.cash::numeric,2) cash, count(p.ticker)::int positions FROM paper_accounts a LEFT JOIN paper_positions p USING (account) GROUP BY a.account, a.cash ORDER BY a.account`);
'
```
Expect: `equal` 50 positions and ≈ $0 cash, `spy` 1 position (IVV), the trading accounts ≥ 50 positions.

### Step 5: ⚠️ annotate the v1-labeled rows (after D2)

**5a. See exactly what will change (read-only).**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local --input-type=module -e '
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
console.table(await sql`SELECT account, trade_date, slot, policy_version, started_at FROM paper_runs WHERE trade_date = ${"2026-09-28"} AND slot = ${"preopen"}`);
'
```
Expect 8 rows, `started_at` ≈ `2026-09-29T03:15:08Z`.

**5b. ⚠️ Annotate (adds keys to `detail`, changes no numbers).**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local --input-type=module -e '
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
const note = { actual_policy: "v1", note: "Executed on the pre-#188 deployment (Vercel ready 03:15:06Z, route hit 03:15:08Z); after-hours fill labeled preopen. See docs/paper-trading-v3.md §1.2" };
const r = await sql`UPDATE paper_runs SET detail = detail || ${JSON.stringify(note)}::jsonb WHERE trade_date = ${"2026-09-28"} AND slot = ${"preopen"} RETURNING account`;
console.log("annotated", r.length);
'
```
Expect `annotated 8`. Rerun 5a with `detail` added to the SELECT to confirm.

### Step 6: ship the PRs (in this order)

The order puts the highest file overlap first, so later branches rebase onto it. Each PR gets
its own worktree off `origin/main` (per `one-session-one-worktree`).

| PR | Branch | Owns | Contents | Blocks |
|---|---|---|---|---|
| **0** | `docs/paper-trading-v3` (this branch) | `docs/paper-trading-v3.md`, `scripts/paper-sim.ts` | this doc + the local simulator (§7). Read-only, no runtime code touched | nothing — ship first, everything below is verified with it |
| **A** | `fix/paper-slot-from-cron` | `.github/workflows/paper-portfolios.yml`, new `app/api/paper/version/route.ts` | §5.2 (cron→slot, lateness guard, deploy wait, issue dedupe, 09:45 preopen) | nothing; ship first, it's small |
| **B** | `fix/paper-engine-correctness` | `lib/shared/paper-engine-core.ts`, `lib/paper-engine.ts`, `lib/live-price-db.ts`, `lib/paper-db.ts`, tests | §5.1 items 1–8 | F5 is live the moment T2 holds > 3% |
| **C** | `feat/paper-seed-book` | `scripts/seed-paper-book.mjs`, `migrations/*` (slot `seed`) | D1 | ⚠️ migration: sensitive surface, confirm first |
| **D** | `feat/paper-persona-tiebreaks` + upstream card-horizon fix | `lib/shared/paper-policy.ts` (v3), new `lib/shared/paper-persona.ts`, card writer | §3 tie-breaks, §5.3 policy v3, CHAIR consensus, §5.4 | needs B merged (same planner) |
| **E** | `feat/paper-trade-tickets` | `lib/paper-arbitration.ts`, `lib/paper-engine.ts` (ticket write), `lib/shared/paper-narrative.ts` | §4.1 tickets, §4.2 arbitration v3 | needs B |
| **F** | `feat/paper-journal` | `migrations/*` (`paper_journal`), `lib/paper-journal.ts`, dashboard | §4.3–4.5 | ⚠️ migration; needs E |

This is the point where **`/wait-merge1`** (queue of A→F with generalized fixes) or
**`/fixy`** (for B's stop/turnover bug specifically) would take over. Pick one before starting.

**Start PR A (preflight + branch):**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && git fetch origin main && git worktree add ../nuwrrrld-portal-paper-slot -b fix/paper-slot-from-cron origin/main && cd ../nuwrrrld-portal-paper-slot && git status -sb
```
Expect: `## fix/paper-slot-from-cron...origin/main`, clean.

**Verify PR A after merge (read-only; wait for the next scheduled run):**

```bash
gh run list --repo adamaslan/nuwrrrld-portal --workflow paper-portfolios.yml --event schedule --limit 8 \
  --json databaseId,createdAt,conclusion --jq '.[] | "\(.databaseId) \(.createdAt) \(.conclusion)"' \
| while read id at c; do echo "$at $c $(gh run view "$id" --repo adamaslan/nuwrrrld-portal --log 2>/dev/null | grep -m1 -oE 'Resolved slot: [a-z]+')"; done
```
Expect: each resolved slot matches the cron that fired, and no more than one `settle` per day actually runs trades (the rest are `alreadyRan`).

**Verify PR B's stop fix (local, no DB):**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx vitest run __tests__/paper-engine-core.test.ts
```
Expect a new test named like `stop sell is not blocked by the turnover cap` to pass.

---

## 7. Running it locally — SQLite, live prices, and simulating in chat

Everything in §2 was produced by `scripts/paper-sim.ts`, added in this branch.
It imports the **same pure planner the production route uses**
(`lib/shared/paper-engine-core.ts` + `paper-policy.ts`), so a plan it prints is the plan the
engine would produce from the same inputs, not a reimplementation that can drift. It is
**read-only by contract**: SQLite is opened with `readOnly: true`, Neon is only ever SELECTed,
and refreshed prices live in memory and are never persisted.

This is a narrow slice of the "live local DB" idea that
[local-sqlite-backup-and-offline-dev.md](local-sqlite-backup-and-offline-dev.md) §4 scoped and
declined to build. That section is still right: `lib/db.ts` is hardcoded to Neon's HTTP driver
and 26 files import it, so the *app* cannot run on SQLite cheaply. The paper **planner** can,
because it's pure and touches no DB at all — `paper-sim.ts` does the I/O itself and hands the
planner plain objects.

### 7.1 One-time: take a local snapshot

**Step 1 — preflight.**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --version && grep -c '^DATABASE_URL=' ../nuwrrrld-portal/.env.local
```
Expect Node **v22.5+** (`node:sqlite` is built in — nothing to install) and `1`.

**Step 2 — snapshot the 9 tables the simulator reads.** `ticker_universe` is not optional:
it's the FK parent of `paper_watchlists`, and the backup aborts with 2,457 FK violations
without it.

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local \
  scripts/backup-to-sqlite.mjs \
  --tables=paper_accounts,paper_watchlists,paper_positions,paper_runs,paper_orders,paper_nav,ticker_cards,live_prices,ticker_universe \
  --out=backups/paper-local.sqlite
```
Expect `Done in ~1s — 9 tables, ~3,688 rows`. `backups/.gitignore` already excludes
`*.sqlite`, so this never gets committed.

> The pre-existing `backups/nuwrrrld-2026-09-11.sqlite` will **not** work: it predates the
> paper tables entirely (`paper_accounts` missing) and its `live_prices` is empty. Take a fresh
> one.

**Step 3 — verify the snapshot standalone (no credentials needed from here on).**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("backups/paper-local.sqlite",{readOnly:true});for(const t of ["paper_accounts","paper_watchlists","ticker_cards","live_prices"])console.log(t,d.prepare(`select count(*) c from ${t}`).get().c)' 2>/dev/null
```
Expect `paper_accounts 8`, `paper_watchlists 501`, `ticker_cards 1956`, `live_prices 176`.

### 7.2 Run the simulator

`tsx` is not a dependency of this repo; `npx -y tsx` fetches it on first use and caches it.

**Every bot's plan for the next slot, from the local file:**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite
```

Expect exactly the §2 forecast, plus the overlap block:

```
t1     buy≥ 40  eligible  10  turnover  15.0%  arb 0  buy UNH 6.0%, buy DASH 6.0%, buy DUK 3.0%
t2     buy≥ 20  eligible  13  turnover   3.0%  arb 0  buy UNH 3.0%
risk   buy≥ 60  eligible   4  turnover   8.0%  arb 3  buy KMB 3.0%, buy PFE 3.0%, buy UNH 2.0%
macro  buy≥ 30  eligible  11  turnover   6.0%  arb 0  buy UNH 6.0%
quant  buy≥ 50  eligible   7  turnover  12.0%  arb 0  buy UNH 4.0%, buy DUK 4.0%, buy HD 4.0%
chair  buy≥ 40  eligible  11  turnover   8.0%  arb 0  buy UNH 5.0%, buy DUK 3.0%

Overlap — the same name bought by several bots:
  UNH    6/6 bots: t1, t2, risk, macro, quant, chair
  DUK    3/6 bots: t1, quant, chair
```

**Straight off production, read-only** (same output — verified identical to the snapshot run,
which is itself a useful parity check on the backup):

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx --env-file=../nuwrrrld-portal/.env.local scripts/paper-sim.ts --neon
```

**Trade tickets (§4.1), rendered without any model:**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --account=risk --narrate
```
Expect three tickets with stop prices, the tie list, the arbitration flag, and a
`⚠️ Reference price is 19.8h old` line — the §5.1.2 staleness check, visible before it's built.

**What v3's proposed thresholds would change:**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --policy=v3
```

**Machine-readable, for diffing two runs or feeding a notebook:**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --json > /tmp/plan-v2.json && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --policy=v3 --json > /tmp/plan-v3.json && diff <(jq -S . /tmp/plan-v2.json) <(jq -S . /tmp/plan-v3.json) | head -40
```

### 7.3 Populate with real data from the financial APIs

The snapshot's prices are as old as the snapshot. `--prices=alpaca` refreshes them **in memory
only** from Alpaca's IEX latest-trade endpoint, reusing `scripts/lib/alpaca-live-prices.mjs` so
symbology (`BRK.B` ↔ `BRK-B`) and the stale-trade rule are identical to the production writer.

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx --env-file=../nuwrrrld-portal/.env.local scripts/paper-sim.ts --db=backups/paper-local.sqlite --prices=alpaca
```
Expect a first line like `prices: refreshed 175/175 from alpaca (in memory, not persisted)`.

Per [market-data-fallback](~/.claude/rules/market-data-fallback.md) the chain is
**yfinance → Alpaca → Finnhub**. The simulator implements the Alpaca rung because it's the one
with a pure, already-tested helper in this repo and it works from a laptop IP. The other two:

- **yfinance** is Python. To refresh from it, use homebase's existing fetchers in the `fin-core`
  mamba env and write the result into the snapshot's `live_prices` — the snapshot is a plain
  SQLite file, so any writer works:
  ```bash
  cd ~/code/homebase && mamba run -n fin-core python -c "
  import sqlite3, datetime as dt, yfinance as yf
  db = sqlite3.connect('/Users/adamaslan/code/nuwrrrld-portal-paper-prices/backups/paper-local.sqlite')
  tickers = [r[0] for r in db.execute('SELECT DISTINCT ticker FROM paper_watchlists WHERE active = 1')]
  data = yf.download(tickers, period='1d', progress=False)['Close'].iloc[-1]
  now = dt.datetime.now(dt.timezone.utc).isoformat()
  n = 0
  for t, px in data.items():
      if px == px:
          db.execute('UPDATE live_prices SET price = ?, traded_at = ? WHERE ticker = ?', (float(px), now, t)); n += db.total_changes > 0
  db.commit(); print('updated rows for', len(data), 'symbols')
  "
  ```
  > If this errors with `YFRateLimitError`, that's the documented yfinance failure the fallback
  > rule exists for — use `--prices=alpaca` above instead and note the fallback.
- **Finnhub** is the third rung; `homebase/finnhub_client.py` already wraps it. Not wired into
  the simulator — add it only if Alpaca and yfinance both fail.

**The snapshot is a sandbox.** Editing it cannot touch production, so it's the right place to
ask "what if": set a position's `avg_cost` down 30% and confirm the stop fires (it currently
doesn't — that's F5), or zero out `live_prices` and watch every bot go quiet.

```bash
cd ~/code/nuwrrrld-portal-paper-prices && cp backups/paper-local.sqlite /tmp/what-if.sqlite && node -e 'const{DatabaseSync}=require("node:sqlite");const d=new DatabaseSync("/tmp/what-if.sqlite");console.log("rows updated:",d.prepare("UPDATE live_prices SET price = price * 0.7 WHERE ticker = ?").run("HRL").changes)' 2>/dev/null && npx -y tsx scripts/paper-sim.ts --db=/tmp/what-if.sqlite --account=risk --narrate
```
Expect the stop to fire **and** the run to flag F13:

```
risk   buy≥ 60  eligible   4  turnover   8.0%  arb 1  sell HRL 2.1%, buy HRL 3.0%, buy KMB 2.9%

⚠️  risk: sold AND re-bought HRL in the same run (F13 — the exit is undone immediately)
```

That one command demonstrates two findings at once: the stop works here (RISK's trailing 5% is
inside its 8% turnover cap — the T2 case in F5 is the one that *cannot* fire), and the exit is
immediately undone (F13). Both are fixed in PR B.

### 7.4 Simulating the narrative layer in Claude chat

`--prompt` emits a paste-ready bundle: **facts only**, with the instruction that no number may
appear in the answer that isn't in the facts. That's §4.3's number lint enforced by
construction, and it's how to try a bot's voice before writing any of PR E/F.

**Arbitration (the veto/downsize/confirm call):**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --account=risk --prompt=arbitration | pbcopy && echo "copied — paste into a Claude chat"
```

**Daily diaries for all six bots:**

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite --prompt=diary | pbcopy && echo "copied — paste into a Claude chat"
```

Paste it, then add the persona from §3 (or just say "use the voices in §3 of
docs/paper-trading-v3.md"). Since the facts carry real tickers, scores, sizes and stop prices,
what comes back is a genuine preview of what PR F would publish — and if the reply contains a
number that isn't in the bundle, that's the lint failing, which is exactly the signal worth
having before shipping it.

### 7.5 Limits of the local run

- **No model calls happen.** `arb N` reports how many trades *would* be arbitrated; it does not
  call OpenRouter. That keeps the simulator free and deterministic. The chat bundle in §7.4 is
  the substitute.
- **No writes, ever** — so it can't tell you whether PERSIST, the Firestore mirror, or
  reconciliation work. Those need a real run.
- **CHAIR's consensus rule (§3) is not modeled**; it needs the other five plans first, which is
  PR D's work. `--policy=v3` applies only the threshold/turnover overlay.
- **The snapshot ages.** Re-run §7.1 Step 2 before trusting a plan; `bar_date` in the header
  line tells you which day's cards you're looking at.

## 8. What "done" looks like for v3

- [ ] Every account holds its seed book, and `equal` / `spy` track the market (§6 Step 4).
- [ ] 4 trading slots per day run with the correct label, or are recorded as mark-only with a reason (PR A).
- [ ] No trade fills on a price older than 30 min (PR B).
- [ ] No plan ever sells and re-buys the same ticker in one run — `paper-sim.ts` prints no
      `⚠️ sold AND re-bought` line for the §7.3 what-if (PR B, F13).
- [ ] On any given day, the six bots' new buys overlap by **< 50%** (Jaccard). Today it's 100% on UNH (PR D).
- [ ] Every open position has a ticket: `thesis`, `invalidation`, and `stop_price` are all non-null (PR E).
- [ ] Every veto has a stored `why` (PR E).
- [ ] Every bot has a settle diary every trading day, and diaries pass the number lint ≥ 95% of the time (PR F).
- [ ] CHAIR publishes a weekly letter every Friday (PR F).
- [ ] The dashboard has been clicked through signed-in against real data once (PR F).
- [ ] `npx -y tsx scripts/paper-sim.ts --db=<fresh snapshot>` and `--neon` still agree (the
      parity check that says the local sandbox is trustworthy).

Check the overlap criterion any day (read-only):

```bash
cd ~/code/nuwrrrld-portal-paper-prices && node --env-file=../nuwrrrld-portal/.env.local --input-type=module -e '
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);
console.table(await sql`SELECT o.ticker, count(DISTINCT o.account)::int bots, string_agg(DISTINCT o.account, ${","}) who
  FROM paper_orders o JOIN paper_runs r ON r.id = o.run_id
  WHERE o.side = ${"buy"} AND r.trade_date = (now() AT TIME ZONE ${"America/New_York"})::date
  GROUP BY o.ticker ORDER BY bots DESC LIMIT 10`);
'
```
Healthy: no ticker bought by more than 3 of the 6 trading bots on the same day.

Or locally, against a fresh snapshot, with no credentials and no production run:

```bash
cd ~/code/nuwrrrld-portal-paper-prices && npx -y tsx scripts/paper-sim.ts --db=backups/paper-local.sqlite | sed -n '/Overlap/,$p'
```
Today that prints `UNH 6/6`. The goal is for this block to be empty or show at most 3/6.
