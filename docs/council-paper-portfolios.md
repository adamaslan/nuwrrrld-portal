# Council Paper Portfolios — Design Doc

**Status (2026-09-15):** Phases 1–6 and 8 merged (#124, #127, #128, #137 —
schema, seed script, deterministic engine + run route, cron workflow; #138 —
model arbitration + Firestore mirror/reconcile; #140 — metrics). Phase 7
(API/dashboard) lands with this doc's own PR. Manual steps (seed the DB for
real, provision + push `PAPER_CRON_SECRET`, provision
`FIRESTORE_SERVICE_ACCOUNT_JSON`) still block a real end-to-end run — see
`docs/manual-setup-todo.md`. See [[entity-paper-portfolios]] in
`docs/wiki-portal/` for current build status.
The **watchlists in §2.1 are final input, not a placeholder** — they are
validated against the registered universe and are what the seed script reads.

**Goal:** give every seat of the NuWrrrld AI Council its own **paper-money
account** — $10,000, 50 holdings, no real dollars — and let each seat trade its
own book four times a trading day according to *its own stated preferences*, its
**own pre-chosen watchlist** (§2.1 — the lists are in this document, not derived
at runtime), and the signals the portal already computes. Persist every
watchlist, transaction, position, and mark-to-market NAV to **all three stores**
(Neon → SQLite backup → Firestore mirror), so the council stops being a debate
with no scoreboard and becomes six tracked strategies with a P&L.

> **Not investment advice, and not a broker.** These are simulated accounts.
> No order ever leaves the database. Every surface that renders a paper
> portfolio carries the same disclaimer the council verdicts do
> (`lib/disclaimer.ts`).

---

## 1. Why

The council (`lib/openrouter.ts`) has six seats with genuinely different mandates
— T1 trades 1–60 days, T2 invests 2–5 years, RISK argues the other side, MACRO
frames rates/liquidity, QUANT reads only the numbers, CHAIR synthesizes. Today
those mandates produce *text*: a verdict row in `council_verdicts` and a
structured direction/confidence/invalidation. What they never produce is a
**position**, which means:

- no seat is ever wrong in a way that costs anything,
- there is no way to ask "is RISK's permanent bearishness actually additive?",
- `followed_ticker_scores` measures single picks, never portfolio construction
  (sizing, turnover, concentration, cash) — which is where most of the real
  difference between these personas lives.

A paper book per seat turns each persona into a falsifiable strategy, and the
leaderboard between them is the single most interesting artifact the council
could produce.

---

## 2. The six accounts (plus two baselines)

Eight accounts total. Six are seats; two are controls, because a leaderboard
without a baseline is a vanity metric.

| Account | Seat | Mandate | Starting cash | Target holdings |
|---|---|---|---|---|
| `t1` | T1 | Short-term tactical, 1–60 day holds | $10,000 | 50 |
| `t2` | T2 | Long-horizon, 3–12 month theses | $10,000 | 50 |
| `risk` | RISK | Survive-being-wrong construction; defensive tilt | $10,000 | 50 |
| `macro` | MACRO | Rates / dollar / liquidity / sector rotation | $10,000 | 50 |
| `quant` | QUANT | Numeric card score only, no narrative | $10,000 | 50 |
| `chair` | CHAIR | Consensus of the five, weighted by agreement | $10,000 | 50 |
| `equal` | — | **Control:** 50 names, equal weight, never rebalanced | $10,000 | 50 |
| `spy` | — | **Control:** 100% `IVV` (S&P 500), buy and hold — see §2.1 | $10,000 | 1 |

$10,000 / 50 names = **$200 per position at seed.** That is below one share of
plenty of the universe, so the simulation uses **fractional shares** (`numeric`
quantities, 6 dp). This is a deliberate simplification and it is stated on every
rendered surface — a real $10k account trading 50 names would be dominated by
round-lot friction that this model does not reproduce.

### 2.1 The watchlists — chosen here, not derived at runtime

Every account's candidate pool is **fixed in this document** and seeded from it.
Nothing is picked by a top-N query at seed time: a watchlist that changes
depending on when the seed script ran is not a control, and two accounts seeded
a week apart would not be comparable. The lists below are the watchlists.

Every symbol was checked against the registered `ticker_universe` catalog in
[`universe-by-industry.md`](universe-by-industry.md) (981 active rows, 2026-08-18)
— none is in the 26-symbol delisted set, and every one resolves to a real row.

Two structures per account:

- **Seed book (50 names)** — what the account actually holds at $200/name on day
  one. **Identical for all six seats and `equal`**, which settles §11 Q2: the
  first month measures *construction*, not selection.
- **Watchlist (75 names)** — the seed book plus 25 persona-specific names the
  account may rotate into. An account can only ever hold what is in its own
  watchlist; `paper_watchlists` is checked on every buy (§5 — a trigger, since
  a CHECK cannot reach another table).

#### The Core 50 (seed book — all seven multi-name accounts)

Sector-balanced with a hard **≤ 7 names per sector**, because RISK's 15% sector
cap at 2% equal weight allows exactly 7 — so the shared seed book is seedable by
the tightest policy in the set without clipping a single order.

| Sector | N | Tickers |
|---|---:|---|
| Technology | 7 | `AAPL` `MSFT` `NVDA` `AVGO` `ORCL` `CRM` `ACN` |
| Financial Services | 6 | `JPM` `BAC` `BRK.B` `V` `MA` `GS` |
| Healthcare | 6 | `JNJ` `LLY` `ABBV` `UNH` `TMO` `ABT` |
| Consumer Cyclical | 5 | `AMZN` `TSLA` `HD` `MCD` `NKE` |
| Industrials | 5 | `CAT` `HON` `UNP` `GE` `RTX` |
| Communication Services | 5 | `GOOGL` `META` `NFLX` `DIS` `TMUS` |
| Consumer Defensive | 5 | `PG` `KO` `COST` `WMT` `PEP` |
| Energy | 4 | `XOM` `CVX` `COP` `SLB` |
| Utilities | 3 | `NEE` `SO` `DUK` |
| Real Estate | 2 | `PLD` `AMT` |
| Basic Materials | 2 | `LIN` `SHW` |
| **Total** | **50** | |

#### Per-account extras (the other 25 of each 75-name watchlist)

##### `t1` — tactical extras (25)

`PLTR` `SMCI` `COIN` `HOOD` `MSTR` `AMD` `MU` `ARM` `CRWD` `NET`
`SHOP` `RBLX` `DASH` `ABNB` `UBER` `RIVN` `LCID` `MARA` `RIOT` `CLSK`
`AFRM` `UPST` `SOUN` `IONQ` `APP`

*Sector mix of the extras:* Technology 12, Financial Services 7, Consumer Cyclical 4, Communication Services 2.

High-beta, high-turnover names where a 1–60 day card actually moves. Deliberately the most fragile pool of the eight — if T1's mandate has no edge, this is where it shows up fastest.

##### `t2` — compounder extras (25)

`ADBE` `ASML` `TSM` `TXN` `ADI` `ISRG` `SYK` `REGN` `VRTX` `DHR`
`MCO` `SPGI` `ICE` `CME` `BLK` `AXP` `ADP` `ROP` `ITW` `ETN`
`WM` `RSG` `EQIX` `O` `MDLZ`

*Sector mix of the extras:* Technology 7, Financial Services 6, Healthcare 5, Industrials 4, Real Estate 2, Consumer Defensive 1.

Compounders and toll-booth businesses with multi-year theses, matching a 20-run minimum hold. No name here is in the pool for its momentum.

##### `risk` — defensive extras (25)

`MRK` `PFE` `BMY` `GIS` `KMB` `CL` `CLX` `MO` `PM` `KR`
`SYY` `HRL` `MKC` `CHD` `KDP` `ED` `XEL` `WEC` `AEP` `D`
`VZ` `T` `BRO` `AJG` `CB`

*Sector mix of the extras:* Consumer Defensive 12, Utilities 5, Healthcare 3, Financial Services 3, Communication Services 2.

Staples, regulated utilities, telecoms, and insurance brokers — low realized vol, and the only pool where a 15% cash floor plus a 3% position cap is not self-defeating.

##### `macro` — rotation extras (25)

`XLE` `XLI` `XLU` `XLB` `XLC` `VGT` `VIS` `VOX` `KRE` `SMH`
`QQQ` `IWM` `RSP` `DIA` `TLT` `GLD` `SLV` `URA` `EEM` `VGK`
`FXI` `KWEB` `FCX` `NUE` `CCJ`

*Sector mix of the extras:* ETF / index 22, Basic Materials 2, Energy 1.

The only pool that is mostly **ETFs**, because sector rotation is expressed in sectors, not single names. Rates (`TLT`), dollar/metals (`GLD`, `SLV`), ex-US (`VGK`, `EEM`, `FXI`, `KWEB`), and breadth (`RSP` vs `QQQ`) are all positionable here.

##### `quant` — numeric-breadth extras (25)

`NOW` `PANW` `FTNT` `KLAC` `LRCX` `AMAT` `QCOM` `INTU` `MDT` `CI`
`ELV` `CVS` `MMM` `DE` `LMT` `NOC` `FDX` `UPS` `TGT` `DG`
`EOG` `PSX` `MPC` `VST` `CEG`

*Sector mix of the extras:* Technology 8, Industrials 6, Healthcare 4, Energy 3, Consumer Defensive 2, Utilities 2.

Chosen for card coverage and data quality, not narrative: large, liquid, long price history, and a `data_quality ≥ 0.95` gate that almost nothing else clears. QUANT makes zero model calls, so its pool must stand on numerics alone.

##### `chair` — consensus extras (25)

`PLTR` `AMD` `COIN` `ADBE` `TSM` `ISRG` `SPGI` `BLK` `MRK` `CL`
`VZ` `CEG` `VST` `NOW` `QCOM` `INTU` `DE` `LMT` `UPS` `TGT`
`EOG` `MPC` `EQIX` `O` `ETN`

*Sector mix of the extras:* Technology 7, Industrials 4, Financial Services 3, Healthcare 2, Consumer Defensive 2, Utilities 2, Energy 2, Real Estate 2, Communication Services 1.

A weighted sample of the other five pools — every name here appears in at least one sibling watchlist, so by construction `chair`'s watchlist ⊆ the union of the other five, and CHAIR can never hold something no seat proposed. MACRO's index ETFs are the one deliberate omission: a consensus book expressed through `QQQ` would double-count the single names it already holds.

##### `equal` — control, no extras

Watchlist **is** the Core 50, frozen. Equal weight, never rebalanced, never a
buy or a sell after seed. Any divergence from 2%/name after day one is pure
price drift, which is the point.

##### `spy` — control, one name, and it is **not** SPY

`SPY` is **not a registered symbol** — it is absent from `ticker_universe`'s 173
ETFs. The registered S&P 500 tracker is **`IVV`**, so the buy-and-hold control
holds `IVV`. The account id stays `spy` because that is what the control *means*,
and renaming it later would break the `paper_nav` series. (`VOO` is also
unregistered; `RSP` — equal-weight S&P — is registered and belongs to `macro`.)

If SPY is wanted literally, it must be added to `ticker_universe` and hydrated
**before** the seed script runs, not after — an account cannot be reseeded
without destroying its NAV history.

#### Watchlist rules

1. **A buy against a ticker outside the account's watchlist is a bug**, not a
   policy decision — `paper_orders` rejects it at the DB level (§5).
2. **Watchlists are versioned, never edited in place.** A change writes new rows
   with a bumped `watchlist_version` and leaves the old rows `active = false`,
   so a NAV series can always be read against the pool that produced it.
3. **A delisted or dropped name is deactivated, not deleted** — blocked for new
   buys, forced to exit only on actual delisting (§11 Q5), and the row stays for
   the audit trail.
4. **Seeding writes a committed manifest**, exactly as the user watchlist seeder
   does (`docs/watchlist-seeds/README.md`): one JSON per seed run under
   `docs/watchlist-seeds/paper/`, holding account, timestamp, version, and the
   exact symbols — which makes the seed precisely reversible via `--undo=`.
5. **These are not user watchlists.** They never touch `watchlist_items`, are
   never attributed to a Clerk user id, and never enqueue into `pending_signals`.
   Eight synthetic accounts silently inflating a user-data table was considered
   and rejected.


---

## 3. Preference vectors — how a persona becomes a parameter set

The persona must be *mechanical*, not a prompt. If sizing were left to the model,
four runs a day across eight accounts would be unreproducible and expensive. So
each seat gets an explicit vector, checked into `lib/shared/paper-policy.ts`
(shared-module rules apply: `scripts/check-shared-drift.mjs` covers it), and the
model's job shrinks to breaking ties.

| Parameter | `t1` | `t2` | `risk` | `macro` | `quant` | `chair` |
|---|---|---|---|---|---|---|
| Card horizon read | `t1` | `t2` | `t2` | `t2` | `t1`+`t2` | both |
| Buy threshold (card score) | ≥ 70 | ≥ 60 | ≥ 80 | ≥ 65 | ≥ 75 | ≥ 70 |
| Sell threshold | < 45 | < 30 | < 55 | < 40 | < 50 | < 45 |
| Max position weight | 6% | 8% | 3% | 6% | 4% | 5% |
| Min position weight | 0.5% | 1% | 1% | 0.5% | 1% | 1% |
| Cash floor | 2% | 0% | 15% | 5% | 0% | 5% |
| Max turnover per run | 15% NAV | 3% NAV | 8% NAV | 6% NAV | 12% NAV | 8% NAV |
| Min holding period | 1 run | 20 runs | 4 runs | 8 runs | 1 run | 4 runs |
| Stop rule | −8% from entry | −25% | −5% trailing | −15% | −10% | −12% |
| Sector cap | 25% | 30% | 15% | 35% (rotation is the thesis) | 25% | 25% |
| Data-quality gate | ≥ 0.8 | ≥ 0.8 | ≥ 0.9 | ≥ 0.8 | ≥ 0.95 | ≥ 0.85 |
| Model calls per run | ≤ 6 | ≤ 4 | ≤ 6 | ≤ 6 | **0** | ≤ 8 |

Notes on the ones that aren't arbitrary:

- **QUANT gets zero model calls by construction.** Its mandate is "interpret only
  the numeric DATA" — so its book is a pure function of `ticker_cards`. It is the
  deterministic control *inside* the council, and any seat that can't beat QUANT
  is not earning its inference cost.
- **RISK's cash floor (15%) and 3% cap** are the whole persona. Its edge, if it
  has one, shows up in drawdown, not return.
- **T2's 20-run minimum hold** ≈ 5 trading days, which is the shortest holding
  period consistent with a "2 months–5 years" mandate given a 4×/day loop.
- **Turnover caps are per run, on NAV**, and they are the cost control as much as
  a persona trait: they bound how much the fill model can be wrong.

---

## 4. The run loop

### 4.1 Cadence — four slots a trading day

| Slot | ET | Purpose | UTC cron (EST / EDT) |
|---|---|---|---|
| `preopen` | 09:00 | Act on overnight card refresh + gaps; set the day's intent | `0 14 * * 1-5` / `0 13 * * 1-5` |
| `midday` | 12:30 | Stops, invalidations, half-day drift | `30 17 * * 1-5` / `30 16 * * 1-5` |
| `preclose` | 15:45 | The main rebalance, on near-final prices | `45 20 * * 1-5` / `45 19 * * 1-5` |
| `settle` | 16:30 | **No trading.** Mark-to-market close, NAV, metrics | `30 21 * * 1-5` / `30 20 * * 1-5` |

This follows the existing DST convention in `.github/workflows/afternoon-pipeline.yml`
— two cron lines, both fire, and the job no-ops when the ET wall clock doesn't
match its slot. It also deliberately runs **15 minutes after** the afternoon
pipeline so the `ticker_cards` refresh it depends on has already landed, exactly
as `track-followed-tickers.yml` does.

Market-closed days: the job runs, finds no fresh `bar_date`, and exits with a
`skipped: market_closed` run row. A skipped run is recorded, never silent.

### 4.2 What one run does, per account

```
for each account (8):
  1. LOAD      positions + cash from paper_positions/paper_accounts
  2. MARK      every position at the latest live_prices/ticker_cards price
  3. SCREEN    candidate set = ticker_cards for this horizon
               JOIN paper_watchlists (this account, active, current version),
               data_quality >= gate, bar_date fresh
               -- the watchlist is the outer bound; the card gate narrows it
  4. RANK      deterministic: score, adjusted by the seat's tilt function
               (MACRO: sector-rotation bonus; RISK: inverse vol; T1: momentum;
                T2: persistence of state_key across runs; QUANT: raw score)
  5. PROPOSE   target weights -> diff vs current -> candidate order list
  6. ARBITRATE only where the deterministic layer is genuinely tied or the
               position is near its stop: send <= N names to the seat's model
               with the seat's existing system prompt + the position context.
               Model may only VETO, DOWNSIZE, or CONFIRM — it cannot invent a
               ticker or a size. Unparseable response = treat as CONFIRM-none.
  7. CLIP      enforce turnover cap, position caps, sector cap, cash floor,
               min holding period, in that order
  8. FILL      simulate (see 4.3), write orders
  9. PERSIST   orders, positions, cash, NAV, run row -> Neon (one txn)
               -> SQLite (next snapshot) -> Firestore (mirror, non-fatal)
```

Step 6 is the only place a model runs, and it is capped: **≤ 36 model calls per
run across all eight accounts, ≤ 108/day** (the `settle` slot makes none). That
sits inside the free-model budget the council already lives on, and every call
goes through `runSeat()` with the existing fallback chain so a rotted
`SEAT_MODELS` entry degrades instead of taking the run down.

### 4.3 Fill model

Deliberately pessimistic, because an optimistic simulator is worthless:

- **Price:** the slot's reference close from `live_prices` / `ticker_cards.numerics`.
  Never an intraday high/low the account couldn't have transacted at.
- **Slippage:** 5 bps on mega/large caps, 15 bps otherwise, applied *against* the
  account both ways.
- **Commission:** $0 (matches the retail broker it's imitating).
- **Fractional:** yes, 6 dp.
- **Shorting:** none. RISK expresses bearishness by going to cash or into the
  defensive end of the universe, not by going short. (Keeps the accounting, the
  margin model, and the disclaimer story simple; revisit only if the data shows
  RISK is structurally hamstrung.)
- **Corporate actions:** splits handled by re-basing quantity when the price
  series jumps against an unchanged position; dividends **ignored** in v1 and
  called out as a known bias in favor of nothing in particular (it penalizes
  every account equally except `spy`).
- **Delisting/halt:** position marked `void` at last good price, cash returned,
  mirroring the `dropped_at` / `drop_reason` pattern in `followed_ticker_picks`.

### 4.4 Idempotency

Every run is keyed `(account, trade_date, slot)` with a unique constraint. A
retried GitHub Action, a double-fired cron, or a manual `workflow_dispatch` on a
slot that already ran is a **no-op that returns the existing run row** — never a
second set of fills. This is the single most important correctness property in
the whole design: a duplicated rebalance silently doubles turnover and quietly
destroys the comparability of the leaderboard.

---

## 5. Schema

New tables in `lib/db/schema.sql`. `scripts/gen-sqlite-schema.mjs` regenerates
the SQLite mirror from it and `scripts/backup-to-sqlite.mjs` picks the tables up
automatically (it reads `information_schema.columns` live), so the backup store
needs **no** separate work.

```sql
-- One row per simulated account. Eight rows, ever.
CREATE TABLE IF NOT EXISTS paper_accounts (
  account        text PRIMARY KEY,             -- t1|t2|risk|macro|quant|chair|equal|spy
  seat           text,                         -- CouncilSeat, null for controls
  label          text NOT NULL,
  policy_version text NOT NULL,                -- PAPER_POLICY_VERSION at seed
  starting_cash  numeric NOT NULL,
  cash           numeric NOT NULL,
  seeded_on      date    NOT NULL,
  active         boolean NOT NULL DEFAULT true,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- The chosen candidate pool, seeded from §2.1 and never derived at runtime.
-- 75 rows per seat, 50 for `equal`, 1 for `spy` -> 501 rows at v1
(6×75 + 50 + 1 — corrected during Phase 2 implementation; an earlier
draft's 526 didn't sum).
CREATE TABLE IF NOT EXISTS paper_watchlists (
  account          text    NOT NULL REFERENCES paper_accounts(account) ON DELETE CASCADE,
  ticker           text    NOT NULL REFERENCES ticker_universe(ticker),
  watchlist_version int    NOT NULL,            -- bumped, never edited in place
  in_seed_book     boolean NOT NULL DEFAULT false,  -- true for the Core 50
  active           boolean NOT NULL DEFAULT true,   -- false = no new buys
  deactivated_at   timestamptz,
  drop_reason      text,                        -- delisted|universe_drop|policy
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, ticker, watchlist_version)
);
CREATE INDEX IF NOT EXISTS paper_watchlists_active_idx
  ON paper_watchlists (account, ticker) WHERE active;

-- Current book. One row per (account, ticker). Deleted on full exit.
CREATE TABLE IF NOT EXISTS paper_positions (
  account       text    NOT NULL REFERENCES paper_accounts(account) ON DELETE CASCADE,
  ticker        text    NOT NULL,
  quantity      numeric NOT NULL CHECK (quantity > 0),
  avg_cost      numeric NOT NULL,
  opened_at     timestamptz NOT NULL,
  last_trade_at timestamptz NOT NULL,
  runs_held     int     NOT NULL DEFAULT 0,    -- enforces min holding period
  high_water    numeric NOT NULL,              -- enforces trailing stops
  thesis        text,                          -- the seat's own words, <=200 chars
  invalidation  text,                          -- carried from the council verdict
  PRIMARY KEY (account, ticker)
);

-- Append-only. The audit trail. Never updated, never deleted.
CREATE TABLE IF NOT EXISTS paper_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES paper_runs(id) ON DELETE CASCADE,
  account       text NOT NULL REFERENCES paper_accounts(account) ON DELETE CASCADE,
  ticker        text NOT NULL,
  side          text NOT NULL CHECK (side IN ('buy','sell')),
  quantity      numeric NOT NULL CHECK (quantity > 0),
  ref_price     numeric NOT NULL,
  fill_price    numeric NOT NULL,              -- ref +/- slippage
  slippage_bps  real    NOT NULL,
  notional      numeric NOT NULL,
  realized_pnl  numeric,                       -- sells only
  reason        text    NOT NULL,              -- score_entry|score_exit|stop|
                                               -- invalidation|rebalance|seat_veto|
                                               -- seat_downsize|cap_clip|void
  decided_by    text    NOT NULL CHECK (decided_by IN ('rule','model')),
  model         text,                          -- when decided_by='model'
  card_score    real,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_orders_account_idx ON paper_orders (account, created_at DESC);

-- A buy outside the account's own watchlist is a bug, not a decision (§2.1).
-- A CHECK cannot reach another table, so this is a trigger, not a constraint:
-- BEFORE INSERT, a 'buy' whose (account, ticker) has no active paper_watchlists
-- row raises. Sells are always permitted — a forced exit on a deactivated name
-- is exactly the case that must still get through.

-- Mark-to-market, one row per (account, date, slot). The performance series.
CREATE TABLE IF NOT EXISTS paper_nav (
  account       text NOT NULL REFERENCES paper_accounts(account) ON DELETE CASCADE,
  trade_date    date NOT NULL,
  slot          text NOT NULL CHECK (slot IN ('preopen','midday','preclose','settle')),
  cash          numeric NOT NULL,
  positions_mv  numeric NOT NULL,
  nav           numeric NOT NULL,
  day_return    real,
  total_return  real,
  positions_n   int  NOT NULL,
  turnover      numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (account, trade_date, slot)
);

-- One row per run attempt, per account. The idempotency key lives here.
CREATE TABLE IF NOT EXISTS paper_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account       text NOT NULL REFERENCES paper_accounts(account) ON DELETE CASCADE,
  trade_date    date NOT NULL,
  slot          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ok','skipped','degraded','failed')),
  skip_reason   text,
  candidates_n  int,
  orders_n      int,
  model_calls   int  NOT NULL DEFAULT 0,
  policy_version text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  UNIQUE (account, trade_date, slot)
);
```

`paper_orders.run_id` forward-references `paper_runs`, so `paper_runs` is
declared before `paper_orders` in the actual migration.

### 5.1 "All the DBs" — every store gets the transactions *and* the watchlists

The rule for this system: **all three stores carry the full record — accounts,
watchlists, transactions (`paper_orders`), positions, NAV, and runs.** An
earlier draft of this doc had Firestore take state-only and skip the order log;
that is reversed here. A book you can see but whose trades you cannot is
unauditable from the only surface a phone can reach, and "which store has the
trades" is exactly the question nobody wants to answer during an outage.

| Store | Role | Gets | How | Work required |
|---|---|---|---|---|
| **Neon Postgres** | Source of truth | All six tables, in full | Written in one transaction by the run route | The migration above |
| **SQLite snapshot** (`backups/*.sqlite`) | Offline / outage copy | All six tables, in full | `scripts/backup-to-sqlite.mjs` reads `information_schema.columns` live, so new tables are picked up with no code change | Regenerate `lib/db/schema.sqlite.sql` via `scripts/gen-sqlite-schema.mjs`; assert the `numeric → REAL` mapping doesn't cost precision on `quantity` (6 dp is safe in a double — assert it, don't assume it) |
| **Firestore** (gcp3) | Mobile / read mirror | All six, shaped for reads | `mirrorPaperAccount()` at end of run, **non-fatal** on failure like every other mirror here | The mirror writer + the collection layout below |

#### Firestore layout

```
paper/{account}                     -> account doc: label, seat, cash, nav,
                                       total_return, positions_n, policy_version,
                                       watchlist_version, last_run
paper/{account}/positions/{ticker}  -> quantity, avg_cost, mv, weight, runs_held,
                                       thesis, invalidation
paper/{account}/watchlist/{ticker}  -> in_seed_book, active, sector,
                                       watchlist_version, drop_reason
paper/{account}/orders/{order_id}   -> the transaction, verbatim: side, quantity,
                                       ref_price, fill_price, slippage_bps,
                                       notional, realized_pnl, reason,
                                       decided_by, model, card_score, created_at
paper/{account}/nav/{trade_date}    -> the day's four slots + close NAV
paper/{account}/runs/{date}_{slot}  -> status, skip_reason, orders_n, model_calls
```

- **Orders are mirrored append-only and never rewritten**, matching the Neon
  table's own guarantee (§8.6). `order_id` is the Neon `uuid`, so the mirror is
  idempotent: a replayed mirror writes the same doc ids and changes nothing.
- **Retention:** orders older than 400 days are pruned from Firestore only
  (Neon and the SQLite snapshots keep everything). Firestore is a read mirror,
  not an archive, and a phone has never needed a fill from fourteen months ago.
- **Watchlists mirror on seed and on version bump**, not every run — they change
  a few times a year, and re-writing 501 docs four times a day to say nothing
  would be the single largest write cost in the design.
- **A mirror failure is logged to `paper_runs.detail.mirror_error` and the run
  still succeeds.** The mirror is reconstructable from Neon at any time; the
  next run re-mirrors from current state.

#### Reconciliation

A drift check runs at `settle`, compares NAV, position count, cash, and
**order count** per account across Neon vs Firestore, and writes the delta into
`paper_runs.detail.reconcile`. Any non-zero order-count delta is the loud one —
it means a mirror write was lost, and the fix is a re-mirror, never a
recalculation. The SQLite side is checked at backup time by the existing
row-count assertions in `scripts/backup-to-sqlite.mjs`.

---

## 6. Routes and surfaces

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/pipeline/paper-portfolios` | POST | Cron secret (`lib/http-auth.ts`) + prod-DB guard | Run one slot for all accounts. `?slot=preclose&account=t1` for targeted reruns. |
| `/api/paper/accounts` | GET | Public (cached) | Leaderboard: NAV, total return, positions count, last run per account |
| `/api/paper/[account]` | GET | Public (cached) | One book: positions, weights, P&L, last 20 orders |
| `/api/paper/[account]/nav` | GET | Public (cached) | NAV series for charting |
| `/api/paper/[account]/orders` | GET | Public (cached) | The transaction log, paginated, newest first — the same rows mirrored to Firestore |
| `/api/paper/[account]/watchlist` | GET | Public (cached) | The account's chosen pool (§2.1), current version, with `in_seed_book` / `active` flags |
| `/dashboard/council/portfolios` | page | Clerk | The leaderboard + per-seat drilldown |

Public GETs are read-only aggregate data about simulated accounts — no user data
— so they follow the `public-demo` caching pattern rather than the entitlement
gate. The seeding script (`scripts/seed-paper-portfolios.mjs`) is **manual, once,
and refuses to run against a database that already has accounts** unless given
`--force-reseed`, which also archives the existing rows.

---

## 7. Scoring the council

`settle` computes and stores, per account, per day:

- total return, day return, since-inception CAGR
- annualized vol, Sharpe (rf = 0, matching `docs/moo-council-run/sim_moo.py`)
- max drawdown, current drawdown
- hit rate on closed positions, average win / average loss
- turnover (rolling 20-run), average holding period
- **active return vs `spy` and vs `equal`** — the only two numbers that say
  whether the seat added anything

The headline question this whole system exists to answer: **does any seat beat
`quant` (free, deterministic) by enough to justify the inference?** If not, that
is a genuinely valuable finding and should be written up as a decision page in
`docs/wiki-portal/`, not buried.

---

## 8. Guardrails

1. **Never real money.** No broker client, no API key, no order routing, ever.
   Disclaimer on every rendered surface.
2. **Prod-DB guard** (`lib/pipeline-db-guard.ts`) on the run route — a local run
   must not write the production book.
3. **Idempotent by `(account, trade_date, slot)`** — §4.4.
4. **Model calls capped and counted** in `paper_runs.model_calls`; a run that
   would exceed its cap proceeds deterministically rather than failing.
5. **The model can only veto/downsize/confirm.** It never picks a ticker or a
   size. This bounds the blast radius of a hallucinated response to "a trade
   that didn't happen".
6. **Append-only order log.** A correction is a new compensating row, never an
   UPDATE.
7. **A failed mirror never fails the run**, and a failed run never corrupts the
   book — positions/cash/NAV are written in one transaction or not at all.
8. **Seeding is a separate, guarded, manual script**, not something a scheduled
   job can trigger — and it writes a committed manifest, so it is reversible.
9. **An account can only trade its own watchlist.** Enforced in the engine and
   backstopped by a trigger on `paper_orders` (§5); sells are always allowed so
   a deactivated name can still be exited.
10. **Every store carries the transactions.** Neon, the SQLite snapshot, and
    Firestore each hold the full order log; the `settle` reconciliation compares
    order counts across them and records any delta (§5.1).

---

## 9. Known simplifications

Stated up front so nobody later mistakes them for bugs:

- No dividends, no interest on cash, no borrow costs, no taxes.
- No shorting, no options, no leverage.
- Fractional shares at any size; no round-lot or minimum-notional friction.
- Fills at a reference close with a flat slippage assumption — no order book, no
  partial fills, no liquidity constraint. At $200/position this is close enough
  to harmless; it would not be at $200k.
- Survivorship: the universe is `ticker_universe` as it exists *today*, which
  is forward-only from seed date (fine — the simulation is forward-only too).
- Four decision points a day is not "intraday trading"; T1's tactical mandate is
  approximated, not reproduced.

---

## 10. Build phases

| Phase | What | Ships |
|---|---|---|
| **1** | Schema migration + `lib/shared/paper-policy.ts` (the vectors) + `lib/paper-db.ts` | Tables exist, policy is testable in isolation |
| **2** | `scripts/seed-paper-portfolios.mjs` — 8 accounts, the §2.1 watchlists and Core 50 seed book read from a checked-in constant, plus a committed manifest per run | A seeded book and 501 watchlist rows, zero runs |
| **3** | Deterministic engine (steps 1–5, 7–9) + `/api/pipeline/paper-portfolios` | Full loop, **no model calls** — QUANT is already complete here |
| **4** | GitHub Actions workflow, 4 slots × 2 DST crons | Runs itself |
| **5** | Arbitration layer (step 6) — the ≤N model calls per seat | The seats become distinct from QUANT |
| **6** | Firestore mirror (accounts, watchlists, **orders**, positions, NAV, runs) + SQLite schema regen + the `settle` reconciliation check | "All the DBs", transactions included |
| **7** | `/api/paper/*` + `/dashboard/council/portfolios` | Visible |
| **8** | Metrics + leaderboard + first written finding | Answers §7's question |

Phase 3 is the meaningful milestone: a complete, deterministic, reproducible
eight-account simulation with no inference cost at all. Everything after that is
measured against it.

---

## 11. Open questions

1. **Is CHAIR's book a consensus of the five seats' *decisions*, or a fresh read
   of the same cards?** Consensus is more interesting (it's the council's actual
   output) and cheaper. Leaning consensus: weight each seat's proposed target by
   its trailing 60-run Sharpe, floor at zero.
2. ~~**Should the 50 names be the same starting set for every account?**~~
   **Resolved in §2.1:** same Core 50 at seed for all seven multi-name accounts,
   fixed in this document rather than pulled from the top of `ticker_cards` at
   seed time, so the seed is reproducible and two accounts seeded a week apart
   remain comparable. Each account then diverges within its own 75-name
   watchlist. The first month measures construction alone.
3. **Reset cadence.** Never? Annually? A permanently-compounding account
   eventually makes early luck unbeatable. Leaning: never reset, but publish
   trailing-12-month figures alongside since-inception.
4. **Does RISK need shorts** to be a fair test of its mandate, or is cash + a
   defensive tilt enough? Decide after one quarter of data, not now.
5. **Universe drift** — a *gain* in `ticker_universe` now changes nothing,
   because the candidate set is the account's own fixed watchlist, not the live
   universe. A *loss* still matters: the watchlist row is marked
   `active = false` with a `drop_reason`, which blocks new buys; a held position
   is forced out only on actual delisting. Open part: whether a new name ever
   enters a watchlist automatically (leaning **no** — a watchlist change is a
   version bump, and version bumps are deliberate).
