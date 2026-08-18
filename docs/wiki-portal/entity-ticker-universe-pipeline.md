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
- Not yet surfaced in any dashboard UI — this is coverage/data-plane
  infrastructure, one layer below what a user sees. The consumer is
  `topCards()`, which the top-N AI explain batch is meant to read from.

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
   0.8. `topCards()` returns empty for the entire ETF universe today. Two
   unreconciled fixes exist (extend gcp3's ETF scoring, or accept ETF as
   coverage-only forever) — undecided. Full detail:
   [[../pipeline-todo-blockers.md|pipeline-todo-blockers.md]] blocker 1.
3. **Modal secrets are replaced wholesale, not merged** — `modal secret
   create <name> --force` overwrites every key in the named secret, so
   syncing `PORTAL_PUSH_SECRET` there automatically (before
   `ALPACA_API_KEY`/`ALPACA_API_SECRET` exist) risks silently wiping those
   once they're added later. `gen-portal-push-secret.sh` deliberately does
   **not** touch Modal secrets — it prints the exact `modal secret create`
   command with all keys together instead, and leaves running it to a human.
4. **No Alpaca account confirmed to exist** — the entire non-ETF (~4,300
   ticker) lane cannot run at all without it. See
   [[../pipeline-todo-blockers.md|pipeline-todo-blockers.md]] blocker 4.
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
