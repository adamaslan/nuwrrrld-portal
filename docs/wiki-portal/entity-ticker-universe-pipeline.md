---
date: 2026-08-18
type: entity
tags: [pipeline, universe, hydration, modal, alpaca, cards, coverage, seeding]
sources: [../../app/api/pipeline/hydrate-universe/route.ts, ../../lib/ticker-cards-db.ts, ../../lib/shared/card-policy.ts, ../../deploy/universe-hydration/modal_app.py, ../../scripts/seed-universe.mjs, ../../scripts/seed-etf-cards.mjs, ../../scripts/seed-yahoo-portfolio.mjs, ../../scripts/gen-portal-push-secret.sh, ../pipeline-todo-blockers.md, ../max-coverage-simplest-path.md]
---

# Entity — Ticker Universe & Coverage Pipeline

## What it is

The pipeline that carries a ticker from "known to exist" to "scored, ranked
card, at zero AI cost by default." Three layers, added/committed 2026-08-18
in PR #66:

- **`ticker_universe`** (Neon table) — the list of tickers the portal tracks
  at all, tagged `etf` or `stock`. Populated by `PUT /api/pipeline/hydrate-universe`,
  called by three seed scripts:
  - `scripts/seed-universe.mjs` — scrapes S&P 500 + Nasdaq-100 constituents
    from Wikipedia (518 tickers, dry-run verified; never run against real
    production — [[../pipeline-todo-blockers.md|blocker 2]]).
  - `scripts/seed-yahoo-portfolio.mjs` — parses a directory of Yahoo Finance
    portfolio CSV exports (`Symbol` column), filters out non-US-exchange
    tickers (Yahoo suffix notation like `.HK`/`.L`) and non-equity rows
    (futures `BZ=F`, index `^VOLQ`) since Alpaca only covers US equities.
    Against this session's `~/Downloads/portfolio-yahoo/` export set: 680
    distinct US tickers from 26 CSV files (2 skipped — one was a
    "temporarily unavailable" Yahoo error page served in place of a real
    download, not a parsing bug). Dry-run verified; real run blocked on the
    same deploy gap as everything else in this pipeline (see Known failures).
  - `scripts/seed-etf-cards.mjs` — the 54 gcp3-tracked ETFs, carded directly
    (see below), confirmed working end-to-end against live gcp3 data.
- **`ticker_cards`** (Neon table) — one scored/ranked card per ticker per
  horizon, built by `lib/shared/card-policy.ts`'s `buildCard()`, written via
  `upsertCards()`, read back via `topCards()`/`coverageForDate()` in
  `lib/ticker-cards-db.ts`. A card can be built with **zero model calls** —
  scoring is deterministic from signal inputs (RSI, MACD cross, ADX,
  volatility percentile, confluence score), which is the entire cost story:
  coverage doesn't spend OpenRouter quota, only the *explain* step
  ([[decision-precompute-ai-at-quota-reset]]) does.
- **`deploy/universe-hydration/modal_app.py`** — the Modal cron meant to walk
  `ticker_universe`, pull bars from Alpaca, and push cards for the ~4,300
  non-ETF tickers a full S&P 500 + Nasdaq-100 universe implies. Not yet
  deployed; not yet credentialed (see Known failures).

`scripts/gen-portal-push-secret.sh` generates and syncs the `PORTAL_PUSH_SECRET`
bearer every pipeline route requires (`requirePushSecret()` in
`hydrate-universe/route.ts`), without the value ever being printed to an
agent's terminal or read back into an LLM context — it writes directly to
`.env.local` and shells out to `vercel env add` / prints `modal secret create`
instructions rather than running the Modal step automatically (see Known
failures #3 for why).

## Where used

- `app/api/pipeline/hydrate-universe/route.ts` (GET returns coverage stats,
  PUT registers universe membership, POST accepts hydrated card rows) — the
  single write path into both `ticker_universe` and `ticker_cards`.
- `app/api/pipeline/precompute-ai/route.ts` — a sibling route sharing the same
  `PORTAL_PUSH_SECRET` gate and quota-reset scheduling philosophy; see
  [[decision-precompute-ai-at-quota-reset]].
- `app/api/signals/top/route.ts` (PR #71) — the read side, and until it
  landed `topCards()` had **no caller at all**: the ranking existed in the
  database and nothing in the product could see it. Dual-gated on a Clerk
  session or `PORTAL_PUSH_SECRET`, matching `/api/signals/digest`, because the
  precompute-AI batch will read this ranking to pick its subjects and has no
  Clerk session. Query params `?universe=` / `?horizon=` / `?limit=`.
- `lib/shared/universe-policy.ts` (PR #71) — the route's decisions as pure
  functions (scope, horizon, limit, strong-card threshold, card age, page
  summary), split out on the same rationale as
  [[entity-signal-data-plane]]'s `signal-policy.ts`: it unit-tests without
  `DATABASE_URL`, which `@/lib/db` throws on at import time.
- `app/api/pipeline/precompute-ai/route.ts` (PR #72) — the ranking's second
  consumer, and the one that closes the loop the universe was built for.
  `{"source":"ranking"}` pulls subjects from `topCards()` instead of the
  watchlist: supply-side (what the data says is interesting) rather than
  demand-side (what someone already holds). `batchThesisSubjects()` packs ten
  tickers per prompt, so a 100-ticker sweep costs 10 requests against the
  50/day ceiling rather than 100 — see [[entity-openrouter-client]] failure #3.
- Still not surfaced in any dashboard UI — this remains coverage/data-plane
  infrastructure one layer below what a user sees. `/api/signals/top` is an
  API consumer, not a screen.

## Known failures

1. **All three pieces of `app/api/pipeline/`, `deploy/universe-hydration/`,
   and the seed scripts were untracked in git until 2026-08-18 (PR #66).**
   Built and tested against a disposable Neon branch, but never committed —
   so `financial.nuwrrrld.com/api/pipeline/hydrate-universe` **404s in
   production** (a genuine Next.js not-found, confirmed via `curl`, not a
   domain/auth issue) until this PR merges and a new deployment ships. This
   is why the Yahoo-portfolio import and the real `seed-universe.mjs` run
   are still blocked, despite `PORTAL_PUSH_SECRET` now being resolved.
2. **Every ETF card fails the explain-quality gate, 0/54** — gcp3's ETF
   payload fills only 1 of 5 taxonomy inputs (`confluenceScore`), so every
   card lands at `dataQuality: 0.20` against an `isExplainable()` floor of
   0.8. Two unreconciled fixes exist (extend gcp3's ETF scoring, or accept
   ETF as coverage-only forever) — undecided. Full detail:
   [[../pipeline-todo-blockers.md|pipeline-todo-blockers.md]] blocker 1.
   *Partly overtaken by PR #70*: ETF cards hydrated locally via Alpaca
   (`hydrate-local.mjs`, all five inputs) reach `dataQuality: 1.0`, so the
   0.20 figure describes the **gcp3-sourced** path specifically, not ETFs
   inherently. The gcp3 payload gap is still real and still undecided.
3. **Modal secrets are replaced wholesale, not merged** — `modal secret
   create <name> --force` overwrites every key in the named secret, so
   syncing `PORTAL_PUSH_SECRET` there automatically (before
   `ALPACA_API_KEY`/`ALPACA_API_SECRET` exist) risks silently wiping those
   once they're added later. `gen-portal-push-secret.sh` deliberately does
   **not** touch Modal secrets — it prints the exact `modal secret create`
   command with all keys together instead, and leaves running it to a human.
4. ~~**No Alpaca account confirmed to exist**~~ — **resolved 2026-08-19.** An
   account exists and works: `ALPACA_API_KEY`/`ALPACA_API_SECRET` in
   `.env.local` authenticated hundreds of `/v2/stocks/bars` calls across PRs
   #70–#73, hydrating 932 tickers and probing two years of history. The
   original blocker was real when written; it is not what stands in the way
   now.

   **The remaining limitation is where those credentials are, not whether they
   exist.** They live only in local `.env.local`. Neither Vercel nor the Modal
   secret carries them, so the unattended lane —
   `deploy/universe-hydration/modal_app.py` — still cannot run even once it is
   deployed (failure 6). Today the universe is hydrated exclusively by a human
   running `scripts/hydrate-local.mjs` on a laptop, which is a real coverage
   dependency rather than a scheduled pipeline. See
   [[../pipeline-todo-blockers.md|pipeline-todo-blockers.md]] blocker 4 and
   failure 3 above for why the Modal secret in particular needs care.
6. **`deploy/universe-hydration/modal_app.py` has never been deployed** —
   `modal deploy` has not been run for this app or either of the other two in
   `deploy/`. The file existing is not the lane running; today the stock
   universe is hydrated by nothing at all. Part of a broader pattern where
   Modal was deferred across six separate decisions —
   [[incident-2026-08-18-modal-under-recommended]].
5. **`vercel env add` on an existing var, run non-interactively, silently
   declines rather than overwriting** — discovered while syncing
   `PORTAL_PUSH_SECRET` to Vercel `production`: the CLI logged what looked
   like a failure, but the pre-existing 34-day-old production value was left
   untouched (confirmed via `vercel env ls` timestamps). Worth knowing before
   trusting this script's stdout as proof of what actually happened —
   `vercel env pull` is the reliable way to check what's really live.

7. **`topCards()` returned zero rows for ~50 minutes of wall-clock data, and
   nothing detected it** (PR #70). Every stored card carried
   `missing_fields: ["macdCross"]`, which the ranking gate excludes outright,
   so the ranking was empty rather than degraded. The cards were written
   minutes *before* the commit that fixed `macdCross`'s omit-vs-null
   handling; the code was correct and the data was stale. Re-hydrating took
   the t1 ranking from **0 → 733** eligible cards. The signature to watch
   for: `dataQuality: 0.8` plus `missing_fields: ["macdCross"]` across the
   *whole* universe means MACD is being omitted upstream — a genuinely quiet
   tape produces `null` (computed, no cross) at `dataQuality: 1.0`. Three
   states, one of which is not a gap — see [[concept-three-state-signal]].
8. **`hydrate-local.mjs` hardcoded `universe: "stock"` on every POST**, the
   same defect as `seed-yahoo-portfolio.mjs`, so 306 ETF cards were stored
   labeled as stocks — drift between `ticker_cards.universe` and
   `ticker_universe.universe`. Fixed in PR #70 by making the script
   lane-aware (`stock`, then `etf`, each labeled correctly) with a
   `--universe=` flag. Worth noting the shape: the label is a **batch-level**
   POST field, so a chunk mixing both universes must mislabel one of them.
9. **One bad symbol destroyed its entire chunk.** Alpaca rejects the whole
   multi-symbol `/v2/stocks/bars` request with `400 invalid symbol: X` if any
   single symbol is not a US equity, so four crypto pairs (`BTC-USD`,
   `ETH-USD`, `SOL-USD`, `DOGE-USD`) cost **40 rows** in a 178-symbol ETF
   run. `fetchBars` now drops the named symbol and retries the remainder;
   auth/rate-limit/network errors still throw, since those are not
   per-symbol problems. Post-failures 40 → 0.
10. **Inverse and leveraged ETFs were ranked as BUY recommendations.** Once
   ETF cards were complete, the top-100 became **71% ETFs** — `SMST` (2x
   inverse MicroStrategy) at BUY beside JNJ, 22 inverse/short products in
   all. Not a scoring bug: the score reads a price series directionally, and
   an inverse fund's series is the *negation* of its named exposure (SQQQ
   rising is the Nasdaq falling). `topCards()` now takes a `universe`
   argument defaulting to `'stock'`; `'etf'` ranks funds among themselves and
   `'all'` restores the mixed behavior deliberately.
11. **`barDate` was silently off by one day west of UTC** (found and fixed in
   PR #71). `rowToStored()` built it as `String(row.bar_date).slice(0, 10)`,
   but the Postgres driver returns a JS `Date` for `date` columns, and
   `String(date)` renders in **local** time — so a bar dated `2026-08-19` came
   back as the locale string `"Tue Aug 18"`. Two defects in one line: the
   wrong calendar day for any non-UTC reader, and a string no date parser
   accepts (it reached the new API as `ageDays: null`, which is how it was
   noticed). Now read via `toISOString()` in UTC, with already-`YYYY-MM-DD`
   strings passed through untouched so they are not re-parsed back through the
   same shift. The bug was invisible for as long as nothing read `barDate`
   back out — a reminder that an unread field is an untested one.

12. **61 active tickers carried no card, and two of the reasons were the
   opposite of what they looked like** (PR #73). Coverage sat at 920/981.
   Probing all 61 against a **two-year** window — rather than the 120 days
   `hydrate-local.mjs` uses — split them three ways:
   - **12 were recoverable, not dead.** `BNY`, `BR`, `BRO`, `BSX` and others
     had a full 83 bars available. They were casualties of the whole-chunk-400
     bug (failure 9) and had simply never been retried after it was fixed.
     Hydrating them took coverage to 932.
   - **Recency, not bar count, separates dead from new.** `SLNO`, `STKL`,
     `ACLX`, `CTRA` each hold 400+ bars that *stop* in April/May 2026 —
     acquired or delisted mid-year. `SKHY` holds 28 bars and traded
     yesterday: newly listed and perfectly alive. A bar-count threshold
     would have pruned the live symbol and kept the dead ones.
   - **23 have zero bars in two years** — OTC ADRs and mutual funds Alpaca
     has never covered (`TCEHY`, `SFTBY`, `VTSAX`), plus 5 Alpaca rejects
     outright (the four crypto pairs and `SCHW-PD`).

   `scripts/prune-universe.mjs` encodes that classification and deactivated
   48, keeping `SKHY`. Active coverage is now **932/933 (100%)**, the single
   gap being `SKHY` by design. `active = false` is reversible and preserves
   the row, its cards and its history; the script prints the re-enable
   statement rather than DELETEing anything.

## Open questions

- ❓ Should `seed-yahoo-portfolio.mjs`'s non-US-suffix filter list
  (`.HK`/`.L`/`.TO`/…) live somewhere shared, if another import source needs
  the same US-only constraint later? Currently local to that one script.
- ❓ Once PR #66 deploys, does `seed-universe.mjs` register 518 tickers
  cleanly against production on the first real (non-dry-run) attempt, or
  does `upsertUniverse`'s `ON CONFLICT` behavior need checking against
  whatever the Yahoo-portfolio import registers first?
- ❓ Blocker 1 (ETF explain-quality gap) is a design decision, not a bug —
  see [[../pipeline-todo-blockers.md|pipeline-todo-blockers.md]] for the two
  options; unresolved as of this page's writing.

## Local runner (`scripts/hydrate-local.mjs`)

A JS runner (PR #67) that drives the same hydration against a local dev server,
so a chunk can be watched landing and the resulting cards inspected before the
unattended job runs. It posts to the same `/api/pipeline/hydrate-universe`
route with the same row shape as the Modal job.

Its indicator math is a **port** of `deploy/universe-hydration/modal_app.py`,
which is the authoritative implementation — the two write into the same table,
so a numeric divergence would mean two symbols were scored on different scales
depending on which runner happened to hydrate them. The first draft was not a
port at all: `macdCross` never called `ema` and returned a five-bar price
direction, `adx` ignored `high`/`low` so trend strength tracked the nominal
share price, `volatilityPercentile` ranked aggregate volatility against
individual daily returns, and `confluence` mixed in `Math.random()`, so
identical bars scored differently run to run.

Two seeding conventions had to be matched exactly, and getting them wrong
shifted RSI by ~0.5 and ADX by ~0.9 while still looking plausible:

- pandas' `ewm()` **skips** a leading `NaN`, seeding from the first real value —
  so RSI's gain/loss series, built from `close.diff()`, must skip index 0.
- `np.where` and `Series.combine(max)` do **not** propagate `NaN` the same way,
  so ADX's `+DM`/`-DM` seed at `0.0` and its first `TR` is the plain high-low
  range.

`__tests__/hydrate-indicators.test.ts` pins all four indicators against values
captured from the Python functions across eight series, at a 1e-9 tolerance —
tight enough to still catch exactly these seeding bugs.

The first six of those series were the whole suite as originally merged, and
they shared a blind spot worth remembering: every one of them happened to
produce a *no-cross* `null` from `macdCross`, so the `"bullish"`/`"bearish"`
branches — the only MACD values the pipeline ever acts on — were never compared
against Python at all. A suite can cover five distinct market regimes and still
miss the branch that matters, because regime variety is not the same as branch
variety. The two `macd_*` fixtures added in the post-merge review cross in each
direction, and a guard test now asserts both remain represented.

A row is only `status: "ok"` once **every** indicator has enough history
(`MIN_BARS = 40`, the largest lookback any of them needs). The earlier 30-bar
threshold let partially-computed rows persist with missing RSI/ADX/volatility
written as `0`/`0`/`50`, indistinguishable from real measurements. 40 is a
measured boundary, not a guess — at 39 bars `volatilityPercentile` still
returns `null` — and the test suite pins both sides of it.

## See also

- [[decision-precompute-ai-at-quota-reset]] — the sibling route this shares
  `PORTAL_PUSH_SECRET` and quota-reset philosophy with
- [[entity-signal-data-plane]] — the canonical signals doc; this pipeline
  consumes the same gcp3 signal shape for ETF cards
- `../pipeline-todo-blockers.md` — the living status doc for every blocker
  named on this page, in priority order
- `../max-coverage-simplest-path.md` — the design doc and the "no 50/day
  limit" correction this pipeline's cost story depends on
- [[incident-2026-08-18-modal-under-recommended]] — why this pipeline's Modal
  lane is written but unrun, and the deferral pattern behind it
- `../modal-vs-gcp-signal-coverage.md` — GCP-vs-Modal analysis and the
  Lane A/B/C plan this pipeline implements Lane B/C of
