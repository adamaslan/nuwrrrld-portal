# Signal Engine: Three-Phase Plan

**Written 2026-09-03.** Execution plan for the findings in
[docs/signal-engine-parity-across-hosts.md](signal-engine-parity-across-hosts.md).
That document is the *evidence*; this one is the *order of operations*.

Spans two repos: `nuwrrrld-portal` (this one) and `~/code/signals-app`. Their
manual checklists are [docs/manual-setup-todo.md](manual-setup-todo.md) and
`~/code/signals-app/docs/TODO.md`.

---

## The shape of the problem

Three failures stacked on top of each other, and they must be fixed in this
order because each one hides the next:

1. **The pipeline is not running.** Nightly hydration has failed 11 consecutive
   times since 2026-08-19 on a missing secret. Newest `bar_date` in
   `ticker_cards` is 15 days old.
2. **If it ran, it would scale wrong.** `hydrate-local.mjs` doesn't paginate,
   so the chunk-size and lookback increases that 950 tickers need would silently
   drop symbols.
3. **If it scaled, it would compute the wrong thing.** `confluence` has drifted
   between Modal and the JS engine, `dataQuality` measures field-completeness
   rather than quality, and the whole cross-sectional half of signals-app's
   model was never ported.

Each phase closes one layer. **Do not start a phase before its predecessor's
exit gate passes** — the gates exist because every one of these failures was
invisible from inside the layer above it.

| Phase | Theme | Effort | Blocking risk if skipped |
|---|---|---|---|
| **1. Restore & Observe** | Make the pipeline run, and make its silence audible | ~1 day, mostly dashboard work | Everything else is unobservable |
| **2. Correct & Scale to 950** | Pagination, pinned constants, symbology, full universe | ~2–3 days engineering | Silent coverage loss at scale |
| **3. Unify & Enrich** | One confluence engine, real data quality, cross-sectional signals | ~1–2 weeks | Cards remain pre-port and intra-symbol only |

---

## Phase 1 — Restore & Observe

**Goal:** a green nightly run, and a mechanism that tells a human when it stops
being green. Nothing in Phases 2–3 is measurable until this holds.

**Almost all of this is human/dashboard work, not code.** That is why it is
first: it is the cheapest phase and the one blocking everything.

### 1.1 Restore the three missing secrets 🔴

Verified absent from repo secrets on 2026-09-03 (`gh secret list` — 17 secrets
present, these three not among them):

- `PORTAL_PUSH_SECRET`
- `ALPACA_API_KEY`
- `ALPACA_API_SECRET`

All three exist in `.env.local`. Push file-to-CLI so no value passes through a
chat session:

```bash
scripts/sync-hydration-secrets.sh
gh secret list | grep -E 'PORTAL_PUSH_SECRET|ALPACA'   # expect 3 rows
```

This resolves a two-year-old open question in
[manual-setup-todo.md §4](manual-setup-todo.md) — *"Decide `PORTAL_PUSH_SECRET`
— generate it or delete the dependency"*. The answer is now evidence-backed:
**the caller is real.** `hydrate-universe.yml` is a live scheduled consumer, and
deferring the decision cost 15 days of universe coverage.

### 1.2 Smoke test before the full run

```bash
gh workflow run hydrate-universe.yml -f limit=25
gh run watch
```

Expect green, `written=50` (25 symbols × 2 horizons), `calc-errors=0`.

### 1.3 Fix the dead `vars.PORTAL_URL` lookup

`hydrate-universe.yml` reads `${{ vars.PORTAL_URL }}`, but `PORTAL_URL` is
registered as a **secret**, not a variable. The lookup misses and falls through
to the hardcoded default — which is correct, so nothing is broken, but the
reference reads as configurable and is not. Either register it as a variable or
change the workflow to `secrets.PORTAL_URL`.

### 1.4 Alert on failure

**Implemented as an `if: failure()` step that opens or updates a
`hydration-failure`-labeled GitHub issue** (`.github/workflows/hydrate-universe.yml`
"Open or update the hydration-failure tracking issue"), not a channel post —
channel notification remains a separate, unimplemented idea if it's ever
wanted. Eleven silent red runs is a monitoring gap, not a workflow gap — the
workflow's own guard worked perfectly and named the missing secret; this just
makes the failure visible somewhere a human will see it.

### 1.5 Add a freshness check independent of the writer

The failure mode in 1.1 is that the *writer* is broken, so no assertion inside
the writer can catch it. Add a check — its own tiny scheduled job, or a step in
the already-running `afternoon-pipeline.yml` — that fails when
`max(bar_date) FROM ticker_cards` is more than ~3 trading days old.

**Staleness is the symptom that survives every possible cause.** This would
have caught the outage on day four.

### 1.6 (signals-app) The same class of failure, same fix

`signals-app` P0 #1 is structurally identical: `OPENROUTER_API_KEY` is missing
from its repo secrets, and its production run is blocked on it. Do both while
the context is loaded.

### Exit gate

- [ ] Three secrets present; `gh secret list` verified, not assumed
- [ ] A full scheduled run completes green
- [ ] `max(bar_date)` is today or the last trading day
- [ ] A deliberate failure produces a notification a human receives
- [ ] The freshness check fails when pointed at stale data (test it by lowering
      the threshold, not by waiting three days)

---

## Phase 2 — Correct & Scale to 950

**Goal:** all ~950 registered tickers scanned nightly, with correctness proven
rather than assumed.

**Ordering inside this phase is load-bearing.** Pagination must land before the
lookback and chunk-size increases, or step 2.2 silently drops symbols.

### 2.1 Paginate the JS fetch — first, and alone

Port Modal's `next_page_token` loop into `fetchBarsOnce`
(`modal_app.py:548` is the reference implementation). Alpaca caps a response at
10,000 bars and paginates **sorted by symbol, then timestamp** — an over-cap
request returns the leading symbols complete and drops the trailing ones
entirely.

Ship with the observability that makes the failure visible:

```
[hydrate] chunk 12/28  pages=1  symbols=35/35  bars=8,742
```

A chunk that comes back short is the observable form of every vendor problem in
the parity doc, and it currently has no log line of its own.

### 2.2 Pin the constants — one commit, one shared source

Only after 2.1. Put these in `lib/shared/hydration-constants.ts`, re-exported to
`.mjs`, with Modal reading a committed JSON twin:

| Constant | From | To | Why |
|---|---|---|---|
| `LOOKBACK_DAYS` | 120 | **365** | matches Modal; unblocks 50/200 MA; stabilizes vol-percentile |
| `CHUNK_SIZE` | 10 | **35** | largest chunk fitting one 10k-bar page at 365 days |
| `feed` | unset | **`iex`** | pin today's plan default so a plan upgrade becomes a diff |
| `adjustment` | unset | **`split`** | matches Modal; removes split discontinuities |
| min bars | 40 (JS) / 30 (Py) | **one value** | currently disagrees across hosts |
| `MIN_COVERAGE_RATIO` | none in GHA | **0.95** | GHA only fails on total zero today |

### 2.3 Fix the symbology mismatch at the repo boundary 🟠

**This is the cross-repo finding, and it is not a typo.**

`seed/universe_symbols.csv` lives in `signals-app`, which fetches through
**yfinance**. yfinance spells share classes with a **hyphen**: `BRK-B`, `BF-B`.
Alpaca spells them with a **dot**: `BRK.B`, `BF.B`. The portal inherits
yfinance-shaped tickers and feeds them to Alpaca, which 400s them, and
`prune-universe.mjs` correctly classifies them `reject` on the evidence it has.

So `BRK-B` and `BF-B` sit deactivated in `ticker_universe` — two of the most
liquid names on the tape, marked as if delisted.

The fix belongs in the portal, not the CSV: **normalize at ingest**, because the
CSV is correct for its own vendor. Add a symbology mapping in
`seed-signals-universe.mjs` (`-` → `.` for single-letter class suffixes), then
reactivate and let the next run prove it.

Verify the preferred-share form (`SCHW-PD`) separately — that is a genuinely
different notation, not just a separator swap.

Cross-check worth running while here: signals-app's own dry run reports **954
scanned / 403 published / 4 failed**. Identify those 4 failures. If they are the
same share-class names, the CSV has a vendor-neutrality problem worth solving at
the source instead of in two downstream normalizers.

### 2.4 Harden registration against crypto

`BTC-USD`, `ETH-USD`, `DOGE-USD`, `SOL-USD` are registered as `universe='etf'`
and deactivated. `scopeFor()` maps `Crypto → null`, so **these did not come from
`seed-signals-universe.mjs`** — another seeder registered them, or they predate
the current CSV.

They are the exact symbols behind the whole-chunk-400 incident documented in
`fetchBars`'s header ("a 178-symbol ETF run lost 40 rows to 4 bad tickers").
Reject crypto-shaped tickers at the registration route so no seeder can
re-add them. They do not count toward 950 and should not.

### 2.5 Re-seed and reconcile to 950

```bash
node scripts/seed-signals-universe.mjs --dry-run   # expect 776 stock + 174 etf = 950
node scripts/seed-signals-universe.mjs
node scripts/prune-universe.mjs --dry-run          # anything in `retry` is a pipeline bug
```

**Hold the distinction between attempted and carded.** 950 is the seed ceiling,
not a coverage target. Some inactive rows are genuine corporate actions —
`TWTR` (delisted 2022), `PXD`, `SRNE` — and should stay inactive. Do not pad the
universe with new tickers to hit a round number; the number that matters is the
coverage ratio against symbols the vendor demonstrably serves.

### 2.6 Full run and verification

At chunk 35 with concurrency 3, 950 symbols is ~28 Alpaca requests against a
200/min budget — **14% of one minute's allowance.** Rate limits are not the
constraint at this scale and never were; pagination and feed quality are.

Verify:
- `total` ≈ 950
- `written` ≈ 2 × carded symbols (both horizons)
- every chunk logged `pages=1` and `symbols=N/N`
- coverage ratio ≥ 0.95 against active symbols

### Exit gate

- [ ] Pagination merged, with per-chunk page and symbol-count logging
- [ ] Constants live in one shared source read by both hosts
- [ ] Share-class symbols reactivated and carding
- [ ] Crypto rejected at registration
- [ ] A full run reports ~950 attempted and ≥ 0.95 coverage
- [ ] No chunk reported `pages > 1` or a short symbol count

---

## Phase 3 — Unify & Enrich

**Goal:** one confluence implementation, an honest `dataQuality`, and the
cross-sectional signals that 950 nightly symbols make possible and that nothing
currently uses.

### 3.1 One confluence implementation (R1) — do this first

Everything else in Phase 3 adds detectors. Adding them before unifying means
**porting every detector twice**, which is precisely the bug in the parity doc's
§2.2.

Preferred shape: **the portal owns confluence.** Compute it in
`lib/shared/card-policy.ts` from the raw indicators the row already carries;
hosts post only `rsi / macdCross / adx / volatilityPercentile` plus the frame
statistics the detectors need. Modal and `hydrate-local.mjs` both delete their
confluence code.

Until it lands, pin the drift so it cannot widen: extend
`__tests__/hydrate-indicators.test.ts` to compare JS `confluence` against
captured Python `_confluence` output. **That test fails today — that is the
point.**

### 3.2 Real `dataQuality` — highest value, smallest diff

`card-policy.ts:90` currently defines quality as
`fields_present / 5`. Pure completeness. It says nothing about whether the bars
were stale, whether the series had holes, or whether there were enough of them.

This is already load-bearing: it is the `shouldReplaceCard` tie-break, and it is
*why* the GHA ETF lane silently outranks gcp3's purpose-built ETF model — a
5-of-5 card from a truncated window beats a 2-of-5 card from a better engine.

Port `signals-app/src/signals_app/indicators/data_quality.py` (bar count, NaN
ratio, staleness → 0.0–1.0 plus human-readable `reasons`) and apply it as a
factor:

```ts
dataQuality = completeness(input) × barQuality(frameStats)
```

Two side effects worth having: it makes the §4 ETF-ranking accident into an
honest comparison, and a staleness deduction means a 15-day-old card is visibly
worse than a fresh one instead of exactly as good — a second line of defense
against Phase 1's failure mode.

Carry `reasons` through to the card. "Why is this card low quality" is currently
unanswerable from stored data.

**Cross-repo note:** signals-app's own P1 #6 flags that this module's tests are
time-of-day flaky (`DATA_QUALITY_STALE_HOURS = 26.0` vs. fixtures built from
`date.today()`). Fix that there first, or write the portal's tests with frozen
time from the start. Do **not** widen the staleness threshold to make a test
pass — it is a real production gate.

### 3.3 Relative strength and sector rank — the actual universe feature

`scoring/relative_strength.py` is the only thing in either codebase that scores
a symbol **against its peers** rather than against its own history.

Everything the portal computes today is intra-symbol. At 950 symbols scanned
nightly you already have the cross-section and are discarding it. One pass over
closes you already fetched yields:

- returns at 1M / 3M / 6M / 12M
- percentile rank of each within the universe
- percentile rank **within `sector_group`** — the CSV carries this column
  (`"Technology → Semiconductors"`, 130+ groups) and
  `seed-signals-universe.mjs` parses and discards it
- 52-week range position

It composes with the existing taxonomy: `bucketRank(pctile)` →
`leader / middle / laggard` is a natural eighth `state_key` dimension. Sector
relativity is what lets a card say "strong, and strong *for a semiconductor*."

Shared lineage worth noting: `relative_strength.py` is adapted from
`gcp3/backend/technical_signals.py` and uses the *same* ±0.35 threshold and ≥3
agreeing-signal gate as Modal's `_confluence`. Porting it partly reunites two
forks of one model — and it gives the ETF lane a peer-relative engine, which
removes most of the reason `seed-etf-cards.mjs` exists.

**Constraint:** the rank pass runs after all chunks complete, so it belongs
server-side (3.1's Option A) or in a second script pass. It cannot be computed
inside a 35-symbol chunk.

### 3.4 The remaining detector families

Port order by cost, into the single engine from 3.1:

1. **MA-cross (50/200) + Bollinger** — close-only; MA-cross carries the `+0.5`
   category bonus so it moves scores most. Unblocked by Phase 2's 365-day
   lookback.
2. **Stochastic, Ichimoku** — high/low/close, already in the frame.
3. **OBV/CMF, volume, volume divergence** — **blocked on the vendor plan, not
   on code.** On Alpaca Basic the feed is IEX-only, so volume is a low
   single-digit share of consolidated. Port the code, keep these behind a flag
   until the account is on a consolidated feed. A volume signal built from ~2%
   of the tape is worse than none, because it looks authoritative.

### 3.5 Grounding-only enrichment

`indicators/divergence.py` (`days_since_cross`, MACD histogram direction and
acceleration, RSI swing divergence) and `indicators/pivots.py`
(support/resistance, `get_nearest_levels`) do not change the ranking — they make
a card *explainable*. Cheap, close/high/low only, and they slot into `numerics`
without touching `state_key` or `CARD_SCORE_VERSION`.

**Coordinate with signals-app P3 #9a**, which plans a `SUPPORT_RESISTANCE`
detector reusing the same `pivots.py` (`SR_PROXIMITIES` in
`indicators/grids.py:83` exists and is unused until it lands). Same module,
two consumers — build it once, in signals-app, and port the output shape.

### 3.6 Deferred: multi-timeframe composite

`scoring/mtf.py` weights 1D/5D/1M/3M/6M at `0.10/0.15/0.25/0.30/0.20`.
signals-app fetches each timeframe separately; the portal can **resample the
365-day daily frame** for the longer legs at zero vendor cost. Real work — it
multiplies the detector pipeline by five. Revisit once 3.1–3.4 are stable.

### Exit gate

- [ ] Exactly one confluence implementation, or a fixture test pinning JS to
      Python at `1e-9`
- [ ] `dataQuality` reflects bar count, NaN ratio and staleness, with `reasons`
      stored
- [ ] Universe and sector rank computed and stored for every carded symbol
- [ ] Detector families 1–2 live in the single engine; volume family flagged off
      with the reason recorded
- [ ] CI fails if the two hosts disagree on the confluence contract version or
      the shared constants

---

## Dependency graph

```
Phase 1  secrets ──> smoke test ──> alerting ──> freshness check
                                                      │
Phase 2  pagination ─────────────────────────────────┘
              └──> constants (365d / chunk 35 / feed / adjustment)
                        ├──> symbology fix ──┐
                        └──> crypto guard ───┴──> re-seed ──> full run @ 950
                                                                   │
Phase 3  one confluence impl ─────────────────────────────────────┘
              ├──> dataQuality          (independent; can start in parallel)
              ├──> MA-cross + Bollinger (needs 365d from Phase 2)
              ├──> Stochastic, Ichimoku
              ├──> relative strength + sector rank  (needs full-universe run)
              ├──> divergence / pivots  (grounding only)
              └──> MTF composite        (deferred)

              [volume family — blocked on vendor plan, not on any phase]
```

---

## What each phase does *not* include

Stated so scope stays honest:

- **Phase 1 does not fix any math.** A green run computing drifted confluence is
  still the right first step, because a drifted number you can see beats a
  correct number you never compute.
- **Phase 2 does not improve signal quality.** It makes coverage correct and
  complete. The cards it produces are the same pre-port cards, just for ~950
  symbols instead of 933 and on 365 days of history instead of 120.
- **Phase 3 does not touch the vendor plan.** The IEX-feed limitation gates the
  volume detectors and degrades ADX; upgrading to a consolidated feed is a
  separate, purchasable decision that should be priced against what those
  detectors are worth.

---

## Related

- [docs/signal-engine-parity-across-hosts.md](signal-engine-parity-across-hosts.md)
  — the evidence behind every claim here
- [docs/manual-setup-todo.md](manual-setup-todo.md) — the human/dashboard subset
- `~/code/signals-app/docs/TODO.md` — the other half of Phase 1 and the upstream
  of Phase 3's ports
- [docs/modal-deployment-and-local-triggering.md](modal-deployment-and-local-triggering.md)
  — deploy state
- [docs/running-universe-hydration-locally.md](running-universe-hydration-locally.md)
  — the pure-Node path
