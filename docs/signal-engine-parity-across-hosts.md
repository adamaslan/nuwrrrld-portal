# Signal-Engine Parity: Modal vs. GitHub Actions vs. GCP

**Written 2026-09-03. Re-verified 2026-09-03** against the code on
`feat/local-signal-report`, against the live Neon database, against the GitHub
Actions run history, and against Alpaca's published API limits.

Files verified: `deploy/universe-hydration/modal_app.py`,
`scripts/lib/hydrate-indicators.mjs`, `scripts/hydrate-local.mjs`,
`scripts/seed-signals-universe.mjs`, `scripts/prune-universe.mjs`,
`.github/workflows/hydrate-universe.yml`,
`app/api/pipeline/hydrate-universe/route.ts`, `lib/shared/card-policy.ts`,
`lib/ticker-cards-db.ts`, `lib/grounding/taxonomy.ts`.

---

## 0. Verification result — read this first

The confluence-drift analysis in §2 **holds up**; every claim in it was
re-checked against the source and is accurate. But the audit buried its lede,
and re-verification turned up three things it missed. In order of severity:

### 0.1 🔴 The nightly hydration has been dead for 15 days

`ticker_cards` holds 1,864 rows, all `source = hydrate-local`, and the newest
`bar_date` is **2026-08-19**. Today is 2026-09-03.

Every scheduled run since then has failed, in ~25 seconds, before touching
Alpaca:

```
$ gh run list --workflow=hydrate-universe.yml --limit 12
completed  failure  Nightly universe hydration  schedule  2026-09-03T00:30:33Z  27s
completed  failure  Nightly universe hydration  schedule  2026-09-02T00:24:45Z  30s
completed  failure  Nightly universe hydration  schedule  2026-09-01T01:21:04Z  24s
… 11 consecutive failures, unbroken back to 2026-08-19 …

$ gh run view 33699802622 --log-failed
##[error]PORTAL_PUSH_SECRET is not set — the portal will reject every POST.
##[error]Process completed with exit code 1.
```

Cause, confirmed by `gh secret list`: **`PORTAL_PUSH_SECRET`, `ALPACA_API_KEY`,
and `ALPACA_API_SECRET` do not exist as repository secrets.** Seventeen other
secrets do. These three are simply absent.

The workflow's own guard behaved perfectly — it named the missing secret and
failed red rather than writing zero cards and reporting green. The design is
right. What is missing is anything that *tells a human* the red exists. Eleven
consecutive red nightly runs produced no notification, and the staleness was
discovered only because this audit queried `max(bar_date)`.

**This dominates everything else in this document.** A confluence model that
disagrees between two hosts is a correctness problem in cards that are being
written. No cards are being written.

Fix (do not run these blind — see `scripts/sync-hydration-secrets.sh` and the
`secrets-sync` skill, which pipe values from file to CLI without routing them
through a chat session):

```bash
scripts/sync-hydration-secrets.sh    # pushes the three from .env.local
gh workflow run hydrate-universe.yml -f limit=25   # smoke test before the full run
```

Also worth correcting while you are in there: the workflow reads
`vars.PORTAL_URL`, but `PORTAL_URL` is registered as a **secret**, not a
variable. The lookup misses and silently falls through to the hardcoded
`https://financial.nuwrrrld.com`. That default happens to be correct, so
nothing is broken — but the `vars.` reference is dead code that reads as
configurable and is not.

### 0.2 🟠 `hydrate-local.mjs` does not paginate; Modal does

`_fetch_bars()` in `modal_app.py:548` loops on `next_page_token`.
`fetchBarsOnce()` in `hydrate-local.mjs:113` sets `limit=10000` and reads
`data.bars` once. There is no pagination.

Alpaca caps a bars response at **10,000 bars**, and — per the endpoint
reference — paginates **sorted by symbol first, then timestamp**. So an
over-cap request does not truncate each symbol's tail; it returns the first
symbols complete and **omits the trailing symbols entirely**.

At today's settings this never fires: `CHUNK_SIZE = 10` × ~83 bars from a
120-day lookback = ~830 bars, 8% of the cap. It is a **latent** bug, and it is
armed by exactly the changes §5 and §7 recommend — raising the lookback to 365
days and raising the chunk size. At 365 days (~252 bars/symbol) the cap is hit
at **40 symbols per request**. Raise `CHUNK_SIZE` past 39 without adding
pagination and symbols silently stop being carded.

Partial mitigation, worth knowing: dropped symbols surface as
`insufficient history` per-row errors and land in the `calc-errors` counter, so
the loss is *visible* in the log. It is not visible in the pass/fail gate,
which only fails on `written == 0`.

### 0.3 🟠 The vendor feed is unpinned, and it is not the feed you think

Neither host sends a `feed` parameter. Alpaca then resolves it from the
account's plan: **`iex` on Basic, `sip` on Algo Trader Plus.** On the Basic
plan every bar in this pipeline is built from IEX prints alone — a low
single-digit share of consolidated volume.

That matters unevenly across the indicators:

| Indicator | Sensitivity to an IEX-only bar |
|---|---|
| RSI, MACD | **Low** — close-only, and IEX closes track consolidated closely |
| ADX | **Moderate** — reads `high`/`low`, which on thin venue data are narrower and noisier |
| `volatilityPercentile` | **Moderate** — derived from closes, but the percentile is over a distribution that inherits the noise |
| OBV/CMF, volume detectors (§6) | **Severe** — IEX volume is not a proxy for consolidated volume |

The parity risk is the second-order one: `feed` is **account state, not code
state**. Upgrade the Alpaca plan and every indicator in the pipeline changes
value with no commit, no version bump, and no test failure. Pin it explicitly
(`feed=iex` today) so the change becomes a diff.

This also constrains §6: **do not port the volume-based detectors while on the
Basic plan.** They would be computed from ~2% of the tape and would look
authoritative in a card.

### 0.4 🟡 Corrections to the original audit

- The claim that GHA is "the live scheduler" is true of the **cron
  definition** and false of **observed behavior** — see §0.1. Everywhere the
  document says GHA "runs nightly," read "is scheduled to."
- `docs/running-universe-hydration-locally.md` reports the universe as 933
  active. Confirmed exactly: **762 stock + 171 ETF = 933**, with 50 rows
  deactivated (43 stock, 7 ETF).
- "100% of stored cards are `source = hydrate-local`" — confirmed, and now
  stronger than the doc implies: it is 100% of 1,864 rows, and Modal has
  written zero rows ever.

Everything in §1–§4 below is otherwise re-verified as written.

---

## 1. The three engines at a glance

| | **Modal** `universe-hydration` | **GitHub Actions** `hydrate-universe.yml` | **GCP** `gcp3` / Cloud Run |
|---|---|---|---|
| File | `deploy/universe-hydration/modal_app.py` | `scripts/hydrate-local.mjs` → `scripts/lib/hydrate-indicators.mjs` | external service + `scripts/seed-etf-cards.mjs` mapper |
| Language | Python (pandas/numpy) | JavaScript (hand-ported math) | Python service; JS mapper here |
| Universe | stocks (`universe: "stock"`) | **both lanes** — stock *and* etf | 54 industry ETFs only |
| `ticker_cards.source` | `modal-eod` | `hydrate-local` | `gcp3` |
| Confluence model | 7 detectors, strength-weighted, gated | RSI + MACD ternary vote | 52-wk range + rel-strength + multi-period return |
| Raw indicators | RSI, MACD, ADX, vol% | RSI, MACD, ADX, vol% (pinned to Modal) | none — omitted honestly |
| Lookback | 365 calendar days | 120 calendar days | upstream cache |
| Min bars to score | `< 30` → error | `< 40` (`MIN_BARS`) → error | n/a |
| Chunk size | 200 | 10 | 1 GET, all 54 |
| Pagination | **yes** (`next_page_token`) | **no** (§0.2) | n/a |
| Vendor `feed` | unset → plan default | unset → plan default | n/a |
| Deployed / scheduled? | **No** (source only) | Scheduled `30 22 * * 1-5` — **failing since 2026-08-19** | Yes — refreshes `00:30 UTC` |
| Failure mode | loud (Modal exception) | loud (red job) — **but unmonitored** | **silent** — `200 {"error":"not found"}` |

**What actually runs on a schedule today: nothing.** The GHA job is scheduled
and red. Modal `universe-hydration` has never been deployed (see
`docs/modal-deployment-and-local-triggering.md` §1). `seed-etf-cards.mjs` is
manual-only — there is no ETF workflow.

---

## 2. Where Modal and GHA diverge

Both write into `ticker_cards` and are meant to be interchangeable. The header
of `scripts/lib/hydrate-indicators.mjs` says so outright:

> *"The Modal job is the authoritative implementation. Rows produced here and
> rows produced there land in the same table and are compared directly, so
> these functions must stay numerically identical to their Python
> counterparts."*

### 2.1 Raw indicators — **in parity** ✅

`rsi()`, `macdCross()`, `adx()`, `volatilityPercentile()` in
`scripts/lib/hydrate-indicators.mjs` are pinned to the Python output by
`__tests__/hydrate-indicators.test.ts` against
`__tests__/fixtures/hydrate-indicator-parity.json`, tolerance `1e-9`. That test
runs in CI (`npm test` → `vitest run --project unit`). This half is solid and
should stay that way.

**Caveat — same math, different windows.** The functions are identical but the
*inputs* are not: Modal pulls 365 days, GHA pulls 120
(`hydrate-local.mjs:104`). For RSI(14)/ADX(14) with `adjust=False` EWM the
early-bar influence has decayed to nothing by 120 bars, so those match in
practice. **`volatilityPercentile` does not** — it is a percentile of the
*entire* realized-vol history, so 120 days and 365 days are genuinely
different distributions and can land in different `bucketVol` buckets
(`low ≤ 33 < normal < 67 ≤ high`, `taxonomy.ts`). And Modal's MA-50/200 cross
detector needs ≥ 200 bars — unreachable at a 120-day lookback even if the JS
side had that detector.

### 2.2 Confluence — **drifted, and not pinned** ❌

`__tests__/hydrate-indicators.test.ts` tests `confluence` only for internal
properties (determinism, null handling, "split scores below agree", "trending
above ranging"). **It never compares `confluence` output to Python
`_confluence`.** The drift is invisible to CI.

| Aspect | Modal `_confluence` (`modal_app.py:434`) | JS `confluence` (`hydrate-indicators.mjs:168`) |
|---|---|---|
| Signature | `(rsi, macd_cross, adx, vol_pct, frame=None)` | `(rsiVal, macdVal, adxVal)` — 3 args, no `frame`, no `vol` |
| Detectors | RSI, MACD, **volatility**, **MA-cross**, **Bollinger**, **Stochastic**, **OBV/CMF** | RSI, MACD only |
| Vote values | strength-weighted `-3..+3` + per-category conviction bonus (`MA_CROSS`/`MACD`/`VOLUME` +0.5, `OBV_CMF` +0.3) | ternary `-1 / 0 / +1`, no bonus |
| RSI tiers | ≤20 extreme, ≤30 strong, ≥70 strong, ≥80 extreme | ≤30 → +1, ≥70 → −1 (no extreme tier) |
| Normalization | `(bull − bear) / max_weight`; every neutral vote adds `0.1` to `max_weight` (dilutes) | `abs(net) / votes.length` |
| ADX amplification | `raw × 1.25`, clamped to `[-1, 1]`, when `adx ≥ 25` | `agreement × 1.25`, clamped to `[0, 1]`, when `adx ≥ 25` |
| Direction rule | **gated**: `bullish` needs `raw ≥ 0.35` **and** `≥ 3` agreeing bull votes; else `neutral` | any lean: `net > 0 → bullish`, `net < 0 → bearish` |
| Score sign | **signed** `−100..+100` (`round(raw*100, 1)`) | **unsigned magnitude** `0..100` |
| "nothing computable" | `(None, None)` | `{score: null, direction: null}` |

Same tape, worked example: RSI 59.9, a bullish MACD cross, ADX 16.7 (NVDA in a
local run on 2026-09-03).

- **JS:** votes `[0, +1]`, `net = 1`, `agreement = 1/2 = 0.5`, ADX < 25 so no
  amp → `score = 50.0`, `direction = "bullish"` (any lean qualifies).
- **Modal:** `RSI NEUTRAL` (0) + `MACD STRONG_BULLISH` (2.0 + 0.5 bonus) → one
  bull vote, `bull_count = 1`. `raw = 2.5 / 2.5 = 1.0`, but the gate needs
  `bull_count ≥ 3`, so `direction = "neutral"`. `score = 100.0`.

→ **`direction` disagrees (`bullish` vs `neutral`) and the magnitude disagrees
(`50` vs `100`) for the identical bar.**

### 2.3 Other constants that differ

| | Modal | JS / GHA |
|---|---|---|
| `LOOKBACK_DAYS` | `365` (`modal_app.py:66`) | `120` (`hydrate-local.mjs:104`) |
| min bars before "insufficient history" | `len(frame) < 30` (`modal_app.py:586`) | `barData.length < 40` (`hydrate-indicators.mjs` `MIN_BARS`) |
| `CHUNK_SIZE` | `200` | `10` |
| pagination | `next_page_token` loop | **none** (§0.2) |
| `adjustment` param to Alpaca | `split` | *(none — raw prices)* ← also a real divergence |
| `feed` param to Alpaca | *(none — plan default)* | *(none — plan default)* (§0.3) |
| coverage floor | `MIN_COVERAGE_RATIO = 0.95`, run fails below it | none — GHA only fails on `written == 0` |

`hydrate-local.mjs`'s Alpaca call omits `adjustment=split` (compare
`modal_app.py:558`). A stock that split inside the 120-day window gets a price
discontinuity the Modal series wouldn't have — which moves every indicator for
that name.

Note also that Modal's `CHUNK_SIZE = 200` at a 365-day lookback is ~50,000 bars
per chunk — five pages. Modal handles that correctly *only because* it
paginates. The same number in the JS script would drop four-fifths of every
chunk.

---

## 3. What the portal neutralizes — and what it doesn't

`POST /api/pipeline/hydrate-universe` does **not** store the posted
`confluenceScore` as the card score. It rebuilds every card from discretized
tokens (`route.ts:220` → `buildCard` → `scoreCard`, `card-policy.ts`).

**Absorbed by re-scoring:**

- The **sign** of the posted `confluenceScore`. `bucketConfluence()` takes
  `Math.abs(score)` (`taxonomy.ts`), and `scoreCard()` derives the sign from
  `parts.direction`, not from the score. So Modal's signed `−80` and a
  hypothetical JS `+80` bucket identically. **This is why signed-vs-unsigned in
  §2.2 is not, by itself, a stored-data bug** — as long as `direction` is right.
- Exact decimals. A float that drifts *inside* its bucket cannot move the card.

**NOT absorbed — flows straight into the stored card:**

1. **`direction`** — passed through verbatim (`route.ts:224`,
   `isDirection(row.direction) ? row.direction : null`) and becomes
   `parts.direction`, which is the **sign** of the entire directional core in
   `scoreCard()`:
   `sign × {weak:10, moderate:30, strong:50}[confluence]`. Modal's gated
   `neutral` vs JS's `bullish` for the same bar → `sign` flips `0 → 1` →
   different `score`, and potentially `HOLD` vs `BUY` (`actionFromScore`:
   `≥ 35 BUY`, `≤ −35 SELL`).
2. **`confluenceScore` magnitude** → `bucketConfluence()` →
   `weak (<34) / moderate (34–66) / strong (≥67)` → weight `10 / 30 / 50`.
   Modal's `100` vs JS's `50` for the NVDA bar → `strong` vs `moderate` → a
   20-point swing in the directional core before the ADX/vol multipliers.
3. **`volatilityPercentile`** (from the §2.1 lookback gap) → `bucketVol` →
   `× 0.85` conviction damp in `scoreCard()` when `high`.
4. **`state_key`** — `rsi:…|macd:…|adx:…|vol:…|confluence:…|dir:…|h:…`. Two of
   its seven dimensions (`confluence`, `dir`) come from the drifted engine, so
   **the same ticker on the same day gets a different `state_key` depending on
   which host hydrated it** — which means it also gets a different grounding
   pack and a different cohort bucket.

**Net:** `ticker_cards.score`, `.action`, `.state_key`, and `.numerics` for a
given symbol/day depend on whether `source = "modal-eod"` or
`"hydrate-local"`. In practice every stored card is `hydrate-local`, so you are
running the **pre-port** engine on the whole universe, and the Modal port's
detector families (Bollinger, Stochastic, OBV/CMF, MA-cross) have never reached
a stored card.

---

## 4. The GCP ETF overlap

The two universes are supposed to be disjoint — "gcp3 owns ETF rows, this job
owns stock rows" (`modal_app.py:19`). They are not, because the GHA job runs
both lanes. `hydrate-local.mjs` with no `--universe` walks `stock` then `etf`
(`hydrate-local.mjs:286`), and the workflow's default input is `all`.

So an ETF like `XLK` can be carded two ways:

| Path | Fields present | `dataQuality` | Engine |
|---|---|---|---|
| GHA `etf` lane | rsi, macd, adx, vol, confluence (5/5) | **1.0** | JS indicator confluence |
| `seed-etf-cards.mjs` from gcp3 | confluenceScore, direction (2/5) | **0.4** | gcp3 return/rank engine |

`shouldReplaceCard()` (`card-policy.ts:199`): same bar date → **higher
`dataQuality` wins**. The GHA ETF card (1.0) always beats the gcp3 ETF card
(0.4). **gcp3's ETF engine — the one that is actually tuned for ETFs — never
lands** whenever the GHA job has run that day.

The root cause is worth naming precisely, because §6.1 fixes it: `dataQuality`
is **not a quality measure**. `card-policy.ts:90` defines it as

```ts
(CARD_INPUT_FIELDS.length - missingInputFields(input).length) / CARD_INPUT_FIELDS.length
```

— pure field *completeness*, 0–1 in fifths. It says nothing about whether the
bars were stale, whether the series had holes, or whether there were enough of
them. So "five fields computed from a truncated 40-bar window" outranks "two
fields computed from a purpose-built ETF model," and a tie-break that reads
like a quality judgment is really just a field count.

---

## 5. Making it robust — ranked

Renumbered from the original audit; **R0 is new and precedes everything.**

### R0. Make the pipeline's silence audible

Nothing else on this list matters while §0.1 can happen again. Three changes,
cheapest first:

1. **Restore the three missing secrets** and re-run
   (`scripts/sync-hydration-secrets.sh`, then a `-f limit=25` smoke test).
2. **Alert on the red run, not just the red run's existence.** A
   `if: failure()` step that posts to whatever channel you actually read is the
   whole fix. Eleven silent failures is a monitoring gap, not a workflow gap.
3. **Add a freshness check that fails independently of the writer.** The
   failure mode in §0.1 is that the *writer* is broken, so no assertion inside
   the writer can catch it. A tiny scheduled job — or an assertion in the
   already-running `afternoon-pipeline.yml` — that queries
   `max(bar_date) FROM ticker_cards` and fails when it is more than ~3 trading
   days old would have caught this on day four. Staleness is the symptom that
   survives every possible cause.

### R1. One confluence implementation, imported, not re-typed

The parity bug exists because the math is hand-copied into two languages. Kill
the copy:

- **Option A (preferred): the portal owns confluence.** Compute confluence in
  `lib/shared/card-policy.ts` (it is pure and dependency-free by design) from
  the raw indicators the row already carries. Hosts post **only**
  `rsi / macdCross / adx / volatilityPercentile` (+ the detector inputs §6
  needs); the route computes `confluenceScore` and `direction`. Then there is
  exactly one confluence engine, in the language the score already lives in,
  covered by the tests that already exist.
  - Modal and `hydrate-local.mjs` both delete their confluence code.
  - `seed-etf-cards.mjs` keeps mapping gcp3's `ai_action` → `direction` (gcp3
    genuinely has no RSI/MACD), but stops sending a hand-scaled
    `confluenceScore` — it sends `confluence: "external"` provenance instead
    and lets the route bucket it.
- **Option B: a single vendored module.** Keep confluence host-side but ship
  *one* file — transpile `card-policy`'s confluence to a `.mjs` that
  `hydrate-local.mjs` imports and that Modal runs under `node` in a build step,
  or run the JS via `PyMiniRacer` in Modal. Uglier; only worth it if the
  frame-dependent detectors can't move server-side.

Note that Option A composes with §6: every detector family you port lands in
one place instead of two, so the port cost is paid once.

### R2. Pin `confluence` in the parity test

Until R1 lands, extend `__tests__/hydrate-indicators.test.ts` /
`hydrate-indicator-parity.json` to capture `_confluence(rsi, macd, adx, vol,
frame)` output for each fixture series and assert the JS `confluence` matches.
This test **fails today** — that is the point; it makes the drift visible and
blocks further divergence. Capture the Python reference the same way the
existing fixtures were captured (run `_confluence` directly over each series).

### R3. Align the constants (single source)

Put these in one shared module (`lib/shared/hydration-constants.ts`, re-exported
to `.mjs`; Modal reads them from a small committed JSON):

| Constant | Set to | Why |
|---|---|---|
| `LOOKBACK_DAYS` | **365** | Modal's value; the 50/200 MA detector needs ≥ 200 bars and vol-percentile needs a stable distribution |
| min bars | **one value** (30 or 40 — pick one) | currently 30 vs 40 |
| Alpaca `adjustment` | **`split`** everywhere | `hydrate-local.mjs` omits it → split discontinuities |
| Alpaca `feed` | **`iex`, explicitly** | today's plan default; pinning turns a plan upgrade into a diff (§0.3) |
| `MIN_COVERAGE_RATIO` | **0.95** in GHA too | GHA currently only fails on total zero |
| `CHUNK_SIZE` | **35** in both, once paginated (§7) | at 365 days this is the largest chunk that fits one page |

**Ordering matters here:** `LOOKBACK_DAYS = 365` must not ship before
pagination (R6), or `CHUNK_SIZE` must drop below 40 in the same commit. Raising
the lookback alone triples the bars per request and moves the JS script from
8% of the cap to 25% — still safe at chunk 10, but it removes the margin that
currently hides §0.2.

### R4. Pick one host, tag the rest as fallback

- **Stocks + ETF indicator cards:** GitHub Actions is the intended live
  scheduler (`hydrate-universe.yml`, `30 22 * * 1-5`). Keep it — but "keep it"
  now means *fix R0 first*. Do **not** deploy Modal `universe-hydration` unless
  GHA's 6 h ceiling or fan-out need forces it — and if you do, disable the GHA
  `schedule:` block in the same commit.
- **gcp3:** serving layer for its 54-ETF return model *only*. Either
  (a) stop the GHA `etf` lane (`--universe=stock` in the workflow) and let
  `seed-etf-cards.mjs` own ETF rows on a schedule, or (b) accept that the
  indicator engine owns ETFs too and retire `seed-etf-cards.mjs`. Decide;
  don't let `dataQuality` decide. §6.1 makes the heuristic honest either way,
  but an honest heuristic is still not a decision.
- Every writer already sets a distinct `ticker_cards.source`
  (`modal-eod` / `hydrate-local` / `gcp3`). Keep that — it is the only way to
  tell after the fact which engine wrote a row.

### R5. A CI guard against silent re-divergence

- Add `__tests__/hydration-constants.test.ts` asserting the Python JSON and the
  TS module agree (parse both, deep-equal).
- Add a check that greps `modal_app.py` and `hydrate-indicators.mjs` for a
  `CONFLUENCE_CONTRACT_VERSION` string and fails if they differ — bump it
  deliberately when the model changes, the same pattern as `CARD_SCORE_VERSION`
  / `TAXONOMY_VERSION`.
- Run `__tests__/hydrate-indicators.test.ts` (already in `--project unit`) as a
  **required** check on any PR touching `deploy/**` or `scripts/lib/**`.

### R6. Paginate the JS fetch — before raising anything

Port Modal's `next_page_token` loop into `fetchBarsOnce`, and assert the
invariant explicitly rather than trusting the caller:

```js
// Alpaca caps a response at 10,000 bars and paginates sorted by symbol, then
// timestamp — an over-cap request returns the first symbols complete and drops
// the trailing ones entirely. Merge pages before returning, and refuse a chunk
// size that could need more pages than a sane loop should run.
const MAX_BARS_PER_PAGE = 10_000;
```

Then add a `[hydrate]` log line per chunk reporting pages fetched and
`symbolsReturned / symbolsRequested`. A chunk that comes back short is the
observable form of every vendor problem in this document, and it currently has
no log line of its own.

### R7. Handle 429 explicitly

Neither host has any `429` / `Retry-After` handling. Today's request volume is
so far under the limit (§7) that this has never fired — but the drop-and-retry
loop in `fetchBars` treats *any* non-`invalid symbol` error as fatal to the
chunk, so a single 429 costs a whole chunk with no retry. Add bounded
exponential backoff honoring `Retry-After` (cap ~3 attempts). This is cheap
insurance, not a current bug.

---

## 6. Universe features to port from signals-app

`~/code/signals-app` is where the 950-ticker CSV comes from, and it carries a
substantially richer per-symbol model than either host here. Modal already
ported four of its detector families; the JS engine has none of them. Ranked by
value per unit of work — and note that **every item below needs zero additional
vendor requests**: they all read the OHLCV frame the fetch already returns.

### 6.1 Real `dataQuality` — highest value, smallest diff

`signals-app/src/signals_app/indicators/data_quality.py` scores an OHLCV window
0.0–1.0 with additive, independent deductions for **bar count below the
period's minimum**, **NaN ratio above threshold**, and **a stale last bar**, and
returns human-readable `reasons` alongside the score.

Port it into `lib/shared/card-policy.ts` as a factor on the existing
completeness ratio:

```ts
dataQuality = completeness(input) × barQuality(frameStats)
```

where `frameStats` (`barCount`, `nanRatio`, `lastBarAge`) rides along in the
POST body. This is the single highest-leverage item on the list because
`dataQuality` is already load-bearing — it is the `shouldReplaceCard` tie-break
(§4) — and it currently measures the wrong thing. Making it honest fixes the
GHA-vs-gcp3 ETF accident *as a side effect*, and it gives §0.1 a second line of
defense: a stale-bar deduction makes a 15-day-old card visibly worse than a
fresh one instead of exactly as good.

Carry `reasons` through to the card too. "Why is this card low quality" is
currently unanswerable from stored data.

### 6.2 Relative strength / universe rank — the actual "universe feature"

`scoring/relative_strength.py` is the only thing in either codebase that scores
a symbol **against its peers** rather than against its own history:
multi-period returns, 52-week range position, momentum/trend/pullback signals,
and `rank_in_universe` / `universe_size`.

Everything the portal computes today is *intra*-symbol. At 950 symbols scanned
nightly you already have exactly the cross-section this needs, and you are
throwing it away. Concretely, one pass over the closes you already fetched
yields per symbol:

- returns at 1M / 3M / 6M / 12M,
- percentile rank of each within the universe,
- percentile rank **within `sector_group`** — the CSV carries a
  `sector_group` column (`"Technology → Semiconductors"`, 130+ groups) that
  `seed-signals-universe.mjs` currently parses and discards,
- 52-week range position.

It also composes with the existing taxonomy: `bucketRank(pctile)` →
`leader / middle / laggard` is a natural eighth `state_key` dimension, and
sector-relative rank is what makes a card say "strong, and strong *for a
semiconductor*" instead of just "strong."

Note the shared lineage: `relative_strength.py` is adapted from
`gcp3/backend/technical_signals.py`, and uses the *same* `±0.35` threshold and
`≥3` agreeing-signal gate as Modal's `_confluence`. Porting it is partly a
matter of reuniting two forks of one model — and it gives the ETF lane a
peer-relative engine, which removes most of the reason `seed-etf-cards.mjs`
exists (§4).

**Requires:** the rank pass must run after all chunks complete, so it belongs
server-side (R1 Option A) or in a second pass in the script. It cannot be
computed inside a 35-symbol chunk.

### 6.3 The remaining detector families

Modal has MA-cross, Bollinger, Stochastic, OBV/CMF. signals-app has those plus
Ichimoku, expanded MA-cross, multi-RSI, multi-MACD, volume, and volume
divergence (`detection/{trend,momentum,volume}.py`). The JS engine has none.

Port order, by cost:

1. **MA-cross (50/200) and Bollinger** — close-only, and MA-cross carries the
   `+0.5` category bonus so it moves scores most. **Blocked on
   `LOOKBACK_DAYS = 365`** (R3): 50/200 needs ≥200 bars, unreachable at 120.
2. **Stochastic** — needs `high`/`low`, both already in the frame.
3. **Ichimoku** — close/high/low, no new inputs.
4. **OBV/CMF, volume, volume divergence** — **blocked on §0.3.** These read
   `volume`, which on the Basic plan is IEX-only. `rowFor()` does not even
   extract `b.v` today. Port the code, but keep these detectors disabled behind
   a flag until the account is on a consolidated feed; a volume signal built
   from ~2% of the tape is worse than no volume signal, because it looks
   authoritative.

### 6.4 Richer state, not just richer scores

`indicators/divergence.py` computes things the grounding pack would use
directly and the score need not consume: `days_since_cross`, MACD histogram
direction and acceleration, RSI swing-based divergence.
`indicators/pivots.py` computes support/resistance levels and
`get_nearest_levels()`.

These do not change the ranking; they make a card *explainable* — "MACD crossed
bullish 3 days ago and the histogram is decelerating; price is 1.2% under the
first pivot" is a grounding fact, not a score. Cheap (close/high/low only), and
they slot into `numerics` without touching `state_key` or `CARD_SCORE_VERSION`.

### 6.5 Multi-timeframe composite — later

`scoring/mtf.py` weights 1D/5D/1M/3M/6M at `0.10/0.15/0.25/0.30/0.20`.
signals-app fetches each timeframe separately; here you can **resample the
365-day daily frame** to weekly/monthly for the longer legs at zero vendor
cost. Real work — it multiplies the detector pipeline by five — so treat it as
a follow-on once 6.1–6.3 are stable.

### Port sequence

```
R0 (secrets + alerting)
  └─> 6.1 dataQuality          ← unblocks the §4 tie-break, no other deps
  └─> R6 pagination
        └─> R3 LOOKBACK_DAYS=365, CHUNK_SIZE=35, feed=iex, adjustment=split
              └─> 6.3.1 MA-cross + Bollinger   (needs ≥200 bars)
              └─> 6.3.2 Stochastic, Ichimoku
              └─> 6.2 relative strength + sector rank
                    └─> 6.4 divergence / pivots  (grounding only)
                          └─> 6.5 MTF composite
        [6.3.4 volume family — blocked on a consolidated feed, not on code]
R1 (one confluence impl) should land before or alongside 6.3 —
   otherwise every detector is ported twice, which is the bug in §2.2.
```

---

## 7. Scanning 950 tickers within the rate limits

**The headline: rate limits are not the constraint.** At 950 symbols the job
needs ~28 Alpaca requests against a 200-requests-per-minute budget. The real
constraints are pagination correctness (§0.2), feed quality (§0.3), and the job
running at all (§0.1).

### 7.1 Where 950 comes from — and why it is a ceiling, not a target

`~/code/signals-app/seed/universe_symbols.csv` has 954 data rows:

| `asset_type` | rows | `scopeFor()` → | outcome |
|---|---|---|---|
| Equity | 776 | `stock` | seeded |
| ETF | 173 | `etf` | seeded |
| Fund | 1 | `etf` | seeded |
| Crypto | 4 | `null` | **skipped** — 24/7 sessions break the trading-day math |
| | **954** | | **950 seedable** |

So **950 is exactly `seed-signals-universe.mjs`'s output.** The database today
holds 983 rows, 933 of them active:

```
stock  active=true   762      stock  active=false   43
etf    active=true   171      etf    active=false    7
```

The 50 inactive rows were deactivated by `prune-universe.mjs` on vendor
evidence (`stale` / `never` / `reject`). That script is right to have done so —
a symbol Alpaca will not serve costs a chunk slot and a log line every night
forever.

**Therefore: 950 attempted and 950 carded are different numbers, and the plan
must not conflate them.** Roughly:

- ~950 **registered and attempted**,
- ~17 recoverable from the inactive set (below),
- some genuinely gone — `TWTR` (delisted 2022), `PXD`, `SRNE` and similar
  corporate actions will never card again and should stay inactive.

### 7.2 Closing the 933 → 950 gap

Three distinct causes in the inactive list, and only the first two are worth
acting on:

**(a) Share-class notation — a real bug, ~3 symbols.** The CSV writes
`BRK-B`, `BF-B`, `SCHW-PD`. Alpaca uses a **dot** for class shares: `BRK.B`,
`BF.B`. These are not delisted — Berkshire Hathaway B and Brown-Forman B are
among the most liquid names on the tape. `TICKER_RE`
(`/^[A-Z][A-Z.\-]{0,9}$/`) accepts both spellings, so the hyphenated form
sailed through the seeder and then 400'd at the vendor, and `prune-universe`
correctly classified it `reject` on the evidence it had.

Fix: normalize `-` → `.` for class-share suffixes at seed time
(`BRK-B` → `BRK.B`), reactivate, and let the next run prove it. Verify the
preferred-share form (`SCHW-PD`) against Alpaca's symbology separately — that
one is genuinely a different notation, not just a separator swap.

**(b) Crypto leaked into the ETF lane — 4 symbols.** `BTC-USD`, `ETH-USD`,
`DOGE-USD`, `SOL-USD` are registered as `universe='etf'`. `scopeFor()` maps
`Crypto → null`, so **these did not come from `seed-signals-universe.mjs`** —
another seeder registered them, or they predate the current CSV. They are the
exact symbols behind the whole-chunk-400 incident documented in
`fetchBars`'s header comment ("a 178-symbol ETF run lost 40 rows to 4 bad
tickers").

They are correctly inactive. The fix is upstream: make registration reject a
crypto-shaped ticker regardless of which seeder submits it, so they cannot be
re-added. They do not count toward 950 and should not.

**(c) Genuine corporate actions — the rest.** Delistings, acquisitions,
bankruptcies. Leave inactive. Re-audit with `prune-universe.mjs --dry-run`
quarterly; its `retry` class exists precisely to catch symbols that were
deactivated by a *pipeline* bug rather than a *vendor* fact, and after fixing
(a) some of these may reclassify.

Do **not** pad the universe back to a round 950 with new tickers to hit the
number. The number that matters is the coverage ratio against a universe of
symbols the vendor demonstrably serves.

### 7.3 The rate-limit math

Verified against Alpaca's published limits (`docs.alpaca.markets`, fetched
2026-09-03):

| Limit | Basic (free) | Algo Trader Plus |
|---|---|---|
| Requests / minute | **200** | 10,000 |
| Feed | **IEX only** | all US exchanges (SIP) |
| Real-time restriction | last 15 minutes withheld | none |
| Bars per response | **10,000** | 10,000 |
| Symbols per request | not documented as capped | — |

At `LOOKBACK_DAYS = 365`, a symbol has ~252 daily bars.

```
bars per symbol            ≈ 252
symbols that fit one page  = floor(10,000 / 252) = 39
chosen CHUNK_SIZE          = 35            (margin for low-bar symbols and holiday drift)
requests for 950 symbols   = ceil(950 / 35) = 28
budget                     = 200 / min
utilization                = 28 / 200 = 14% of a single minute's budget
```

Even the current `CHUNK_SIZE = 10` — 95 requests — sits under half the
per-minute budget. **You could scan 950 tickers today without touching the rate
limit at all.** What you cannot do today is scan them with a chunk size large
enough to matter, because of §0.2.

The 15-minute real-time restriction is a non-issue: the cron fires 90–150
minutes after the close.

### 7.4 Recommended configuration

| Setting | Now | Target | Rationale |
|---|---|---|---|
| `CHUNK_SIZE` | 10 | **35** | largest chunk that fits one 10k-bar page at 365 days, with margin |
| `LOOKBACK_DAYS` | 120 | **365** | matches Modal; unblocks 50/200 MA (§6.3); stabilizes vol-percentile (§2.1) |
| pagination | none | **required** | §0.2 — must land *before* either row above |
| `feed` | unset | **`iex`** | pin the plan default so an upgrade is a diff (§0.3) |
| `adjustment` | unset | **`split`** | matches Modal; removes split discontinuities (§2.3) |
| concurrency | 1 | **3** | 28 requests → ~10 rounds; keeps the run inside a couple of minutes |
| pacing | none | **120 req/min ceiling** | 60% of budget, leaving headroom for other jobs on the same key |
| `429` handling | none | **backoff + `Retry-After`** | R7 |
| coverage floor | none | **0.95** | Modal's `MIN_COVERAGE_RATIO`; makes partial coverage red |

At chunk 35 with concurrency 3, the full 950-symbol walk is ~10 request rounds
plus compute — well inside the 45-minute job timeout, and a small enough
fraction of the budget that a manual `workflow_dispatch` racing the cron
(which `concurrency: hydrate-universe` already queues rather than drops) is
harmless.

**One caution on raising `CHUNK_SIZE`.** `fetchBars`'s drop-and-retry loop
re-issues the *entire* chunk for each `invalid symbol` 400. At chunk 10 a bad
symbol costs one extra small request; at chunk 200 (Modal's value) ten bad
symbols cost eleven 200-symbol requests. 35 keeps that bounded, and
`prune-universe.mjs` has already removed the reject class that triggers it.
Do not push chunk size toward Modal's 200 on the JS side without also
batching the drops — collect every symbol named across the retries and drop
them in one pass rather than one per round trip.

### 7.5 Sequence to get to 950 scanned

1. **R0** — restore the three secrets, add failure alerting, add the
   freshness assertion. *Nothing below is observable until this is done.*
2. Re-seed from the CSV: `node scripts/seed-signals-universe.mjs --dry-run`,
   confirm it reports 776 stock + 174 etf = 950, then run it for real.
3. Fix share-class notation (§7.2a), reactivate those rows.
4. Harden registration against crypto-shaped tickers (§7.2b).
5. **R6** — pagination, with the `symbolsReturned / symbolsRequested` log line.
6. **R3** — flip `LOOKBACK_DAYS` to 365, `CHUNK_SIZE` to 35, pin `feed` and
   `adjustment`, in one commit.
7. Smoke test: `gh workflow run hydrate-universe.yml -f limit=50`. Confirm
   pages-per-chunk is 1 and `symbolsReturned == symbolsRequested`.
8. Full run. Confirm `written` ≈ 2 × carded symbols (both horizons) and that
   `total` reports ~950.
9. `node scripts/prune-universe.mjs --dry-run` — anything still in `retry` is
   a pipeline bug, not a vendor fact. Chase it.
10. Only then start the §6 port sequence.

---

## 8. Acceptance checklist

Parity and coverage are "as robust as possible" when all of these hold:

- [ ] `PORTAL_PUSH_SECRET`, `ALPACA_API_KEY`, `ALPACA_API_SECRET` exist as repo
      secrets and the nightly run is green (R0).
- [ ] A failed hydration run notifies a human, and a freshness check fails when
      `max(bar_date)` is more than ~3 trading days old (R0).
- [ ] `hydrate-local.mjs` follows `next_page_token`, and logs pages fetched and
      symbols returned vs. requested per chunk (R6).
- [ ] `feed` and `adjustment` are explicit in both hosts, not plan defaults (R3).
- [ ] `confluence` has exactly one implementation, or a fixture test pins the
      JS output to the Python output at `1e-9` (R1 / R2).
- [ ] `LOOKBACK_DAYS`, min-bars, `CHUNK_SIZE`, `feed`, `adjustment` come from
      one shared source read by both Modal and `hydrate-local.mjs` (R3).
- [ ] A single documented decision records which host is live for stock cards
      and for ETF cards, and the non-live twin's schedule is disabled in code
      (R4).
- [ ] CI fails if `modal_app.py` and `hydrate-indicators.mjs` disagree on the
      confluence contract version or the shared constants (R5).
- [ ] `dataQuality` reflects bar count, NaN ratio and staleness — not just
      field completeness (§6.1).
- [ ] The universe reports ~950 registered, and the coverage ratio against
      *active* symbols is ≥ 0.95 (§7).
- [ ] `docs/modal-deployment-and-local-triggering.md` §7 and
      `docs/modal-vs-gcp-signal-coverage.md` are cross-linked to this doc and
      updated when R4 is decided.
- [ ] The `hydrate-indicators.mjs` header comment is corrected: it currently
      claims numerical identity that does not hold for `confluence`.

---

## Related

- `docs/modal-deployment-and-local-triggering.md` — deploy state, §7 overlap
- `docs/modal-vs-gcp-signal-coverage.md` — why gcp3 and Modal are not
  substitutes; the `200 {"error":…}` trap
- `docs/running-universe-hydration-locally.md` — the pure-Node path; the 933
  active-ticker count
- `scripts/local-signal-report.mjs` — local run of the JS engine only, emits
  `docs/local-signal-report.html`
- `scripts/prune-universe.mjs` — the vendor-evidence classifier behind the
  50 inactive rows
- `scripts/seed-signals-universe.mjs` — the 950-ticker seeder and its CSV
- `~/code/signals-app/src/signals_app/` — the detector, scoring and
  data-quality modules §6 ports from
- `__tests__/hydrate-indicators.test.ts` — the parity pin (indicators only)
- `lib/shared/card-policy.ts` / `lib/grounding/taxonomy.ts` — where the portal
  re-scores, and which posted fields it trusts
