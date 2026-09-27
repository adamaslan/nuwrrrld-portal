# AI Paper Trading (Council Paper Portfolios): Feature Report and To-Do

**Date:** 2026-09-26, updated 2026-09-27 · **Repo:** `nuwrrrld-portal` · **Design doc:** [council-paper-portfolios.md](council-paper-portfolios.md) · **Tracker:** [paper-portfolios-remaining-todo.md](paper-portfolios-remaining-todo.md) · **Fix PR:** [#188](https://github.com/adamaslan/nuwrrrld-portal/pull/188)

Everything below was read from the code, from `gh` state, and from **read-only** queries against the production Neon database on this date. The 10-trade verification in section 4b wrote nothing to any database. Items not verified are marked *unverified*.

**2026-09-27 update:** two of the three blockers below are fixed and one policy decision is made, all in PR #188 (`fix/paper-workflow-alpaca-prices`, on top of `origin/main`, all required checks green, CodeRabbit reviewed with no open findings). **Not merged yet**, and one more manual step (a Neon account backfill) is required before or immediately after merge — see the new §9. Until that PR merges, every fact in sections 1–8 below that describes the *deployed* state (zero rows, workflow failing, thresholds on the wrong scale) is still accurate; the fixes exist only on the branch.

---

## 0. TL;DR

1. **The feature is fully built (8 of 8 phases) but has never made a trade.** `paper_runs`, `paper_orders`, `paper_positions` and `paper_nav` all have **0 rows**, still true as of 2026-09-27 — nothing below has merged. Three separate blockers stood in the way; fixing any one alone still yields zero trades (section 4b):
   - **The workflow fails before calling the route.** Every scheduled trading-day run since 2026-09-22 fails in its own "Verify required secrets exist" step. **Fixed in PR #188** (§6 A1).
   - **`live_prices` is empty (0 rows).** The engine only fills at a live price, so no ticker can trade. **Fixed in PR #188** (§6 A7/D1) — a new workflow step pushes Alpaca IEX latest trades before each slot.
   - **The policy thresholds are on the wrong scale.** Card scores are on [-100, 100], but `PAPER_POLICY`'s thresholds read like a 0–100 scale. With real scores and real prices, the as-written policy makes **0 trades**. **Decided and shipped as policy `v2` in PR #188** (§6 A8): every threshold rescaled `x → 2x − 100`.
1a. **Alpaca fixed the empty-prices blocker.** The paper key is active, and IEX latest trades and SIP daily bars both return data. `scripts/push-alpaca-live-prices.mjs` (PR #188) now pushes IEX latest trades for the union of the 8 watchlists to `/api/signals/live` before each trading slot; a dry run against production data priced **176 of 176** watchlist tickers (yfinance managed 78 of 176 in §4b). It is still wired into only the paper-portfolios workflow and the portal's hydration job — section 7's wider multi-host rollout (D2–D6) is unstarted.
1b. **The engine logic itself is sound.** A dry run with real cards, real closing prices and thresholds mapped onto the card scale produced **11 trades over two slots, with 0 invariant violations** (section 4b). The six original policy-driven unit test files (88 tests) pass, and PR #188 adds a 7th (Alpaca price helpers) plus updates 4 of the engine-core tests whose hard-coded scores assumed the old `v1` thresholds — **91 tests pass** on the branch.
2. **The engine has no Fibonacci input.** It ranks on one number per ticker (`ticker_cards.score`). Fibonacci exists only in the holdfold live-analysis panel (portal PR #185) and in a new signals-app detector (PR #38). The two do not meet (section 5). Untouched by PR #188.
3. **Recommended Fibonacci path:** do not put Fibonacci into the score. The latest evaluation shows a weak edge (+1.2pp, z 1.8). Use it first as recorded context and as arbitration input, then as a separate falsifiable test account (section 6, Track B). Untouched by PR #188.

---

## 1. What it is

Eight simulated **$10,000** accounts that turn the six AI council personas from text-only verdicts into strategies with a comparable P&L. Six accounts trade under a council seat, and two are baselines.

| Account | Seat / role | Card horizon | Buy ≥ | Sell < | Max position | Cash floor | Turnover / run | Min hold (runs) | Stop | Sector cap | Model calls / run |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `t1` | T1 | t1 | 70 | 45 | 6% | 2% | 15% | 1 | fixed −8% | 25% | 6 |
| `t2` | T2 | t2 | 60 | 30 | 8% | 0% | 3% | 20 | fixed −25% | 30% | 4 |
| `risk` | RISK | t2 | 80 | 55 | 3% | 15% | 8% | 4 | trailing −5% | 15% | 6 |
| `macro` | MACRO | t2 | 65 | 40 | 6% | 5% | 6% | 8 | fixed −15% | 35% | 6 |
| `quant` | QUANT | both | 75 | 50 | 4% | 0% | 12% | 1 | fixed −10% | 25% | **0** |
| `chair` | CHAIR | both | 70 | 45 | 5% | 5% | 8% | 4 | fixed −12% | 25% | 8 |
| `equal` | baseline | n/a | | | | | | | | | 0 |
| `spy` | baseline (holds `IVV`, since `SPY` is not a registered symbol) | n/a | | | | | | | | | 0 |

Source: `PAPER_POLICY` in `lib/shared/paper-policy.ts`, policy version `v1`. `quant` makes zero model calls by construction. It is the deterministic control the model-assisted seats are measured against.

## 2. Feature inventory

### 2.1 Data model (Neon)

Six tables: `paper_accounts`, `paper_runs`, `paper_watchlists`, `paper_positions`, `paper_orders`, `paper_nav`.

- **Fixed watchlists.** A shared Core 50 plus 25 persona-specific names per seat. They are chosen once and never derived at runtime, so two accounts seeded a week apart stay comparable. 501 rows in total (6 × 75 + 50 + 1).
- **Watchlist guard trigger** (`paper_orders_watchlist_guard_trg`). A buy outside an account's active watchlist is rejected at the database level. Sells are always allowed, so a forced exit on a dropped name still works.
- **Idempotent runs.** `paper_runs` is unique on `(account, trade_date, slot)`. A retried cron or manual rerun returns the existing row and never produces a second set of fills.
- **Versioning.** `policy_version` is stamped on accounts and runs, so a NAV series can always be read against the policy that produced it.

### 2.2 Engine (`lib/paper-engine.ts` I/O shell, `lib/shared/paper-engine-core.ts` pure logic)

Per account, per slot: **LOAD → MARK → SCREEN → RANK → PROPOSE → CLIP → ARBITRATE → FILL → PERSIST.**

- **SCREEN:** active watchlist, `ticker_cards.data_quality` at or above the account's gate (0.80 to 0.95), and a fresh `bar_date`. A closed market records `status: skipped`, `skip_reason: market_closed`, never silently.
- **RANK:** raw `score DESC, ticker ASC`. For `both`-horizon accounts it takes the higher of the t1 and t2 score.
- **PROPOSE/CLIP:** sells first (they free cash, turnover and sector room), then buys greedily, checked in order against the turnover cap, position cap, sector cap and cash floor. A candidate that fails a check is skipped, never partially filled.
- **Exits:** stop (fixed or trailing), score below the sell threshold once the minimum hold is met, and a forced exit when a name leaves the watchlist. **A sell is always a full exit.**
- **ARBITRATE (model layer):** `selectArbitrationCandidates` flags buys within 5 score points of the buy threshold (`BUY_TIE_BAND`) and score-exit sells that have closed 80% of the distance to their stop (`NEAR_STOP_FRACTION`). The seat's persona prompt returns a single-line JSON veto, downsize or confirm (`max_tokens=80`, `temperature=0.2`). Bad output degrades to "confirm", never throws. Forced exits (stop, void) are never arbitrated. The model can only shrink or drop an order, never invent a ticker or a size.
- **Model budget:** at most 36 calls per run across all accounts and 108 per day, enforced globally through one `ModelCallBudget`.
- **FILL:** reference price from `live_prices`. Flat slippage of 5 bps for mega and large caps and 15 bps for everything else. A ticker with no live price cannot trade that slot.

### 2.3 Scheduling

`.github/workflows/paper-portfolios.yml` has 8 cron lines (4 slots × EST/EDT):

| Slot | NY time | Trades? |
|---|---|---|
| `preopen` | 09:00 | yes |
| `midday` | 12:30 | yes |
| `preclose` | 15:45 | yes |
| `settle` | 16:30 | no (marks, mirrors, reconciles, scores) |

The gate picks the slot from a wall-clock **window** (fixed in PR #147, after exact-minute matching never fired). `workflow_dispatch` accepts `slot`, `account` and `skip_market_check`. Concurrency group `paper-portfolios`, failure notification job, step summary, and a non-fatal "zero orders on a non-settle slot" sanity check.

The route is `POST /api/pipeline/paper-portfolios?slot=…[&account=…]`. It uses bearer auth with `PAPER_CRON_SECRET`, a per-account try/catch so one failure does not abort the other seven, and `assertNotProductionDb` (see To-Do 2).

### 2.4 Firestore mirror and reconciliation (Phase 6)

Mirrors account summary, positions, orders (doc id = Neon order uuid, so replay is idempotent), the day's NAV and run status, and the watchlist (only when its version changes). At `settle`, `reconcileAccount()` compares Neon against the mirror and writes the result into `paper_runs.detail.reconcile`. With no `FIRESTORE_SERVICE_ACCOUNT_JSON` set, every call is a documented no-op.

### 2.5 Metrics (Phase 8, settle slot only)

CAGR, annualized volatility, Sharpe (rf = 0, `sqrt(252)`), max and current drawdown, hit rate, average win and loss, rolling 20-run turnover, average holding period, and **active return versus `spy` and `equal`**. Written best-effort into `paper_runs.detail.metrics`. A failure never fails the run.

### 2.6 Read API and dashboard (Phase 7)

- Public GETs with a 5-minute in-memory cache: `/api/paper/accounts` (leaderboard), `/api/paper/[account]`, and `/api/paper/[account]/{nav,orders,watchlist}`. They carry aggregate simulated data only.
- `/dashboard/council/portfolios`: Clerk-gated on the **`pro_signals`** entitlement. It has a leaderboard, a per-account drilldown, a CSS-grid table, and a hand-rolled inline-SVG NAV sparkline. It carries a `paper` disclaimer footer.

### 2.6b Safety properties worth keeping

The model never sizes or invents. A missing price means no trade. Runs are idempotent. The mirror and metrics are best-effort. The watchlist is enforced in the database.

## 3. Scoring and what feeds the engine

The rank input is `ticker_cards.score`. Cards are built from five discretized indicator inputs (RSI, MACD cross, ADX and others; `CARD_INPUT_FIELDS` in `lib/shared/card-policy.ts`) and are versioned (`CARD_SCORE_V1`). The paper engine reads only the score and the data-quality field. It reads **no** pivots, levels or zones, and no history (`ticker_cards` is one row per ticker and horizon, not a series).

## 4. Current state — deployed 2026-09-26, still true 2026-09-27 pending PR #188

Everything in this table describes **production as deployed today**. PR #188 fixes the first three rows marked "Failing"/"0 rows"/"wrong scale" but has not merged, so production still behaves exactly as recorded here.

| Item | State | Evidence | PR #188 status |
|---|---|---|---|
| Code, phases 1 to 8 | Built and merged | PRs #124, #127, #128, #137, #138, #140 and the Phase 7 branch; slot-gate fix #147 | — |
| Seeded | Yes, 2026-09-22: 8 accounts and 501 watchlist rows | remaining-todo doc | — |
| **Scheduled runs** | **Failing on every trading-slot tick** | `gh run list --workflow paper-portfolios.yml`: the only successes are 2026-09-22 (two runs) and one weekend no-op on 2026-09-26. Every trading-day run from 2026-09-22 22:25Z through 2026-09-25 23:34Z is `failure`. | **Fixed**, unmerged (§6 A1) |
| Cause | `gh secret list` inside the run job returns `HTTP 403: Resource not accessible by integration` | run 36201563556 log. The step uses the default `GITHUB_TOKEN`, which cannot list Actions secrets. The job exits before the route is called. | **Fixed**, unmerged. 4 sibling workflows (`afternoon-pipeline`, `judge-followed-tickers`, `select-followed-tickers`, `track-followed-tickers`) have the identical defect and are **not** fixed by this PR. |
| Consequence | No slot has run from the schedule. **Confirmed: 0 rows in `paper_runs`, `paper_orders`, `paper_positions`, `paper_nav`**, so the two 2026-09-22 "successes" did not record a run either | read-only query, 2026-09-26, re-confirmed 2026-09-27 | Still 0 rows — nothing has merged or dispatched yet |
| Seed | 8 accounts, 176 distinct active watchlist tickers, $10,000 cash each | read-only query | All 8 rows still stamped `policy_version = 'v1'` as of 2026-09-27; a Neon backfill to `'v2'` is required before/at merge — see §9 |
| **`live_prices`** | **0 rows.** Its only writer is `POST /api/signals/live`, fed by `homebase/modal_finnhub_ws.py`, which is evidently not pushing | read-only query; `app/api/signals/live/route.ts` | **Fixed**, unmerged (§6 A7/D1). Second writer added: `scripts/push-alpaca-live-prices.mjs`, run from the workflow before each slot. Dry run priced 176/176 watchlist tickers against production data, wrote nothing. |
| **Card score scale** | `ticker_cards` holds one bar date (2026-09-26), 1,956 cards. Scores run −60 to 100; 826 of 978 t1 cards sit at 0–5. For the 176 watchlist names, the maximum is 60 and the mean 4.5 | read-only query; `scoreCard()` in `lib/shared/card-policy.ts` returns [-100, 100] and calls ≥35 a BUY | **Decided and shipped**, unmerged (§6 A8): `PAPER_POLICY_VERSION` bumped to `v2`, every buy/sell threshold rescaled `x → 2x − 100` |
| Dashboard click-through | Never done in a browser | remaining-todo Phase 7 note | Not addressed (§6 A5) |
| `OPENROUTER_API_KEY` in the run environment | **Confirmed present** in Vercel production | `vercel env ls production`, 2026-09-27 | Checked (§6 A3/A6) |
| `PRODUCTION_DB_HOST` | **Confirmed unset** in Vercel production — the live-run guard (`assertNotProductionDb`) is inert, so it does not block the paper route | `vercel env ls production`, 2026-09-27; `lib/pipeline-db-guard.ts` | Checked (§6 A3) — was an open question, now closed |
| `PORTAL_PUSH_SECRET`, `PAPER_CRON_SECRET`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `PORTAL_URL` | **All 5 already exist** as GitHub Actions repo secrets | `gh secret list --repo adamaslan/nuwrrrld-portal`, 2026-09-27 | Checked (§6 A6) — nothing to provision |
| `FIRESTORE_SERVICE_ACCOUNT_JSON` | Confirmed **absent** — mirror and reconcile stay no-ops | `vercel env ls production`, 2026-09-27 | Unchanged, not blocking |
| First written finding (does any seat beat `quant`?) | Not started, by design | needs weeks of real runs | Unchanged — needs #188 merged, backfilled, and running for weeks |

## 4b. Verification: 10 trades, dry run (2026-09-26)

**Goal:** show the engine produces at least 10 correct trades from real data, without writing to the database.

**Method.**

- **What ran:** a scratch script that calls the repo's own read queries (`getAccount`, `getPositions`, `listActiveWatchlist`, `getScreenCandidates`, `getLivePrices`, `latestCardBarDate`) and the real pure functions `planRun` and `fillOrders`. It imports no write functions.
- **Prices:** `live_prices` is empty, so the script used Friday 2026-09-25 closes from yfinance (`fin-core` env). Yahoo rate-limited the download, so only **78 of 176** tickers got a price. The rest could not trade, as the real engine would behave with a missing price.
- **Two slots:** slot 2 (midday) starts from slot 1's post-fill book, applied with the same rules as `lib/paper-engine.ts`.
- **Checks after every order:** the fill price equals the reference price ± slippage bps; every buy is on the watchlist and at or above the buy threshold; turnover stays within its cap; cash stays at or above the floor; position and sector weights stay within their caps (tolerance 0.01pp).
- **Not exercised:** arbitration (no model calls were made), persistence, idempotency, the Firestore mirror, and metrics.

**Unit tests:** `npx vitest run --project unit` on the 6 paper test files gives **88 passed**. **Update 2026-09-27:** PR #188 adds a 7th file (`__tests__/alpaca-live-prices.test.ts`, the Alpaca price-mapping helpers) and updates 4 tests in `__tests__/paper-engine-core.test.ts` whose scores were hard-coded against `v1` thresholds. On the branch, `npx vitest run --project unit paper alpaca` gives **91 passed**.

**Result: the policy as written makes 0 trades.** Across all six accounts, not one watchlist ticker that has a price scores at or above its account's buy threshold (60 to 80).

**Result: with thresholds mapped onto the card scale, 11 trades and 0 violations.** The mapping is linear, `x → 2x − 100`, so 70 becomes 40, 60 becomes 20, 80 becomes 60, and so on. This is a **test harness, not a proposed policy.**

| Slot | Account | Side | Ticker | Score | Qty | Ref | Fill (bps) | Notional |
|---|---|---|---|---|---|---|---|---|
| preopen | t1 | buy | RTX | 54 | 3.1679 | 189.40 | 189.4947 (5) | 600.30 |
| preopen | t1 | buy | COST | 50 | 0.6502 | 922.77 | 923.2314 (5) | 600.30 |
| preopen | t2 | buy | RTX | 54 | 1.5839 | 189.40 | 189.4947 (5) | 300.15 |
| preopen | macro | buy | RTX | 54 | 3.1679 | 189.40 | 189.4947 (5) | 600.30 |
| preopen | quant | buy | RTX | 54 | 2.1119 | 189.40 | 189.4947 (5) | 400.20 |
| preopen | quant | buy | COST | 50 | 0.4335 | 922.77 | 923.2314 (5) | 400.20 |
| preopen | chair | buy | RTX | 54 | 2.6399 | 189.40 | 189.4947 (5) | 500.25 |
| preopen | chair | buy | COST | 50 | 0.3251 | 922.77 | 923.2314 (5) | 300.15 |
| midday | t2 | buy | RTX | 54 | 1.5839 | 189.40 | 189.4947 (5) | 300.15 |
| midday | macro | buy | COST | 50 | 0.6502 | 922.77 | 923.2314 (5) | 600.28 |
| midday | chair | buy | COST | 50 | 0.2167 | 922.77 | 923.2314 (5) | 200.08 |

**What this confirms:**

- **Caps bind as designed.**
  - t1 and quant fill both names to exactly their position caps (6% and 4%), then place **no** orders at midday.
  - t2's 3% turnover cap allows one RTX buy per slot.
  - chair's second COST buy at midday is clipped to $200.08, which is the room left under its 5% cap after slippage lowered its NAV.
  - macro's 6% turnover allows one buy per slot.
- **Ranking is correct.** Where turnover allows only one buy, the higher score (RTX, 54) wins over COST (50).
- **Fills are correct.** Both names are in the mega/large-cap set and got 5 bps. `cash − notional` reconciles exactly.
- **`risk` correctly makes no trades.** Its mapped threshold is 60 and nothing priced reaches it.

**What this does not confirm:** sells and stops, since no position aged past its minimum hold, and every trade was a buy in one of only two names. **A sell-side caution also applies to the as-written policy:** sell thresholds of 30–55, against scores mostly at 0–5, mean every position would be sold on signal as soon as its minimum hold expires.

**Reproduce.** The scripts are in this session's scratchpad and are not committed. Re-creating them is item A9 below.

## 5. Fibonacci: what exists and how it relates

Companion docs (in `homebase/docs/`): `fibonacci-signals-playbook.md` and `fibonacci-rollout-issues-2026-09-26.md`.

| Piece | Repo / PR | State |
|---|---|---|
| Fibonacci ladder in the holdfold live-analysis panel | `nuwrrrld-portal` #185 | open, CI green, **CodeRabbit rate-limited, no review** |
| `FibonacciDetector` (default: one signal, golden-pocket hold on above-average volume; the rest behind `experimental=True`) | `signals-app` #38 | open; backend CI fails only on 3 known staleness tests, fixed by #36, which must merge first |
| Direction-aware retracement prices | `mcp-finance1` #47 | open; **no CI in that repo** |
| Nearest-8 levels instead of first-8 | `holdemfoldemapp` #16 | open |
| `FibLevel` type fix (mobile) | `gcp3-mobile` #49 and #48 | open |

**Evidence quality.** The third-pass evaluation (`signals-app/scripts/eval_fibonacci.py`) gives **+1.2pp (z 1.8)** for the shipped signal on the full seed universe, and +1.1pp on the 63-bar window the scheduled scan uses. The earlier +4.4pp figure did not hold. Non-Fibonacci control zones performed similarly, so it is not proven Fibonacci-specific. Sample: one five-year window in a mostly rising market, no costs.

**Integration gap.** The paper engine reads Neon `ticker_cards`. The signals-app writes detector hits to Supabase. *I did not verify any bridge between them.* Today Fibonacci cannot reach the engine, even after #38 merges.

## 6. To-do list

Commands were checked against the workflow file and `gh` output on this date. Run from any directory unless noted.

### Track A: get the existing feature actually running (do this first)

**Status as of 2026-09-27:** A1, A3, A6, A7/D1 and A8 are done, all on PR #188, unmerged. A2, A4, A5 and A9 are the remaining open items — see §9 for the exact order.

**A1. Fix the secrets pre-check in the workflow.** ✅ **Done, in PR #188.** Blocking. 🖱 Editor change, no CLI equivalent. In `.github/workflows/paper-portfolios.yml`, replace the whole "Verify required secrets exist" step in `run-slot` (it calls `gh secret list`, which `GITHUB_TOKEN` cannot do) with a check on the environment values the next step already receives:

```yaml
      - name: Verify required secrets exist
        env:
          PORTAL_URL: ${{ secrets.PORTAL_URL }}
          PAPER_CRON_SECRET: ${{ secrets.PAPER_CRON_SECRET }}
        run: |
          [ -n "$PORTAL_URL" ] || { echo "PORTAL_URL secret missing"; exit 1; }
          [ -n "$PAPER_CRON_SECRET" ] || { echo "PAPER_CRON_SECRET secret missing"; exit 1; }
```

Then open the PR per the repo flow (`/pr-nwf`). Look for the sibling workflow `track-followed-tickers.yml`, which this step was copied from: it may have the same defect.

```bash
cd ~/code/nuwrrrld-portal && grep -n "gh secret list" .github/workflows/*.yml
```

Expect: every workflow line listed is a candidate for the same fix. **Confirmed 2026-09-27: 4 more hits** — `afternoon-pipeline.yml`, `judge-followed-tickers.yml`, `select-followed-tickers.yml`, `track-followed-tickers.yml`. **None of these 4 are fixed by PR #188** — it touches only `paper-portfolios.yml`. Each needs the identical fix in its own PR.

**A2. After A1 merges, force one real slot and read the result.** ⬜ **Open — this is the next step (§9.1).**

```bash
gh workflow run paper-portfolios.yml --repo adamaslan/nuwrrrld-portal -f slot=preopen -f skip_market_check=true
```

Expect: the command prints nothing on success. Then check it:

```bash
gh run list --workflow paper-portfolios.yml --repo adamaslan/nuwrrrld-portal --limit 3
```

Expect: the newest run is `success`. If it is `failure`, read its log for the HTTP status the route returned (401 means secret mismatch, 403 means the production-DB guard, see A3).

**A3. Check whether the production-DB guard will block every run.** ✅ **Checked 2026-09-27, not a blocker.** The route refuses to run when `DATABASE_URL`'s host equals `PRODUCTION_DB_HOST`, and the remaining-todo doc says `DATABASE_URL` points at production with no non-prod branch. Check whether the variable is set in production:

```bash
cd ~/code/nuwrrrld-portal && vercel env ls production | grep -E 'PRODUCTION_DB_HOST|PAPER_CRON_SECRET|OPENROUTER_API_KEY|FIRESTORE_SERVICE_ACCOUNT_JSON|MCP_ANALYZE_URL'
```

Expect: `PAPER_CRON_SECRET` and `OPENROUTER_API_KEY` present. If `PRODUCTION_DB_HOST` is present, the paper route will return 403 in production, and this is a design conflict (a scheduled production writer versus a "never live-run against prod" guard) that needs a decision, not a workaround. **Result: `PRODUCTION_DB_HOST` is unset. `assertNotProductionDb` (`lib/pipeline-db-guard.ts`) is opt-in and warns once rather than blocking when unset — the route will not 403.** `PAPER_CRON_SECRET` and `OPENROUTER_API_KEY` are both present, confirming A6 below.

**A4. Confirm rows landed.** ⬜ **Open — after A2 (§9.1).** The read API is public. Set `PORTAL_URL` first if it is not already in your shell.

```bash
curl -s "$PORTAL_URL/api/paper/accounts" | jq '.accounts | length'
```

Expect: `8`. After a settle run, the metrics fields stop being empty.

**A5. Click through the dashboard signed in.** ⬜ **Open, unchanged.** 🖱 Open `/dashboard/council/portfolios` with a `pro_signals` account. It has never been rendered against real data.

**A7. Get `live_prices` populated.** ✅ **Done, in PR #188.** Blocking: without it, even a fixed workflow makes 0 trades. The only writer is `POST /api/signals/live`, fed by `homebase/modal_finnhub_ws.py`. First, check whether that Modal app is deployed:

```bash
cd ~/code/homebase && modal app list 2>&1 | grep -i finnhub
```

Expect a running app. If there isn't one, it has to be deployed before any trade can happen. Alternatively, you can decide to give the engine a fallback reference price (the last close). That is a design change: the Phase 3 decision was to never fill at a stale price, so it needs your call. **Not checked** — Alpaca was implemented instead, so whether this Modal app exists no longer matters for unblocking trades.

**The recommended fix is Alpaca** (section 7, item D1). ✅ **Implemented, in PR #188** as `scripts/push-alpaca-live-prices.mjs` — the paper workflow's runner fetches Alpaca IEX latest trades for the union of all 8 watchlists and posts them to `/api/signals/live` before calling the paper route, with a 5-day freshness window, retry with backoff on 429/5xx, and a `timeout-minutes: 5` cap so an outage can't hold the slot (`continue-on-error: true`). A read-only dry run against production data on 2026-09-27 priced **176 of 176** watchlist tickers. The keys already worked, and the pattern already existed in `hydrate-universe.yml`.

**A8. Decide the threshold scale.** ✅ **Decided and shipped, in PR #188.** A policy decision, not a code fix. `PAPER_POLICY`'s buy and sell thresholds need to be expressed on `scoreCard`'s [-100, 100] scale. Section 4b's linear map is one option; the card layer's own BUY cutoff of ≥35 is another reference point. Whichever you choose, bump `PAPER_POLICY_VERSION` to `v2`, since policy versions are stamped on every run. Check the current values first:

```bash
cd ~/code/nuwrrrld-portal && grep -nE 'buyThreshold|sellThreshold|PAPER_POLICY_VERSION' lib/shared/paper-policy.ts
```

**Decision made: section 4b's linear map**, `x → 2x − 100`, applied to every seat's buy and sell threshold (T1 buy 70→40, sell 45→−10; QUANT buy 75→50, sell 50→0; and so on for T2, RISK, MACRO, CHAIR). `PAPER_POLICY_VERSION` bumped to `v2`, both in `lib/shared/paper-policy.ts` and `scripts/seed-paper-portfolios.mjs`. The 4 engine-core unit tests that hard-coded scores against the old `v1` levels were updated to match. **This is a rescale carried over from the test harness, not a levels backtest — treat v2 as a starting point to observe, not a validated policy.** CodeRabbit's review of this change flagged that existing `paper_accounts` rows stay stamped `v1` in Neon (they only select the policy by account name, not by version, but they *label* every run's stored `policy_version` with whatever the row says) — that backfill is §9's remaining manual step.

**A9. Commit the dry-run harness** as `scripts/paper-dryrun.ts`. ⬜ **Still open, not done.** It should be read-only, take `PRICES_JSON`, `SCENARIO` and `SLOTS` settings, and assert every invariant. That way this check can be rerun after A1, A7 and A8 without writing to production. (The scratch script referenced in §4b was still not committed as of this update — it remains reproducible only by re-deriving it.)

**A6. Provision the two optional secrets** if A3 shows them missing (otherwise arbitration and the mirror are silent no-ops). Use the `secrets-sync` skill so no value passes through chat. ✅ **Checked 2026-09-27 — nothing to provision.** `gh secret list --repo adamaslan/nuwrrrld-portal` shows all 5 secrets the workflow needs already present: `PORTAL_URL`, `PORTAL_PUSH_SECRET`, `PAPER_CRON_SECRET`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`.

### Track B: Fibonacci integration (ordered by evidence, cheapest first)

The rule for all of Track B: **no Fibonacci input reaches RANK until it beats `quant` on real paper data.** The current edge is too small and too uncertain to move real allocation.

**B0. Prerequisites (from the rollout doc, not paper-trading work).** Merge signals-app #36, rebase and merge #38, merge portal #157 then #185, and request the two missing CodeRabbit reviews. Also decide whether the 63-bar production window is acceptable, since the +1.1pp measurement was on that window.

**B1. Record Fibonacci context on every order, with no behavior change.** For each filled order, store the nearest support and resistance levels and the distance from the fill price as a JSON blob on the run detail (`paper_runs.detail`, which already carries reconcile and metrics). *Unverified whether `paper_orders` has a free-form column; prefer the run detail if not.* This yields data to test on after a few weeks and changes no fills. Bump `PAPER_POLICY_VERSION` only if a policy value changes, and it should not here.

**B2. Add a Fibonacci-aware tiebreaker to arbitration.** The natural insertion point is the arbitration step, because it already handles the near-threshold buys (`BUY_TIE_BAND` = 5 points) and has a hard rule that the model can only veto or downsize. Pass **computed** nearest levels into the prompt (never ask the model to derive levels), so the veto is grounded. Cost: 80 output tokens per call, inside the existing 36 per run and 108 per day ceilings. Measure it against the same account without the context (see B3), otherwise it is unfalsifiable.

**B3. Add a tenth-account experiment instead of changing the six.** A `fib` account that buys only when the signals-app detector's golden-pocket-with-volume signal fires, and is otherwise identical to `quant` (same thresholds, zero model calls). It runs alongside `quant`, so the active-return comparison (`fib` minus `quant`) is the whole test. *Unverified: whether `paper_accounts.account` has a CHECK constraint on the eight names; the schema and `PaperAccount` type need changing either way, so this is a schema-migration item and needs the confirmation gate.* It also requires the Neon/Supabase bridge in B4, and a watchlist decision (501 rows is 6 × 75 + 50 + 1, so a new account needs its own count).

**B4. Decide how detector hits reach Neon.** Either the signals-app publishes a small hits table the portal reads, or the portal computes the one golden-pocket condition itself from price history it already holds. The second is simpler but duplicates a detector across repos, which is the drift the mobile-parity work is trying to avoid. Needs a decision before B3.

**B5. Fibonacci exits, but only the ones that have support.** The evaluation found the 0.786 break and the 1.618 target at or near baseline. Do **not** add a 1.618 take-profit or a 0.786 stop. If exits are wanted, test "below the pivot low that anchored the leg" as a candidate on the B3 account only.

**B6. Show levels next to positions on the drilldown.** After #185 merges, `lib/shared/fib-levels.ts` can be reused for a small ladder on the per-account drilldown. This is display only. Mobile adoption waits on #185 and goes through `/syncpr`.

**B7. Do not do these yet:** adding Fibonacci columns to the card scorer (needs a `CARD_SCORE_V2` bump and a retrain), and per-seat Fibonacci tilts (the seats are meant to differ by policy, not by extra signals, and B3 is the cleaner experiment).

### Track C: existing engine backlog

- [ ] **Per-seat tilt functions** (momentum for `t1`, inverse-vol for `risk`, sector rotation for `macro`, state persistence for `t2`). Deferred in Phase 3 because `ticker_cards` stores no series. Until then all six accounts share the same RANK, so the personas differ only by thresholds, caps and arbitration. That weakens the "does any seat beat `quant`" question.
- [ ] **Mirror skipped runs** to Firestore (`skipped` market-closed runs are recorded in Neon only).
- [ ] **Mirror the inactive watchlist history** (`active: false`, `drop_reason`).
- [ ] **Partial trims.** An oversized existing position is never trimmed, since a sell is a full exit.
- [ ] **Realistic fills.** Slippage is a flat 5 or 15 bps tier. There are no partial fills, spreads or liquidity limits.
- [ ] **Non-production Neon branch.** No live non-prod branch exists, so live-run testing has nowhere safe to go.
- [ ] **Open design questions:** does CHAIR read a fresh card pass or a consensus of the other five seats' targets, the reset cadence (leaning never), and whether RISK needs shorts to be a fair test.
- [ ] **First written finding** (`docs/wiki-portal/decision-paper-portfolio-first-finding.md`) once several weeks of settle runs exist.
- [ ] **Unit test for the workflow gate** (the slot window logic was wrong once and was caught only by reading live runs).

## 7. Alpaca as the main yfinance backup (D1 implemented 2026-09-27; D2–D6 to implement later)

**Policy** (standing rule `~/.claude/rules/market-data-fallback.md`): Alpaca is the primary fallback for yfinance on every host (local, GCP Cloud Run, GitHub Actions, Modal). Bars go yfinance → Alpaca → Finnhub; quotes go yfinance → Alpaca latest trade → Finnhub. Every result records its source and feed. **D1 (below) is implemented, in PR #188. D2 through D6 are not.**

### 7.1 Is Alpaca available? (checked 2026-09-26, read-only)

| Check | Result |
|---|---|
| Keys | `ALPACA_API_KEY` / `ALPACA_API_SECRET` in `nuwrrrld-portal/.env.local` only. No other local project has them. |
| Account type | **Paper** account, `ACTIVE`, not blocked. The live endpoint (`api.alpaca.markets`) returns 401 for this key. Order code must only ever use `paper-api.alpaca.markets`. |
| Market data, IEX latest trades | HTTP 200. RTX 189.365, COST 922.76, MSFT 516.155, NVDA 225.05 (Friday close). These match the yfinance closes used in section 4b to within cents. |
| Market data, SIP daily bars | HTTP 200 for bars older than 15 minutes, so consolidated volume is available for end-of-day history. |
| Wired into | **One job only:** portal `hydrate-universe.yml` → `scripts/hydrate-local.mjs`, as the *primary* daily-bar source, IEX feed. Its own header says the portal itself never talks to Alpaca. |

### 7.2 Is any of it in the databases?

- **Neon: no price data anywhere.** I scanned every price-, close- and quote-like column:
  - `live_prices`: 0 rows.
  - `ticker_cards.numerics`: `{}` on all 1,956 rows. Hydration fetches Alpaca bars, computes indicators, then discards the bars.
  - `followed_ticker_*` price columns: 0 rows.
  - `paper_orders`: 0 rows.
  - There is **no `daily_bars` table** yet.
- **Supabase (signals-app) and Firestore (gcp3):** not checked in this session. Both are fed by yfinance or Finnhub, not Alpaca.

### 7.3 How it fits the cloud engine plan (`homebase/harness/CLOUD-ENGINE.md`)

Yes, Alpaca is central to that plan. Phase 1 makes Alpaca bars the engine's data plane:
1. **Store the bars.** `daily_bars` keeps the bars hydration already fetches instead of discarding them. The table is keyed by `(ticker, feed, bar_date)`, so IEX and SIP never mix.
2. **Run the engine in shadow mode** on those bars.
3. **Add an `engine` paper account** that trades its hits.

Status from `harness/ENGINE-PROGRESS.md`:
- **The code is on branch `feat/engine-fib-core`** in the `~/code/nuwrrrld-portal-engine` worktree. It has 4 commits, is **not pushed, and has no PR**.
- **What's done:** the schema, the bar fetcher (`scripts/engine-bars.mjs`), the `engine-run` route, the nightly workflow, and the pure core for the engine paper account.
- **What isn't:** the fetcher and workflow have never run against Alpaca, and the engine paper account's I/O half isn't written.
- **Open decisions:** IEX vs SIP (the check above now answers "SIP is available"), and signals-app PR #38.

Once `daily_bars` exists, the paper engine could also use the last stored close as its reference price. That's the same stale-price design decision flagged in A7.

### 7.4 Rollout: one PR per host, in this order

| # | Host | Where yfinance runs | Current chain | Change | Alpaca keys there? |
|---|---|---|---|---|---|
| D1 | Portal paper trading (GHA) | ~~none; `live_prices` is empty~~ **done** | ~~none~~ **`scripts/push-alpaca-live-prices.mjs`** | In `paper-portfolios.yml`, before the run step: fetch Alpaca IEX latest trades for the active watchlist and `POST /api/signals/live` (bearer `PORTAL_PUSH_SECRET`). **Unblocks A7.** ✅ **Implemented in PR #188, unmerged; dry run priced 176/176.** | GitHub: **yes**. Vercel: no, and none needed. |
| D2 | signals-app (GHA: `signals-scan`, `backfill`, `calibrate`, `retrain`) | `src/signals_app/data/fetcher.py` `_fetch_from_yfinance` | yfinance with retries only | Add `_fetch_from_alpaca` after the retries are exhausted, keeping `_normalize_df` output identical. Record `source`. | GitHub: **no** (only the 2 Supabase secrets) |
| D3 | gcp3 (Cloud Run `gcp3-backend`, GHA `tracker-feed.yml`) | `backend/data_client.py` plus about 11 modules calling `yf.` directly | Finnhub → yfinance | Insert Alpaca after yfinance in `data_client.py`, then route the direct `yf.` callers through `data_client` | GCP Secret Manager (`ttb-lang1`): **no**. GitHub: **no** |
| D4 | mcp-finance1 (Cloud Run `technical-analysis-mcp`, also feeds holdem) | `src/technical_analysis_mcp/data.py` | Finnhub → Alpha Vantage → yfinance | Add Alpaca after yfinance. The repo has no CI, so verify locally (rule `exhaust-local-first`). | GCP: **no** |
| D5 | homebase local (`locrun.py`, `refresh-signals.py`) and Modal (`modal_locrun.py`, `modal_drain.py`, `modal_finnhub_ws.py`) | `analyze()` / `analyze_ticker()` | yfinance, plus Finnhub enrichment | Shared `alpaca_bars.py` helper, used when `yf.Ticker(...).history()` is empty or raises | `homebase/.env`: **no**. Modal secrets: `nuwrrrld-secrets` and `free-model-refresh` exist, but whether either holds Alpaca keys is unverified. |
| D6 | gcp3 Modal (`deploy/modal/tracker_feed.py`) | same as D3 | | covered by D3's `data_client` | Modal: as D5 |

There's no shared Python package across these repos. Each gets a small `alpaca_bars.py` with the same function signature, `fetch_daily_bars(symbols, start, end, feed) -> dict[str, DataFrame]` with columns Open/High/Low/Close/Volume, so parity can be checked by eye. The Python port should follow the portal's `normalizeToAlpaca` (dot vs hyphen), and so should the chunking of 10 symbols per request in `modal_app.py`'s `_fetch_bars`.

### 7.5 Secret provisioning (copy-paste, when you implement)

Every command below reads from `nuwrrrld-portal/.env.local` and never prints a value. Alternatively, use the `secrets-sync` skill.

**Step 1: preflight.**

```bash
cd ~/code/nuwrrrld-portal && grep -cE '^ALPACA_API_(KEY|SECRET)=.+' .env.local && gh auth status 2>&1 | head -2 && gcloud config get-value account && mamba run -n base modal profile current
```

Expect `2`, a logged-in `gh`, a gcloud account, and a Modal profile.

**Step 2: GitHub Actions secrets for signals-app and gcp3.**

```bash
cd ~/code/nuwrrrld-portal && for repo in adamaslan/signals-app adamaslan/gcp3; do for k in ALPACA_API_KEY ALPACA_API_SECRET; do
  awk -F= -v k="$k" '$1==k{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local | tr -d '\n' | gh secret set "$k" --repo "$repo" && echo "set $k on $repo"
done; done
```

Verify:

```bash
for repo in adamaslan/signals-app adamaslan/gcp3; do echo "== $repo"; gh secret list --repo "$repo" | awk '{print $1}' | grep ALPACA; done
```

Expect 2 names per repo. The workflows still need `ALPACA_API_KEY: ${{ secrets.ALPACA_API_KEY }}` added to their `env:` blocks in D2 and D3.

**Step 3: GCP Secret Manager (`ttb-lang1`), then grant access to the runtime service account.**

```bash
cd ~/code/nuwrrrld-portal && for k in ALPACA_API_KEY ALPACA_API_SECRET; do
  awk -F= -v k="$k" '$1==k{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local | tr -d '\n' \
    | gcloud secrets create "$k" --project ttb-lang1 --replication-policy=automatic --data-file=- && echo "created $k"
  gcloud secrets add-iam-policy-binding "$k" --project ttb-lang1 \
    --member="serviceAccount:1007181159506-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor >/dev/null && echo "granted $k"
done
```

`gcp3-backend` and `technical-analysis-mcp` both run as that default compute service account. If a secret already exists, the create fails; use `gcloud secrets versions add "$k" --project ttb-lang1 --data-file=-` in its place.

**Step 4: mount the secrets on the two Cloud Run services** (only after D3 and D4 ship code that reads them, since this rolls a new revision).

```bash
for svc in gcp3-backend technical-analysis-mcp; do
  gcloud run services update "$svc" --project ttb-lang1 --region us-central1 \
    --update-secrets=ALPACA_API_KEY=ALPACA_API_KEY:latest,ALPACA_API_SECRET=ALPACA_API_SECRET:latest
done
```

Verify:

```bash
for svc in gcp3-backend technical-analysis-mcp; do echo "== $svc"; gcloud run services describe "$svc" --project ttb-lang1 --region us-central1 --format=yaml | grep -A1 -E 'name: ALPACA_API_(KEY|SECRET)$' | grep -E 'name:|secretKeyRef' ; done
```

Expect both names on each service.

**Step 5: Modal secret `alpaca`.** The secret goes into a temp file that is deleted right after.

```bash
cd ~/code/nuwrrrld-portal && T=$(mktemp) && grep -E '^ALPACA_API_(KEY|SECRET)=' .env.local > "$T" && mamba run -n base modal secret create alpaca --from-dotenv "$T"; rm -f "$T"
```

Verify:

```bash
mamba run -n base modal secret list | grep -w alpaca
```

Then add `modal.Secret.from_name("alpaca")` to each Modal function in D5 and D6.

**Step 6: homebase local.** 🖱 **Editor:** copy the two `ALPACA_API_*` lines into `~/code/homebase/.env`, or pipe them without opening either file:

```bash
grep -E '^ALPACA_API_(KEY|SECRET)=' ~/code/nuwrrrld-portal/.env.local >> ~/code/homebase/.env && grep -cE '^ALPACA_API_(KEY|SECRET)=' ~/code/homebase/.env
```

Expect `2`. If it's more than 2, the lines were already there; remove the duplicates.

### 7.6 How to verify each PR (per `exhaust-local-first`)

- **Force the fallback locally.** Set yfinance to fail (for example, point it at a bogus proxy for one run, or monkeypatch `_fetch_from_yfinance` to raise in a test). Confirm the output has the same shape with `source="alpaca"`, and that closes match the yfinance run within 0.5%.
- **Run one real cloud tick per host** and check that its summary logs the vendor used.
- **For D1,** rerun the section 4b harness without `PRICES_JSON`. `priced=` should now be about 176 per account instead of 0.

## 8. Risks and caveats

- **Nothing here has produced results yet**, so every claim about the personas is a design intent, not a measurement. **Still true as of 2026-09-27** — PR #188 is unmerged, so production is unchanged from §4's table.
- **Fibonacci evidence is thin** (section 5). The rollout doc's earlier +4.4pp figure is superseded.
- **Simulated fills are optimistic** and the four slots per day use `live_prices` as the reference, so a stale quote gives a stale fill.
- **`live_prices` still has no engine-side freshness check.** The new Alpaca push (§7, D1) drops trades older than 5 days at write time, but if the workflow's price-refresh step fails outright (`continue-on-error: true`), the paper engine will silently fill against whatever price is already sitting in `live_prices` — there is no staleness check on read. Not fixed in PR #188; a candidate for a follow-up PR.
- **Policy v2's thresholds are an unvalidated rescale**, not a backtested policy (§6 A8). They were carried over from §4b's test-harness mapping specifically to get *some* real-scale trades happening; expect to revisit them once real runs accumulate.
- **4 sibling workflows share A1's exact defect** (`afternoon-pipeline.yml`, `judge-followed-tickers.yml`, `select-followed-tickers.yml`, `track-followed-tickers.yml`) and are unfixed — each is presumably also failing before it reaches its own route, on the same 403.
- **Not investment advice.** The dashboard carries the `paper` disclaimer footer, and any Fibonacci addition should reuse it.

## 9. Remaining steps to first real trade (2026-09-27)

In order:

1. **Backfill `paper_accounts.policy_version` from `v1` to `v2` in production Neon**, *before or immediately at* merge — CodeRabbit flagged that a run stamps `paper_runs.policy_version` from the account row, so an unbackfilled account would label a v2-priced run `v1`. Read-only confirmation as of 2026-09-27: all 8 rows still `v1`, `paper_runs` still 0 rows (nothing has run under either version yet, so there is no historical data to reconcile — this is a pure metadata fix, not a migration of real results).
   ```sql
   UPDATE paper_accounts SET policy_version = 'v2' WHERE policy_version = 'v1';
   ```
2. **Merge PR #188.** All required checks pass (`auth`, `db-schema-parity`, `shared-drift-check`, `test`, `report`, 4× `e2e`) and CodeRabbit's review of the final commit has no open findings.
3. **A2: dispatch one real slot** once the merge deploys: `gh workflow run paper-portfolios.yml --repo adamaslan/nuwrrrld-portal -f slot=preopen -f skip_market_check=true`, then confirm the run is `success` via `gh run list`.
4. **A4: confirm rows landed** — `paper_runs`, `paper_orders` (if any candidate cleared a v2 threshold), and `/api/paper/accounts` returning 8 accounts.
5. **A5: click through `/dashboard/council/portfolios`** signed in, still never done.
6. Only after 1–5: **A9** (commit the dry-run harness) and the **4 sibling-workflow fixes** become the next-highest-value work, ahead of any Track B (Fibonacci) or Track C item.
