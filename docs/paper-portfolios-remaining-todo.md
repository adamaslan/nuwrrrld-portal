# Council Paper Portfolios — Remaining TODO

> Full design: [`council-paper-portfolios.md`](council-paper-portfolios.md).
> Implementation plan and file-level detail for every phase below live there
> (§10 "Build phases"); this doc tracks only what's **done vs. left**, and any
> open decisions a phase surfaced that the design doc didn't anticipate.

**Status as of 2026-09-14:** Phases 1–3 merged (#124, #127, #128). Phase 4
done on this branch. Phases 5–8 not started.

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
- [x] **Phase 4 — Cron workflow.** This branch
      (`feat/paper-portfolios-phase-4-cron`, cut from `origin/main`).
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

Until all three are done: the workflow's secret-check step fails before ever
calling the route, and even a manually authenticated call would find zero
`paper_accounts` rows.

### Phase 5 — Arbitration layer (model calls)

- [ ] `lib/paper-arbitration.ts` — constrained-output system prompt
      (single-line JSON, `max_tokens≈80`, styled like
      `CHAIR_VERDICT_SYSTEM`), response shape `{ ticker, action:
      'veto'|'downsize'|'confirm', downsize_pct? }`. Unparseable response =
      CONFIRM-none.
- [ ] Wire into `lib/paper-engine.ts` between RANK/PROPOSE and CLIP —
      `runSeat(seat, messages, apiKey, 80, 0.2)`, capped at ≤36 calls/run
      across all 8 accounts, ≤108/day. `quant` makes zero calls by
      construction — skip step 6 entirely for that account.
- [ ] `paper_runs.model_calls` incremented per actual call; a run that would
      exceed its cap degrades to deterministic-only rather than failing.
- [ ] Consider implementing the per-seat tilt functions (§4.2 step 4) at the
      same time — Phase 3 deferred them for lack of historical data, and
      Phase 5 is already adding new per-seat richness to the loop.

### Phase 6 — Firestore mirror + reconciliation

- [ ] Add `firebase-admin` dependency.
- [ ] `lib/paper-firestore-mirror.ts` — `mirrorPaperAccount(account)`,
      non-fatal (try/catch, `console.warn`, never throw), the §5.1
      collection layout verbatim. Watchlist mirrors only on seed/version
      bump, not every run.
- [ ] **Manual step:** provision `FIRESTORE_SERVICE_ACCOUNT_JSON` (or
      equivalent) via `secrets-sync`, targeting the same Firebase project
      `gcp3`'s mobile app already reads — a genuinely new dependency for this
      repo (no Firestore client exists in `nuwrrrld-portal` today).
- [ ] `lib/paper-reconcile.ts` — the `settle`-only drift check (NAV, position
      count, cash, order count, Neon vs Firestore), written into
      `paper_runs.detail.reconcile`.

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

### Phase 8 — Metrics + first written finding

- [ ] `lib/paper-metrics.ts` — total/day/since-inception CAGR, annualized
      vol, Sharpe (rf=0, matching `docs/moo-council-run/sim_moo.py`'s
      convention), max/current drawdown, hit rate, avg win/loss, rolling
      20-run turnover, avg holding period, active return vs `spy` and `equal`.
- [ ] Wire into the `settle` slot in `lib/paper-engine.ts`.
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

## Known overlaps with other in-flight work (as of 2026-09-13)

- **This file itself.** Phase 2's PR #127 and Phase 3's PR both create/edit
  `docs/paper-portfolios-remaining-todo.md`, since it's a done-vs-left
  tracker that every phase's PR necessarily touches. #127 merged first; this
  file was manually reconciled on Phase 3's branch during its rebase onto the
  post-#127 `main` rather than resolved by conflict markers alone — the
  "Done"/"Left" sections needed re-deriving, not just picking a side.
- PR #126 (`feat/beta-tester-pro-allowlist`) touches
  `docs/manual-setup-todo.md` and `docs/wiki-portal/index.md`/`log.md` — the
  same files Phase 3's branch touches. Whichever merges first, the other
  needs a rebase before merging.
