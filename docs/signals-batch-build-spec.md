# Driving Selection with signals-app Depth — Shallow and Deep Build Specs

**Written:** 2026-08-31 · **Status:** proposal, neither path started
**Context:** [tickers-followed.md](tickers-followed.md) · [signals-app-summary.html](signals-app-summary.html)
**Depends on:** PR #94 (`bipolarCards`, the confluence port, the 950-ticker seeder).
Links below to `wiki-portal/incident-2026-08-31-bear-side-starved-at-universe-scale.md`
resolve once #94 merges.

---

## The question this answers

PR #94 ported four detector families and signals-app's weighted-confluence
model directly into the portal's Modal hydration walk
(`deploy/universe-hydration/modal_app.py`). That covers the whole 950-ticker
universe and needs no signals-app deployment at all.

What it does *not* give you is signals-app's remaining depth: the other ~15
detectors, the multi-timeframe composite, backtest-calibrated confidence, and
`relative_strength` peer ranking. Getting those means running signals-app
itself over some set of tickers.

This document specs two ways to do that, and — importantly — **corrects the
sizing given in this session's earlier assessment.**

---

## Correction to the earlier estimate

An earlier message in this session (and `docs/signals-app-summary.html`'s
"To make it useful" table, item 6) sized a batch endpoint at **"Days"**, on the
stated grounds that *"every route is per-symbol… a 950-ticker sweep is 950
sequential yfinance-backed calls."*

**That is wrong, and the repo already disproves it.** Reading
`~/code/signals-app/src/signals_app/service.py` directly:

| Claimed missing | Actually exists | Location |
|---|---|---|
| Batch analysis | `analyze_many()` — semaphore-bounded fan-out, `BatchResult.ok`/`.failed`, partial success first-class | `service.py:472` |
| Batch backtest | `backtest_many()` — same shape, merges category/strength buckets | `service.py:587` |
| Universe scan | `scanner.scan_universe()` + a `signals scan` CLI subcommand + `.github/workflows/signals-scan.yml` | `scanner.py:350` |

What is missing is **only the HTTP route** — a thin adapter over
`analyze_many`. The dataclasses (`BatchResult`, `BatchFailure`) even carry a
docstring naming the adapters they were designed for: *"CLI exit 6 / an MCP
payload carrying both lists / an HTTP 207-style body."* The batch design work
is done; nobody wired the last layer.

And the run has been **measured**, not estimated —
`~/code/signals-app/docs/universe-scan-findings.md`, 2026-08-20:

| Metric | Measured value |
|---|---|
| Universe scanned | **950** of 954 (4 hard failures) |
| Full-universe dry-run wall time | **43.8 s** at `--max-concurrent 4` |
| Per-symbol | **~46 ms**, CPU-bound at 47% — dominated by yfinance waits |
| Cleared the publication gate | 403 (42.2%) |
| LLM calls for a gated run | **0** — the gate runs *before* synthesis |

So the honest sizing is: **the expensive part was never the batching.** A
full-universe signals-app pass is a 44-second job. The cost is LLM synthesis,
and only if you enable it — which selection does not need.

The revised recommendation is at the bottom.

---

## What each path buys

| | Shallow (Path A) | Deep (Path B) |
|---|---|---|
| Tickers signals-app touches | ~100/month | 950 nightly |
| New HTTP surface | none | one route |
| signals-app deployment | none — CLI/Actions | Cloud Run or Modal |
| Runs on | GitHub Actions, monthly | nightly, alongside hydration |
| LLM cost | 0 (`no_llm=True`) | 0 base; 403 calls if synthesis on |
| MTF composite | on the ~100 | on all 950 |
| Drives selection | yes | yes |
| Drives the *displayed* card | no | yes |
| Effort | **half a day** | **2–3 days** |

Both paths leave the portal's own Modal walk in place. Neither replaces it —
signals-app becomes a *second opinion applied to a shortlist*, or a deeper
score for the whole universe. The portal's shallow card remains the thing that
renders, because it is the thing that covers every ticker every night.

---

# Path A — Shallow: re-rank the top ~100 shortlist

**Thesis:** selection only has to identify 20 tickers. It does not need depth
on 950 — it needs depth on the ~100 that could plausibly make the cohort.

The portal's Modal walk already scores all 950 nightly. Take its top 50 bulls
and top 50 bears (which `bipolarCards` now returns correctly), run *those*
through signals-app once a month, and let the deep score decide the final 20.

## A.1 — Shortlist export

Add `GET /api/pipeline/selection-shortlist` to the portal.

```
GET /api/pipeline/selection-shortlist?universe=all&perSide=50
Authorization: Bearer CRON_SECRET

200 → { "asOf": "2026-09-01", "universe": "all",
        "bulls": ["AAPL", ...], "bears": ["XYZ", ...] }
```

Implementation is four lines over existing code — call `bipolarCards(horizon,
perSide, scope)` and project to tickers. **Reuse `bipolarCards`, not
`topCards`**: a shortlist built from a signed top-N reintroduces exactly the
bug in
[incident-2026-08-31-bear-side-starved-at-universe-scale](wiki-portal/incident-2026-08-31-bear-side-starved-at-universe-scale.md),
one layer up.

Auth: `CRON_SECRET` bearer, matching `followed-tickers-select`.

## A.2 — Deep scoring run

A GitHub Actions job in `signals-app`, monthly on the 1st, **ahead of** the
portal's existing 14:00 UTC selection cron.

```yaml
# .github/workflows/deep-rerank.yml (in signals-app)
on:
  schedule: [{ cron: '0 12 1 * *' }]   # 2h before portal selection
  workflow_dispatch:
    inputs: { dry_run: { type: boolean, default: false } }
```

Steps:
1. `GET {PORTAL_URL}/api/pipeline/selection-shortlist?perSide=50`
2. `signals scan --symbols <100 tickers> --no-llm --json` (or
   `service.analyze_many(symbols, no_llm=True, max_concurrent=4)`)
3. POST results back to the portal.

**`no_llm=True` is not an optimization, it is the design.** Selection ranks by
confluence score; LLM synthesis produces *prose about* that score and cannot
change the ordering. Paying per-ticker for narrative that does not affect the
outcome is pure cost. Synthesis belongs on the 20 that get picked — which is
what the existing daily council run already does.

Measured cost: 100 symbols × ~46 ms ≈ **5 seconds**, zero LLM calls.

## A.3 — Ingest

New route `PUT /api/pipeline/deep-scores`:

```jsonc
{ "asOf": "2026-09-01", "source": "signals-app@<sha>",
  "scores": [ { "ticker": "AAPL", "deepScore": 62.5, "direction": "bullish",
                "confidence": "HIGH", "detectorCount": 14,
                "mtfComposite": 0.48, "action": "BUY" } ],
  "failed": [ { "ticker": "XYZ", "errorType": "InsufficientData" } ] }
```

Store in a **new** `deep_scores` table keyed `(ticker, as_of)`. Do **not**
overwrite `ticker_cards.confluence_score`.

Two reasons, and the second is the one that bites:

1. `ticker_cards` is written nightly for all 950 by the Modal walk. A monthly
   partial overwrite of 100 rows leaves the table in two regimes with no column
   saying which is which.
2. The portal's ingest already has a `shouldReplaceCard` rule and a documented
   stance that *"two implementations cannot contend for one row"*
   (`modal_app.py` header). A second writer on the same column is precisely
   what that warns against.

`failed[]` must be persisted, not logged. A ticker absent from `deep_scores`
because signals-app failed on it is a different fact from one absent because it
was never shortlisted — the same absent-vs-measured distinction as
[concept-three-state-signal](wiki-portal/concept-three-state-signal.md).

## A.4 — Selection consumes it

In `app/api/pipeline/followed-tickers-select/route.ts`, after `bipolarCards`:

```ts
const deep = await getDeepScores(cohortMonth);      // Map<ticker, DeepScore>
const rankable = cards.map((c) => {
  const d = deep.get(c.ticker);
  return {
    ticker: c.ticker,
    // Prefer the deep score; fall back to the shallow one when the deep run
    // skipped or failed this ticker. Never silently treat a missing deep
    // score as zero — that would rank an un-scored ticker as neutral and
    // push a genuinely strong shallow signal out of the cohort.
    direction: d?.direction ?? String(c.tokens?.direction ?? ""),
    score: d?.deepScore ?? (typeof c.score === "number" ? c.score : 0),
    scoreSource: d ? "deep" : "shallow",
  };
});
```

Persist `scoreSource` on the frozen pick. Without it, a future analysis of
which cohorts performed better cannot tell whether the deep re-rank helped —
which is the whole reason for building this.

**Ordering hazard:** the deep run must complete before selection reads it. The
2-hour gap is a soft guarantee, not a hard one. Selection should check the
freshness of `deep_scores.as_of` and, if stale, **proceed on shallow scores and
say so in the response** — never block the monthly cohort on a missing
optional input.

## A.5 — Path A checklist

- [ ] `GET /api/pipeline/selection-shortlist` (uses `bipolarCards`)
- [ ] `deep_scores` table + migration
- [ ] `PUT /api/pipeline/deep-scores` (persists `failed[]`)
- [ ] `deep-rerank.yml` in signals-app, `--no-llm`, 12:00 UTC on the 1st
- [ ] Selection prefers deep, falls back to shallow, records `scoreSource`
- [ ] Staleness check on `deep_scores.as_of` → degrade, don't block
- [ ] Test: deep score absent → shallow used, `scoreSource: "shallow"`
- [ ] Test: deep run returns only bulls → bear side still fills from shallow

## A.6 — What Path A does not give you

- Depth on the other 850 tickers. A name whose shallow score is mediocre but
  whose deep score would be extreme **never gets looked at**. This is the real
  ceiling: the shortlist is a shallow filter, so Path A can only re-rank within
  what the shallow model already liked.
- No effect on the displayed per-ticker card.
- Backtest hit-rate badges stay dark (needs the deployment in Path B).

---

# Path B — Deep: signals-app as a nightly universe service

**Thesis:** score all 950 with the full engine, nightly, and let signals-app be
the portal's signal engine rather than a monthly second opinion.

## B.1 — Install hygiene (mostly already done)

`docs/signals-app-summary.html`'s known-issues table lists three install
blockers. **Two are already fixed** — verified against the repo on 2026-08-31,
not carried forward from that doc:

| Blocker per the teardown | Actual state |
|---|---|
| `build-backend = "setuptools.backends.legacy:build"` | **Fixed** — `pyproject.toml:3` reads `setuptools.build_meta` |
| `aiosqlite` missing from `environment.yml` | **Fixed** — present at line 17 |
| No Node version pin | **Still open** — no `.nvmrc` |
| `wiki/`, `docs/`, `nu1.md` untracked | **Still open** — 2 untracked paths remain |

So B.1 reduces to adding a `.nvmrc` and committing the untracked docs.
**Minutes**, and it no longer blocks anything.

This is worth flagging beyond its own scope: the teardown doc is ~2 weeks old
and its known-issues table has drifted from the repo. Treat its remaining rows
as claims to re-verify, not as current state — including the "no batch
endpoint" row that this document's correction section already overturns.

## B.2 — The batch route

This is the piece everyone called "days." It is an adapter.

```python
@router.post("/signals/batch", summary="Batch pipeline analysis")
async def post_signals_batch(body: BatchRequest) -> BatchResponse:
    result = await service.analyze_many(
        body.symbols, body.period,
        no_llm=body.no_llm,                      # default True
        max_concurrent=body.max_concurrent or 4,
    )
    return BatchResponse(ok=[...], failed=[...])
```

Requirements:
- **Cap `len(symbols)` per request** (suggest 250) and require the caller to
  chunk. The portal's own ingest already takes this stance
  (`MAX_ROWS_PER_BATCH = 500`, *"a single unbounded batch is a timeout waiting
  to happen and gives no partial progress when it fails"*). Same reasoning.
- **Return 207-shaped partial success**, never 500 for one bad symbol —
  `BatchResult` is already built for this; do not flatten it.
- **`no_llm` defaults to True.** A 950-symbol batch with synthesis on is 403
  LLM calls; that must be opt-in, per-request, and never the default.
- Reject an invalid `period` up front with 400 — it fails every symbol, and
  `analyze_many` already raises `InvalidPeriod` for exactly this reason.

## B.3 — Deploy

Modal, matching `deploy/universe-hydration/modal_app.py`. The portal already
runs Modal for hydration, the team has the credentials, and
[wiki-portal/incident-2026-08-18-modal-under-recommended](wiki-portal/incident-2026-08-18-modal-under-recommended.md)
records Modal being routed around six times despite fitting — this is the same
shape of lane and the same fit.

Set `SIGNALS_ENGINE_URL` in the portal. **This alone lights up
`TrackRecordBadge` across the signals feed, the Hold/Fold panel, and per-ticker
pages** — all currently dark because `fetchBacktest` returns `null` immediately
when the URL is unset. `lib/backtest.ts` already calls
`/backtest/{symbol}?period=2y` and type-guards `by_category`/`by_strength`;
signals-app already serves that exact path, period, and shape. Zero code
change on either side.

Worth stating plainly: **this is the single highest value-per-hour item in
either path, and it does not require B.2 at all.**

## B.4 — Nightly universe pass

Extend the Modal app (or add a sibling) to run after hydration:

1. Read the active universe from `ticker_universe`.
2. Chunk to 250; call `POST /signals/batch` with `no_llm=true`.
3. `PUT /api/pipeline/deep-scores` per chunk.

Measured floor: **43.8 s** for the fetch/compute half. Real wall time will be
higher (Alpaca vs yfinance, network egress) but is nowhere near a cap. Per the
findings doc: *"If a shard runs long, LLM latency is the cause, and the fix is
shard count or concurrency — not detector optimization."*

**Vendor mismatch — the one genuine risk in Path B.** The portal's hydration
fetches from **Alpaca**; signals-app fetches from **yfinance**. Two vendors
disagreeing on adjusted closes means `deep_scores` and `ticker_cards` are
computed from different price series. Two consequences:

- Any comparison between deep and shallow scores is confounded.
- `entry_price` for a frozen pick comes from `live_prices`. A pick chosen on a
  yfinance-derived score and scored against an Alpaca-derived entry is a real,
  if small, inconsistency in a **published track record**.

Resolve deliberately: either point signals-app's fetcher at Alpaca (its
`data/fetcher.py` is a replaceable layer — that separation is the repo's stated
central design choice), or record the vendor on every `deep_scores` row and
treat cross-vendor comparison as invalid. Do not leave it unstated.

## B.5 — MTF composite

`compute_multi_timeframe()` and `build_timeframe_matrix()` are built and
tested, and `SignalOutput.matrix` is **always `None`** in the live route.
Expose the composite (1D/5D/1M/3M/6M weighted `{0.10, 0.15, 0.25, 0.30, 0.20}`,
3M carrying most weight) — **not** the matrix.

The distinction is cost: the composite is pure computation over bars already
fetched. `build_timeframe_matrix` makes **one LLM call per timeframe**, which
the findings doc prices explicitly: *"403 × up to 5 ≈ 2,000 calls, a 5x
multiplier."* It is already excluded from the `full_universe` workflow path for
that reason. Do not re-open that door at universe scale.

This is the piece that answers *"show data for all time periods"* in the sense
that can actually be delivered now — see the note below.

## B.6 — Path B checklist

- [ ] Add `.nvmrc` (build-backend and `aiosqlite` already fixed — verify before touching)
- [ ] `POST /signals/batch` over `analyze_many` — capped, 207-shaped, `no_llm` default True
- [ ] Deploy to Modal; set `SIGNALS_ENGINE_URL` *(do this first — it is independent)*
- [ ] Decide and record the vendor question (Alpaca vs yfinance)
- [ ] Nightly universe pass → `deep_scores`
- [ ] Expose MTF **composite** only; matrix stays off at universe scale
- [ ] Commit signals-app's `wiki/`, `docs/`, `nu1.md` — currently untracked

---

## A note on "all time periods"

Worth separating two things that sound alike:

- The **seven horizons** on the Followed Tickers page (`d1/w1/m1/m3/m6/y1/ytd`)
  are *realized-outcome windows*. They fill as wall-clock time passes after a
  pick is frozen; `y1` needs 252 trading days. **Neither path makes these
  populate sooner.** With `MIN_RESOLVED_FOR_RATE = 30`, the long horizons need
  roughly 18 months of cohorts before showing a percentage instead of `n<30`.
- The **MTF composite** (B.5) is a multi-timeframe read *at analysis time* and
  displays immediately.

If the goal is "the page shows numbers across time periods now," that is B.5,
not the horizons.

---

## Recommendation

Revised in light of the measurements above:

1. **B.3 first — half a day, mostly waiting on a deploy.** Deploying
   signals-app and setting `SIGNALS_ENGINE_URL` turns on backtest hit-rates
   across the entire portal UI with **no new code on either side** — the paths,
   period, and response shape already match exactly. It is independent of the
   batch route, the shortlist, and B.1 (whose real blockers turned out to be
   already fixed). Best value-per-hour item here by a wide margin.
2. **Then Path A — half a day.** It is genuinely cheap, needs no deployment,
   and is the fastest way to find out whether deep scores actually pick better
   cohorts. Ship it with `scoreSource` recorded so that question is answerable
   from data rather than from opinion.
3. **Then B.2 + B.4 — 1–2 days, if Path A shows the depth helps.** The
   remaining work is the vendor decision and the nightly wiring, not the
   batching. `analyze_many` is already written.

The thing to *avoid* is what the original sizing implied: treating the batch
endpoint as a multi-day blocker and deferring the whole idea behind it. The
blocker was never real, and step 1 was never behind it.
