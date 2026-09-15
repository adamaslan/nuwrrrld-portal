---
date: 2026-09-13
type: entity
tags: [council, paper-trading, simulation, schema, policy, seed, engine]
sources: [../council-paper-portfolios.md, ../../lib/db/schema.sql, ../../lib/shared/paper-policy.ts, ../../lib/paper-db.ts, ../../scripts/seed-paper-portfolios.mjs, ../../lib/paper-engine.ts, ../../lib/shared/paper-engine-core.ts, ../../lib/shared/paper-sectors.ts, PR#124, PR#127]
---

# Entity: Council Paper Portfolios

Eight simulated $10,000 paper-trading accounts — one per council seat (T1, T2,
RISK, MACRO, QUANT, CHAIR) plus two baselines (`equal`, `spy`) — that turn the
[[entity-ai-council]]'s six personas from text-only verdicts into falsifiable
strategies with a real, comparable P&L. Full design in
[`docs/council-paper-portfolios.md`](../council-paper-portfolios.md); this page
tracks what's actually built against that 8-phase plan.

## What it is

- **Eight accounts**, `paper_accounts.account`: `t1|t2|risk|macro|quant|chair|equal|spy`
  (lowercase — distinct from [[entity-openrouter-client]]'s uppercase
  `CouncilSeat`; `lib/shared/paper-policy.ts`'s `ACCOUNT_SEAT` maps between
  them). `spy` actually holds `IVV` (`SPY` itself isn't a registered
  `ticker_universe` symbol).
- **Fixed watchlists** (`paper_watchlists`): a shared Core 50 seed book plus
  25 persona-specific extras per seat, chosen once in the design doc's §2.1 —
  never derived at runtime, so two accounts seeded a week apart stay
  comparable.
- **Preference vectors** (`lib/shared/paper-policy.ts`'s `PAPER_POLICY`): buy/
  sell thresholds, position/sector caps, cash floor, turnover cap, stop rule,
  min holding period, model-call ceiling — one row per trading account,
  mechanical rather than left to the model. `quant`'s `maxModelCallsPerRun` is
  `0` by construction — it is the deterministic control inside the council.
- **The watchlist-membership trigger** (`paper_orders_watchlist_guard_trg`) —
  the first `BEFORE INSERT` trigger this schema has ever had. A buy against a
  ticker outside an account's active watchlist is a bug, not a policy
  decision, and is rejected at the DB level (a `CHECK` constraint can't reach
  another table). Sells are always permitted, so a forced exit on a
  deactivated name still goes through.
- **Idempotent runs** (`paper_runs`, unique on `(account, trade_date, slot)`):
  the correctness property the whole system depends on — a retried cron or a
  manual rerun of an already-run slot must return the existing row, never
  produce a second set of fills.

## Build status (against the design doc's 8 phases)

| Phase | What | Status |
|---|---|---|
| 1 | Schema (6 tables + trigger) + `lib/shared/paper-policy.ts` + `lib/paper-db.ts` | **Shipped** — PR #124 |
| 2 | `scripts/seed-paper-portfolios.mjs` | **Shipped** — PR #127 |
| 3 | Deterministic engine + `/api/pipeline/paper-portfolios` | **Shipped** — this PR (`feat/paper-portfolios-phase-3-engine`, cut from `origin/main`, independent of #127) |
| 4 | GitHub Actions cron (4 slots × 2 DST crons) | **Shipped** — this PR (`feat/paper-portfolios-phase-4-cron`, cut from `origin/main`) |
| 5 | Arbitration layer (model veto/downsize/confirm) | Not started |
| 6 | Firestore mirror + reconciliation | Not started |
| 7 | `/api/paper/*` + `/dashboard/council/portfolios` | Not started |
| 8 | Metrics + first written finding | Not started |

## Where used

- `lib/db/schema.sql` — `paper_accounts`, `paper_runs`, `paper_watchlists`,
  `paper_positions`, `paper_orders`, `paper_nav`, and
  `paper_orders_watchlist_guard_trg`.
- `scripts/gen-sqlite-schema.mjs` — a new `DROP_STATEMENT_PATTERNS` entry
  strips the trigger/function for [[entity-sqlite-backup]]'s mirror, since
  SQLite has no PL/pgSQL and the read-only backup path never needs the guard.
- `__tests__/db-parity/lib-db-modules.test.ts` — `paper-db` block, covered by
  [[entity-db-parity-suite]] (no `unnest()`/`ANY()` idioms, so it's fully
  covered rather than joining that suite's excluded-modules list).
- `scripts/seed-paper-portfolios.mjs` — seeds the 8 accounts and 501 watchlist
  rows from §2.1's Core 50 + per-account extras, transcribed verbatim; writes
  a manifest per run under `docs/watchlist-seeds/paper/` (same reversibility
  contract as `scripts/seed-watchlist-universe.mjs`). Guarded behind `main()`
  (same idiom as `scripts/seed-signals-universe.mjs`) so its constants are
  unit-testable without the seeder running as a side effect.
- `lib/paper-engine.ts` (Phase 3) — the run-loop orchestrator: LOAD/MARK/
  SCREEN/PERSIST, one `sql.transaction([...])` per account per run.
- `lib/shared/paper-engine-core.ts` (Phase 3) — pure RANK/PROPOSE/CLIP/FILL,
  no I/O, unit-tested directly (`__tests__/paper-engine-core.test.ts`).
- `lib/shared/paper-sectors.ts` (Phase 3) — ticker→sector map the CLIP step's
  sector cap reads, plus the mega/large-cap set the FILL step's slippage tier
  reads. Best-effort, not verbatim — see its module doc.
- `app/api/pipeline/paper-portfolios/route.ts` (Phase 3) — the cron entry
  point, bearer-authed on its own `PAPER_CRON_SECRET`.
- `.github/workflows/paper-portfolios.yml` (Phase 4) — 8 cron lines (4 slots ×
  EST/EDT), gate resolves which slot fired from the NY wall-clock time itself
  rather than a fixed hour (unlike `track-followed-tickers.yml`'s single-slot
  gate), `workflow_dispatch` inputs for a forced `slot`/`account`, a non-fatal
  "zero orders across all 8 accounts" sanity check on non-`settle` slots.

## Known failures

None yet observed against live data — the deterministic engine (Phase 3) has
only run against unit tests of its pure core, never a real Neon branch with
seeded accounts (Phase 2's seed script hasn't actually been run for real; see
`docs/manual-setup-todo.md`'s 2026-09-13 entry). The first real failure
surface opens once a seeded environment + `PAPER_CRON_SECRET` exist and Phase
4's cron starts firing.

## Known gaps found during implementation (not in the design doc)

- The design doc claimed `scripts/gen-sqlite-schema.mjs` needs **no** changes
  for the new tables. True for the six plain tables, false for the trigger —
  its `DROP_STATEMENT_PATTERNS` only knew how to strip one specific existing
  function. Fixed in PR #124.
- `uuid PRIMARY KEY DEFAULT gen_random_uuid()` columns (`paper_orders.id`,
  `paper_runs.id`) lose their DB-side default on the SQLite mirror — the app
  must supply the id itself, same as [[entity-db-parity-suite]] already
  documents for `pipeline_run_log`. `lib/paper-db.ts`'s `insertOrder`/
  `insertRun` do this via `crypto.randomUUID()`.
- The design doc's account-id type was ambiguous between the schema's
  lowercase `account` column and `CouncilSeat`'s uppercase values; caught by
  `tsc`, not by review — `PaperAccount` is now explicitly the lowercase
  schema values, with `ACCOUNT_SEAT` as the explicit mapping.
- The design doc's own watchlist-row arithmetic didn't sum: it claimed 526
  total rows (§5, §6), but 6 seats × 75 names + `equal`'s 50 + `spy`'s 1 =
  **501**. Caught by the seed script's dry-run output, not by review — fixed
  in the doc and in Phase 1's `schema.sql` comment, PR #127.
- **Phase 3:** `ticker_cards.numerics` — which §4.3's fill model implies would
  carry a reference close price — is always written as an empty `{}` by
  `upsertCards` (`lib/ticker-cards-db.ts`). The engine uses `live_prices` as
  the reference price instead (already the freshest live quote in this repo);
  a ticker with no `live_prices` row simply cannot be traded that slot rather
  than falling back to a stale or fabricated price.
- **Phase 3:** the design doc's per-seat tilt functions (momentum, inverse-vol,
  sector-rotation bonus, state persistence) need historical data
  `ticker_cards` doesn't store (one row per ticker+horizon, not a series).
  Deferred rather than invented — RANK is raw `score DESC` for every account
  in this phase; see `docs/paper-portfolios-remaining-todo.md`'s Phase 3
  section for the full list of stated simplifications.

## Open questions

Carried from the design doc's §11, unresolved: whether CHAIR's book reads a
fresh card pass or a weighted consensus of the other five seats' proposed
targets; reset cadence (leaning never); whether RISK needs shorts to be a fair
test of its mandate.

## See also

- [`docs/council-paper-portfolios.md`](../council-paper-portfolios.md) — the full design doc
- [[entity-ai-council]] — the six-seat deliberation system this simulates
- [[entity-openrouter-client]] — `runSeat()`, reused as-is for Phase 5's arbitration calls
- [[entity-db-parity-suite]] — the SQLite/Neon contract-test harness this feature's `lib/paper-db.ts` is covered by
- [[entity-sqlite-backup]] — the mirror `gen-sqlite-schema.mjs`'s new trigger-drop pattern keeps valid
