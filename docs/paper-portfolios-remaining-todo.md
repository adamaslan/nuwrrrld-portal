# Council Paper Portfolios — Remaining TODO

> Full design: [`council-paper-portfolios.md`](council-paper-portfolios.md).
> Implementation plan and file-level detail for every phase below live there
> (§10 "Build phases"); this doc tracks only what's **done vs. left**, and any
> open decisions a phase surfaced that the design doc didn't anticipate.

**Status as of 2026-09-13:** Phases 1–2 merged (#124, #127). Phase 3 done on
this branch. Phases 4–8 not started.

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

### Phase 3 — one manual step still blocks a real end-to-end run

- [ ] **Manual, not code** (tracked in `docs/manual-setup-todo.md`, added
      2026-09-13): run `scripts/seed-paper-portfolios.mjs` for real against a
      non-prod Neon branch (still only dry-run/validated in a session, never
      actually written), and set `PAPER_CRON_SECRET` via the `secrets-sync`
      skill. Until both are done, the route 401s with no secret configured
      and would find zero `paper_accounts` rows even once authenticated.

### Phase 4 — Cron workflow

- [ ] `.github/workflows/paper-portfolios.yml` — 4 slots × 2 DST cron lines
      each, copied structure from `track-followed-tickers.yml` (gate/
      pipeline/notify job split, `concurrency` group, 15-min stagger after
      the corresponding afternoon-pipeline slot per §4.1's table).
- [ ] **Manual step:** set `PAPER_CRON_SECRET` as a repo secret via the
      `secrets-sync` skill (never typed into chat) — same secret Phase 3
      already reads from `process.env`, just not yet provisioned as a GitHub
      Actions secret.
- [ ] A non-fatal sanity-check step (adapt `track-followed-tickers.yml`'s
      `::warning::` pattern) — "zero orders across all 8 accounts" at
      minimum; the model-call half of that check waits for Phase 5.

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
