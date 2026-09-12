---
date: 2026-09-12
type: entity
tags: [council, paper-trading, simulation, schema, policy]
sources: [../council-paper-portfolios.md, ../../lib/db/schema.sql, ../../lib/shared/paper-policy.ts, ../../lib/paper-db.ts, PR#124]
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
| 2 | `scripts/seed-paper-portfolios.mjs` | Not started |
| 3 | Deterministic engine + `/api/pipeline/paper-portfolios` | Not started |
| 4 | GitHub Actions cron (4 slots × 2 DST crons) | Not started |
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

## Known failures

None yet observed — Phase 1 ships only a schema and a pure policy module,
neither of which runs against live data. The first real failure surface opens
with Phase 3 (the deterministic engine) and Phase 4 (the cron workflow); this
section will track what actually breaks once runs start happening.

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
