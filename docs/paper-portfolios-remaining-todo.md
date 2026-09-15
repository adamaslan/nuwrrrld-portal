# Council Paper Portfolios — Remaining TODO

> Full design: [`council-paper-portfolios.md`](council-paper-portfolios.md).
> Implementation plan and file-level detail for every phase below live there
> (§10 "Build phases"); this doc tracks only what's **done vs. left**, and any
> open decisions a phase surfaced that the design doc didn't anticipate.

**Status as of 2026-09-15:** Phases 1–4 merged (#124, #127, #128, #137).
Phase 5–6 (arbitration + Firestore mirror/reconcile, PR #138) and Phase 8
(metrics, this branch, stacked on 5-6's tip) are code-complete, not yet
merged. Phase 7 (API + dashboard, PR #139) is code-complete, drafted
independently, cut from `origin/main`.

---

## Done

- [x] **Phase 1 — Schema + policy vectors.** PR [#124](https://github.com/adamaslan/nuwrrrld-portal/pull/124), merged.
      6 tables (`paper_accounts`, `paper_runs`, `paper_watchlists`,
      `paper_positions`, `paper_orders`, `paper_nav`), the first `BEFORE
      INSERT` trigger this schema has had, `lib/shared/paper-policy.ts`
      (pure preference vectors), `lib/paper-db.ts` (data-access layer).
- [x] **Phase 2 — Seed script.** PR [#127](https://github.com/adamaslan/nuwrrrld-portal/pull/127), merged.
      `scripts/seed-paper-portfolios.mjs` — 8 accounts, 501 watchlist rows,
      manifest-based reversibility. Still only dry-run/validated, never
      actually written against a real Neon branch (see "Left" below).
- [x] **Phase 3 — Deterministic engine + run route.** This branch
      (`feat/paper-portfolios-phase-3-engine`, cut from `origin/main`, not
      stacked on #127 — per this file's own cross-cutting rule).
  - `lib/shared/paper-engine-core.ts` — pure RANK/PROPOSE/CLIP/FILL. No I/O,
    unit-tested directly (`__tests__/paper-engine-core.test.ts`).
  - `lib/shared/paper-sectors.ts` — ticker→sector map for sector-cap
    enforcement, plus the mega/large-cap set the fill model's slippage tier
    reads. **Best-effort, not verbatim** — see its module doc: §2.1 only
    states aggregate sector-mix *counts* per account's 25 extras, not a
    per-ticker assignment, so this is a defensible GICS-style classification
    rather than a transcription.
  - `lib/paper-engine.ts` — the I/O shell: LOAD/MARK/SCREEN/PERSIST, calling
    the pure module for RANK/PROPOSE/CLIP/FILL. One `sql.transaction([...])`
    per account per run; idempotency via a client-generated run id whose FK
    on `paper_orders.run_id` aborts the whole transaction on a race loss
    (module doc in `lib/paper-engine.ts` explains why this is correct, not
    just convenient).
  - `getScreenCandidates` (added to `lib/paper-db.ts`) and `getLivePrices`
    (added to `lib/live-price-db.ts`) — the two read queries the engine
    needed that didn't exist yet.
  - `app/api/pipeline/paper-portfolios/route.ts` — POST, bearer auth via a
    new `PAPER_CRON_SECRET`, `?slot=` required, `?account=` optional for a
    targeted rerun. Per-account try/catch so one account's failure doesn't
    abort the other seven.
  - Market-closed handling: no fresh `bar_date` → `status: 'skipped'`,
    `skip_reason: 'market_closed'`, recorded, never silent.
  - Step 6 (ARBITRATE) does not exist — every order this phase writes has
    `decided_by = 'rule'`, `model = null`. Phase 5 adds the model layer.
- [x] **Phase 4 — Cron workflow.** PR [#137](https://github.com/adamaslan/nuwrrrld-portal/pull/137), merged.
  - `.github/workflows/paper-portfolios.yml` — 8 cron lines (4 slots x EST/EDT
    each), copied structure from `track-followed-tickers.yml` (gate/run/notify
    job split, `concurrency` group, step summary, failure issue). Unlike the
    single-slot workflows this repo already has, the gate resolves *which* of
    the four slots fired from the NY wall-clock time itself (`09:00` ->
    `preopen`, `12:30` -> `midday`, `15:45` -> `preclose`, `16:30` -> `settle`)
    rather than gating a fixed hour - the doubled EST/EDT cron lines mean only
    one of the eight entries matches on any given day; the rest no-op.
  - `workflow_dispatch` inputs let a human force a specific `slot` and/or a
    single `account` for a targeted rerun, matching the route's own
    `?account=` support.
  - Non-fatal sanity-check step: warns (does not fail) if `meta.ordersTotal`
    is `0` across all 8 accounts on a non-`settle` slot and no account was
    skipped - `settle` is excluded since it never trades by design (§4.1).
    The model-call half of this check (Phase 5) isn't wired - there's no
    model-call field to check yet.
  - `PAPER_CRON_SECRET` is verified present (like `PORTAL_URL`) before the
    run step, matching `track-followed-tickers.yml`'s secret-presence guard.
- [x] **Phase 5 — Arbitration layer (model calls).** This branch
      (`feat/paper-portfolios-phase-5-6-arbitration-firestore`, cut from
      `origin/main`).
  - `lib/shared/paper-engine-core.ts` — `selectArbitrationCandidates` (pure:
    flags buys within `BUY_TIE_BAND` (5 score points) of the buy threshold,
    and `score_exit` sells that have closed `NEAR_STOP_FRACTION` (80%) of the
    distance to their stop; `stop`/`void` sells are forced exits and never
    arbitrated) and `applyArbitrationResults` (pure: veto drops the order,
    downsize shrinks quantity and relabels `reason: 'seat_downsize'`, confirm
    or "no decision" both leave it untouched).
  - `lib/paper-arbitration.ts` — `arbitrateOne()`, the actual model call:
    the seat's own persona prompt (`seatSystemPrompt`) plus a constrained
    single-line-JSON instruction block, `max_tokens=80`, `temperature=0.2`.
    `parseArbitrationResponse` degrades any unparseable/malformed answer to
    CONFIRM-none, never throws.
  - `lib/paper-engine.ts` — wired between `planRun` and `fillOrders`,
    **after** CLIP rather than between PROPOSE and CLIP as §4.2 numbers the
    steps; see that file's own module doc and paper-engine-core.ts's doc on
    `selectArbitrationCandidates` for why post-CLIP is still faithful to
    guardrail #5 (veto/downsize can only shrink an already-satisfying order
    set, never require re-clipping). `model_calls` is now the real count;
    `decided_by`/`model` are set per order from the arbitration result.
  - Budget: `ModelCallBudget` is one mutable object the route constructs
    once (`min(36, 108 - getModelCallsToday(tradeDate))`) and threads through
    every account's `runAccountSlot` call, so the ≤36/run-across-all-accounts
    and ≤108/day ceilings are enforced globally, not per account. `quant`
    (`maxModelCallsPerRun: 0`, already in `PAPER_POLICY`) never enters the
    arbitration block.
  - **Deferred, not implemented:** the per-seat tilt functions (§4.2 step 4)
    the todo item suggested bundling in here. Phase 3's reason for deferring
    them (no historical price series in `ticker_cards`) is unchanged by
    adding the arbitration layer — bundling them would have been scope
    creep against what was actually blocking, not a natural pairing.
- [x] **Phase 6 — Firestore mirror + reconciliation.** Same branch as Phase 5
      (see "Known overlaps" below for why these two shipped together instead
      of as separate branches).
  - `firebase-admin` added to `package.json` (`^13.0.0`).
  - `lib/firestore-admin.ts` — lazy, memoized Admin SDK init from
    `FIRESTORE_SERVICE_ACCOUNT_JSON`; returns `null` (never throws) when
    unset or unparseable, which every caller treats as "mirror/reconcile is
    a no-op this run" (guardrail #7).
  - `lib/paper-firestore-mirror.ts` — `mirrorPaperAccount()` (account
    summary + full positions subcollection, replacing stale docs for
    closed-out tickers + this run's new orders, doc id = the Neon order
    uuid, so a replay is idempotent + the day's NAV doc, one field per slot
    + the run-status doc) and `mirrorWatchlistIfVersionChanged()` (reads the
    account doc's own `watchlist_version` field first; only re-writes the
    watchlist subcollection when it disagrees with the current version).
  - `lib/paper-reconcile.ts` — `reconcileAccount()`, called only at `settle`:
    compares Neon cash/NAV/position-count/order-count against the Firestore
    mirror, written into `paper_runs.detail.reconcile` via
    `updateRunDetail()`.
  - **Known simplification:** only the *active* watchlist mirrors. §5.1's
    layout implies dropped tickers stay visible with `active: false`;
    mirroring the full (including-inactive) history is deferred, not
    silently dropped.
  - **Known simplification:** the mirror only runs on a run that actually
    executed (`status: 'ok'`). A market-closed `skipped` run is recorded in
    Neon's `paper_runs` but not yet mirrored to Firestore's
    `paper/{account}/runs/*` — deferred for scope, not an oversight.
- [x] **Phase 8 — Metrics.** Branch `feat/paper-portfolios-phase-8-metrics`,
      cut from Phase 5-6's branch (extends the same `lib/paper-engine.ts`
      `settle` block those phases already touch, so it stacks rather than
      re-deriving that wiring).
  - `lib/shared/paper-metrics-core.ts` — pure §7 scoring: CAGR, annualized
    vol, Sharpe (rf=0), max/current drawdown, hit rate + avg win/loss,
    rolling 20-run turnover, avg holding period, active return vs `spy`/
    `equal`. CAGR/vol/Sharpe formulas match `docs/moo-council-run/sim_moo.py`'s
    `lump()` exactly (sample std, `sqrt(252)` annualization). Unit-tested in
    `__tests__/paper-metrics-core.test.ts`.
  - `lib/paper-metrics.ts` — the I/O side: reads the `settle`-slot NAV series
    (not every slot — using intraday marks as independent daily returns would
    badly overstate annualized vol), the last 20 runs' turnover, and the full
    order history, then calls the pure module.
  - Wired into `lib/paper-engine.ts`'s `settle` block, alongside Phase 6's
    reconcile call — writes `paper_runs.detail.metrics`, best-effort (a
    scoring failure never fails the run, same contract as mirror/reconcile).
  - **Known simplification:** holding period is derived from order history
    (first buy since flat → the closing sell), not a stored field — correct
    given Phase 3's own "a sell is always a full exit" simplification, but it
    would need lot-level tracking to stay correct if that assumption ever
    changes.
  - **Known simplification:** `spy`/`equal`'s total return for the active-
    return comparison is read from their own latest NAV point, not
    necessarily from the *same* settle run — `PAPER_ACCOUNTS` runs the six
    trading accounts before the two controls in one route call (§6), so a
    trading account's settle metrics would otherwise block on rows that don't
    exist yet. One run's staleness on a comparison-only figure was judged an
    acceptable trade against reordering the whole route loop.

### Known simplifications introduced in Phase 3 (stated, not bugs)

- **Per-seat tilt functions (§4.2 step 4) are not implemented.** The design
  doc names momentum (t1), inverse-vol (risk), sector-rotation bonus (macro),
  and state-persistence (t2) tilts. None of the data those need (historical
  price series, realized vol, a state-key history) exists in `ticker_cards`
  today — it stores one row per (ticker, horizon), not a time series. RANK is
  therefore raw `score DESC, ticker ASC` for every account in this phase. A
  real tilt function is a data-plumbing project on its own and is deferred,
  not silently dropped — flagging it here so it isn't mistaken for an
  oversight later.
- **A sell is always a full exit**, never a partial trim. Nothing in §4
  calls for trimming an *existing* position back to its cap on its own (the
  cap only gates new buys), so this wasn't invented.
- **`cardHorizon: 'both'` (quant, chair) takes the higher of the t1/t2
  score** per ticker, not a blend — §3 doesn't specify how to combine them.

---

## Left

### Phases 3–4 — three manual steps still block a real end-to-end run

None of the three below are code. All are tracked in
`docs/manual-setup-todo.md` (added 2026-09-13, Phase 4's secret-push item
added 2026-09-14):

- [ ] **Seed the DB for real.** Run `scripts/seed-paper-portfolios.mjs`
      against a confirmed non-prod Neon branch — still only dry-run/validated
      in a session, never actually written. Blocked as of 2026-09-14 on
      confirming which Neon branch the local `DATABASE_URL` names (see
      `docs/caveats/2026-09-14-council-paper-portfolios-db-safety.md` — the
      prod-write guard, `PRODUCTION_DB_HOST`, is also unset and therefore
      inert, so this isn't just "run the script," it's "confirm the target
      first").
- [ ] **Generate `PAPER_CRON_SECRET`** via the `secrets-sync` skill (never
      typed into chat) and put it in `.env.local` / Vercel. The route already
      reads it from `process.env.PAPER_CRON_SECRET`.
- [ ] **Push that same `PAPER_CRON_SECRET` to GitHub Actions** —
      `gh secret set PAPER_CRON_SECRET` (piped from a file, never pasted) —
      so `.github/workflows/paper-portfolios.yml`'s "Verify required secrets
      exist" step stops failing every scheduled run.

`.github/workflows/paper-portfolios.yml` (Phase 4, PR #137) is merged and live
on `main`. Until all three steps above are done: the workflow's secret-check
step fails before ever calling the route, and even a manually authenticated
call would find zero `paper_accounts` rows.

### Phase 5 — Arbitration layer (model calls) — done, see "Done" above

- [ ] **Manual step, new in this phase:** provision `OPENROUTER_API_KEY` in
      whatever environment runs the paper-portfolios route, if it isn't
      already set there for the rest of the council. Without it, arbitration
      is silently skipped (every order is `decided_by: 'rule'`) rather than
      the run failing — confirm the key is present if seat-distinct behavior
      is expected, don't assume its absence would be loud.

### Phase 6 — Firestore mirror + reconciliation — done, see "Done" above

- [ ] **Manual step:** provision `FIRESTORE_SERVICE_ACCOUNT_JSON` via
      `secrets-sync`, targeting the same Firebase project `gcp3`'s mobile app
      already reads — a genuinely new dependency for this repo (no Firestore
      client existed in `nuwrrrld-portal` before this phase). Until it's set,
      every mirror/reconcile call is a documented no-op (`error:
      "not_configured"` in `paper_runs.detail`) — the run itself still
      succeeds.
- [ ] `npm install` to actually resolve `firebase-admin` — `package.json` was
      edited and `package-lock.json` regenerated in this branch's own
      worktree, but confirm it lands clean after a rebase/merge onto
      whatever `main` looks like by the time this ships (Phase 4's branch
      also touches `package-lock.json`-adjacent files not at all, so no
      conflict expected there specifically).

### Phase 7 — API routes + dashboard

- [ ] `app/api/paper/accounts`, `app/api/paper/[account]`,
      `app/api/paper/[account]/nav`, `.../orders`, `.../watchlist` — GET,
      public, in-memory TTL cache (matching `app/api/council/sample/route.ts`'s
      pattern, not the IP-hash quota machinery).
- [ ] `lib/shared/paper-view.ts` — pure builder shared between the server
      page and the API routes (matching `lib/shared/followed-tickers-view.ts`).
- [ ] `app/dashboard/council/portfolios/page.tsx` + `PaperPortfoliosClient.tsx`
      — Clerk-gated leaderboard, CSS-grid `role="table"` (no charting library
      in this repo — plan is a hand-rolled inline SVG NAV sparkline).
- [ ] **Open decision, not yet confirmed:** which entitlement tier gates this
      page. The design doc doesn't say; `followed-tickers` uses
      `pro_signals` and this is the natural default, but worth a one-line
      confirm before shipping rather than assuming.
- [ ] Add `"paper"` to `components/DisclaimerFooter.tsx`'s `surface` union;
      render it on the new dashboard page.

### Phase 8 — first written finding — done, see "Done" above for the metrics code

- [ ] **Not code, needs real accumulated data first:** once enough runs exist
      to say something real, write
      `docs/wiki-portal/decision-paper-portfolio-first-finding.md` answering
      §7's headline question — does any seat beat `quant` by enough to
      justify inference cost. This is deliberately last — it needs weeks of
      real runs, not a code change.

---

## Cross-cutting items that apply to every remaining phase

- One branch per phase, cut from `origin/main`, per this repo's
  `no-conflicts1` / `multi-branch-optimization` conventions — not stacked on
  the prior phase's branch.
- Wiki ingest (`docs/wiki-portal/entity-paper-portfolios.md` + `index.md` +
  `log.md`) on every PR, same as Phases 1–3.
- Update this doc's checkboxes and `council-paper-portfolios.md`'s status
  header as each phase merges.

## Known overlaps with other in-flight work (as of 2026-09-15)

- **This file itself.** Every phase's branch edits
  `docs/paper-portfolios-remaining-todo.md` (it's a done-vs-left tracker that
  every phase necessarily touches) — resolved by re-deriving the "Done"/"Left"
  sections on each rebase, never by picking a side at the conflict markers.
- **Phases 5+6 deliberately share one branch**
  (`feat/paper-portfolios-phase-5-6-arbitration-firestore`), a documented
  exception to this file's own "one branch per phase" cross-cutting rule.
  Reason: both were requested in the same turn, and both edit the exact same
  insertion point in `lib/paper-engine.ts` (Phase 5 between `planRun` and
  `fillOrders`, Phase 6 immediately after the transaction commits) — splitting
  them into two branches cut from the same `origin/main` would have produced
  a guaranteed, purely mechanical self-conflict on the very next merge, for
  no isolation benefit (no second agent was working either phase
  concurrently). See `multi-branch-optimization.md` §1: "if two planned
  branches overlap on any file, either sequence them or split" — this is the
  sequencing option, made explicit rather than silently deviating from the
  stated convention.
- **Phase 4** (PR #137, merged 2026-09-15) and **this Phase 5+6 branch**
  touched the same top-of-file module comment in
  `app/api/pipeline/paper-portfolios/route.ts`, plus
  `docs/paper-portfolios-remaining-todo.md` and `docs/manual-setup-todo.md`.
  Resolved via a standard rebase of this branch onto `main` after #137
  merged — re-derived the "Done"/"Left" sections and the route.ts comment
  rather than picking a side at the conflict markers, per this file's own
  convention.
- PR #126 (`feat/beta-tester-pro-allowlist`, already merged) touched
  `docs/manual-setup-todo.md` and `docs/wiki-portal/index.md`/`log.md` — noted
  here for history; no longer a live overlap since it merged before this
  branch was cut.
