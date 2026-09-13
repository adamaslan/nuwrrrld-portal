# Council Paper Portfolios — Remaining TODO

> Full design: [`council-paper-portfolios.md`](council-paper-portfolios.md).
> Implementation plan and file-level detail for every phase below live there
> (§10 "Build phases"); this doc tracks only what's **done vs. left**, and any
> open decisions a phase surfaced that the design doc didn't anticipate.

**Status as of 2026-09-13:** Phases 1–2 shipped. Phases 3–8 not started.

---

## Done

- [x] **Phase 1 — Schema + policy vectors.** PR [#124](https://github.com/adamaslan/nuwrrrld-portal/pull/124).
      6 tables (`paper_accounts`, `paper_runs`, `paper_watchlists`,
      `paper_positions`, `paper_orders`, `paper_nav`), the first `BEFORE
      INSERT` trigger this schema has had, `lib/shared/paper-policy.ts`
      (pure preference vectors), `lib/paper-db.ts` (data-access layer).
- [x] **Phase 2 — Seed script.** PR [#127](https://github.com/adamaslan/nuwrrrld-portal/pull/127).
      `scripts/seed-paper-portfolios.mjs` — 8 accounts, 501 watchlist rows,
      manifest-based reversibility.

---

## Left

### Phase 3 — Deterministic engine + run route

- [ ] `lib/paper-engine.ts` — steps 1–5 and 7–9 of §4.2 (LOAD, MARK, SCREEN,
      RANK, PROPOSE, CLIP, FILL, PERSIST). Skip step 6 (ARBITRATE) for this
      phase — every candidate falls through as CONFIRM-none.
- [ ] The §4.3 fill model: slippage bps by cap size, $0 commission,
      fractional shares (6dp), no shorting, split re-basing, delist/halt → `void`.
- [ ] `app/api/pipeline/paper-portfolios/route.ts` — POST, bearer auth via a
      new `PAPER_CRON_SECRET` (503 CONFIG_ERROR if unset, matching every
      other pipeline route). `?slot=preclose&account=t1` for targeted reruns.
      One `sql.transaction([...])` for the whole write per account per run.
- [ ] Idempotency on `(account, trade_date, slot)` — verify a duplicate POST
      for an already-run slot returns the existing `paper_runs` row and
      writes nothing new (§4.4 — the single most important correctness
      property in the design).
- [ ] Market-closed handling — no fresh `bar_date` → `status: 'skipped'`,
      `skip_reason: 'market_closed'`, never silent.
- [ ] **Manual step, not code:** run the seed script for real against a
      non-prod Neon branch before this phase can be tested end-to-end (Phase
      2 was only dry-run/validated in this session, never actually written).

### Phase 4 — Cron workflow

- [ ] `.github/workflows/paper-portfolios.yml` — 4 slots × 2 DST cron lines
      each, copied structure from `track-followed-tickers.yml` (gate/
      pipeline/notify job split, `concurrency` group, 15-min stagger after
      the corresponding afternoon-pipeline slot per §4.1's table).
- [ ] **Manual step:** set `PAPER_CRON_SECRET` as a repo secret via the
      `secrets-sync` skill (never typed into chat).
- [ ] A non-fatal sanity-check step (adapt `track-followed-tickers.yml`'s
      `::warning::` pattern) — "zero orders across all 8 accounts" at
      minimum; the model-call half of that check waits for Phase 5.

### Phase 5 — Arbitration layer (model calls)

- [ ] `lib/paper-arbitration.ts` — constrained-output system prompt
      (single-line JSON, `max_tokens≈80`, styled like
      `CHAIR_VERDICT_SYSTEM`), response shape `{ ticker, action:
      'veto'|'downsize'|'confirm', downsize_pct? }`. Unparseable response =
      CONFIRM-none.
- [ ] Wire into `lib/paper-engine.ts` between RANK and CLIP —
      `runSeat(seat, messages, apiKey, 80, 0.2)`, capped at ≤36 calls/run
      across all 8 accounts, ≤108/day. `quant` makes zero calls by
      construction — skip step 6 entirely for that account.
- [ ] `paper_runs.model_calls` incremented per actual call; a run that would
      exceed its cap degrades to deterministic-only rather than failing.

### Phase 6 — Firestore mirror + reconciliation

- [ ] Add `firebase-admin` dependency.
- [ ] `lib/paper-firestore-mirror.ts` — `mirrorPaperAccount(account)`,
      non-fatal (try/catch, `console.warn`, never throw), the §5.1
      collection layout verbatim. Watchlist mirrors only on seed/version
      bump, not every run.
- [ ] **Manual step:** provision `FIRESTORE_SERVICE_ACCOUNT_JSON` (or
      equivalent) via `secrets-sync`, targeting the same Firebase project
      `gcp3`'s mobile app already reads — **this is a genuinely new
      dependency for this repo** (no Firestore client exists in
      `nuwrrrld-portal` today; confirmed by exploration during planning).
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
  `log.md`) on every PR, same as Phases 1–2.
- Update this doc's checkboxes and `council-paper-portfolios.md`'s status
  header as each phase merges.

## Known overlaps with other in-flight work (as of 2026-09-13)

- Open PR #126 (`feat/beta-tester-pro-allowlist`) touches
  `docs/watchlist-seeds/README.md` and `docs/wiki-portal/index.md`/`log.md` —
  the same files Phase 2's PR #127 touched. Whichever merges first, the other
  needs a rebase before merging. Not this feature's branch to resolve.
