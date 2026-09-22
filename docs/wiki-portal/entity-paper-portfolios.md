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
| 3 | Deterministic engine + `/api/pipeline/paper-portfolios` | **Shipped** — PR #128 |
| 4 | GitHub Actions cron (4 slots × 2 DST crons) | **Shipped** — PR #137, but its slot gate never matched a real cron tick (exact-minute equality vs. GHA's typical 30-90min late start) — see [[incident-2026-09-22-paper-portfolios-slot-gate-never-matched]]. Gate fixed to a window match in PR #147; `PAPER_CRON_SECRET` provisioning and the real account seed remain open, so scheduled runs still don't complete end to end as of 2026-09-22. |
| 5 | Arbitration layer (model veto/downsize/confirm) | **Shipped** — PR #138 |
| 6 | Firestore mirror + reconciliation | **Shipped** — PR #138 |
| 7 | `/api/paper/*` + `/dashboard/council/portfolios` | **Shipped** — this PR (`feat/paper-portfolios-phase-7-api-dashboard`, cut independently from `origin/main`) |
| 8 | Metrics | **Shipped** — PR #140. The written-finding half is unstarted by design — it needs weeks of real run data. |

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
- `app/api/pipeline/paper-portfolios/route.ts` (Phase 3, extended Phases 4-5)
  — the cron entry point, bearer-authed on its own `PAPER_CRON_SECRET`; now
  also enforces `lib/pipeline-db-guard.ts`'s prod-DB guard (guardrail #2 —
  Phase 3 shipped without it) and computes the shared ≤36/run, ≤108/day
  model-call budget via `lib/paper-db.ts`'s new `getModelCallsToday`.
- `.github/workflows/paper-portfolios.yml` (Phase 4) — 8 cron lines (4 slots ×
  EST/EDT), gate resolves which slot *window* the NY wall-clock time falls in
  (PR #147 — originally an exact-minute match that never fired, see
  [[incident-2026-09-22-paper-portfolios-slot-gate-never-matched]]) rather
  than a fixed hour (unlike `track-followed-tickers.yml`'s single-slot gate),
  `workflow_dispatch` inputs for a forced `slot`/`account`, a non-fatal
  "zero orders across all 8 accounts" sanity check on non-`settle` slots.
- `lib/paper-arbitration.ts` (Phase 5) — the model side of ARBITRATE: one
  `runSeat()` call per flagged candidate, `ARBITRATION_SYSTEM`'s constrained
  single-line-JSON output (veto/downsize/confirm), unparseable = CONFIRM-none.
- `lib/shared/paper-engine-core.ts`'s `selectArbitrationCandidates` /
  `applyArbitrationResults` (Phase 5) — pure selection (buys within 5 score
  points of the buy threshold, `score_exit` sells ≥80% of the way to their
  stop) and application, deliberately run *after* `planRun`'s CLIP rather than
  between PROPOSE and CLIP as §4.2 numbers the steps — see the module's own
  doc comment for why that preserves guardrail #5 by construction.
- `lib/firestore-admin.ts` / `lib/paper-firestore-mirror.ts` /
  `lib/paper-reconcile.ts` (Phase 6) — the first Firestore client this repo
  has needed (`firebase-admin`, new dependency). Lazily initialized from
  `FIRESTORE_SERVICE_ACCOUNT_JSON`; every write is non-fatal per guardrail #7.
  `lib/paper-engine.ts` calls the mirror after every run's Neon transaction
  commits and the reconcile check only at `settle`.
- `lib/shared/paper-metrics-core.ts` / `lib/paper-metrics.ts` (Phase 8) — §7's
  scoring: CAGR/vol/Sharpe match `docs/moo-council-run/sim_moo.py`'s `lump()`
  exactly. `lib/paper-engine.ts` calls it at `settle`, writing
  `paper_runs.detail.metrics`, non-fatal.
- `app/api/paper/{accounts,[account],[account]/nav,[account]/orders,[account]/watchlist}`
  (Phase 7) — public GETs, in-memory TTL cache (5-30 min depending on how
  often the underlying data changes), no Clerk gate — read-only aggregate
  data about simulated accounts, not user data (§6).
- `lib/shared/paper-view.ts` (Phase 7) — pure view-model builders shared
  between the API routes and `app/dashboard/council/portfolios/page.tsx`'s
  server render, matching `lib/shared/followed-tickers-view.ts`'s split.
- `app/dashboard/council/portfolios/` (Phase 7) — Clerk-gated (`pro_signals`)
  leaderboard + per-account drilldown, a hand-rolled inline SVG NAV
  sparkline, `<DisclaimerFooter surface="paper" />`.

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
- **Phase 3:** the run route had no prod-DB guard at all — `lib/pipeline-db-guard.ts`
  exists for exactly this and every other pipeline route uses it, but Phase 3
  shipped without it. Fixed in Phase 5's PR rather than a separate patch,
  since it touched the same route anyway.
- **Phase 5:** §4.2 numbers ARBITRATE (step 6) between PROPOSE (5) and CLIP
  (7); this build applies it *after* CLIP instead. A veto/downsize can only
  shrink an already-CLIP-satisfying order list, never require re-checking a
  cap, so the guardrail (#5, "the model never invents a ticker or a size") is
  preserved without needing to re-run CLIP — see
  `lib/shared/paper-engine-core.ts`'s module doc for the full argument. "Near
  its stop" and "genuinely tied" (§4.2 step 6's own wording) are also
  undefined by the design doc — this build picked 5 card-score points and 80%
  of the way from basis to stop, respectively; both are named constants
  (`BUY_TIE_BAND`, `NEAR_STOP_FRACTION`) rather than derived.
- **Phase 6:** only the *active* watchlist mirrors to Firestore — §5.1's
  layout implies deactivated rows (`active: false`, `drop_reason`) should
  also be visible there, but this build only ever reads/writes the active
  set. Deferred, not dropped.
- **Phase 8:** `spy`/`equal`'s total return for the active-return comparison
  is read from their own latest NAV point, not necessarily the *same* settle
  run — `PAPER_ACCOUNTS` runs the six trading accounts first, so their settle
  metrics would otherwise block on rows that don't exist yet within the same
  route call. One run's staleness on a comparison-only figure, judged
  acceptable against reordering the whole loop.
- **Phase 7:** which entitlement tier gates `/dashboard/council/portfolios`
  was undefined by the design doc (§6 lists the route but not its gate).
  Resolved as `pro_signals`, matching `followed-tickers`' own choice for a
  comparable surface — a decision made and recorded, not left ambiguous.
- **Phase 7:** `lib/shared/paper-view.ts`'s `AccountMetrics` type is a
  locally-owned duck-type of Phase 8's `paper_runs.detail.metrics` shape,
  not imported from `lib/shared/paper-metrics-core.ts` — this phase's branch
  was written with no hard dependency on Phase 8's code existing, so the two
  branches can merge in either order without one blocking the other.
- **Two stale status headers found and fixed while touching this doc**, not
  introduced by Phase 7: `docs/paper-portfolios-remaining-todo.md`'s and
  `docs/council-paper-portfolios.md`'s own status lines still said Phase 3
  was "done on this branch" / "in progress" after PR #128 had already merged
  it — the merge didn't update either header. Both now reflect actual state.

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
