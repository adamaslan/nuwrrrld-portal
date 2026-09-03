# Signal-Engine Parity: Modal vs. GitHub Actions vs. GCP

**Written 2026-09-03.** Verified against the code on `main` this date:
`deploy/universe-hydration/modal_app.py`, `scripts/lib/hydrate-indicators.mjs`,
`scripts/hydrate-local.mjs`, `.github/workflows/hydrate-universe.yml`,
`app/api/pipeline/hydrate-universe/route.ts`, `lib/shared/card-policy.ts`,
`lib/grounding/taxonomy.ts`, `scripts/seed-etf-cards.mjs`.

> **Short answer: no, they are not the same, and one pair is supposed to be.**
>
> - **Modal** and **GitHub Actions** are supposed to be byte-for-byte
>   equivalent — same table, `ticker_cards`, rows "compared directly" per the
>   header of `scripts/lib/hydrate-indicators.mjs`. The raw indicators
>   (RSI / MACD / ADX / vol) are pinned and equal. **`confluence` has drifted
>   and is not pinned:** Modal runs a 7-detector strength-weighted model with a
>   gated direction; the JS that GHA actually runs is the pre-port 2-indicator
>   vote. Different scale, different direction rule, different sign convention.
> - **GCP (gcp3)** is a *deliberately* different engine for a
>   *non-overlapping* universe (54 industry ETFs, return/rank-based, no
>   per-stock path). It is not meant to match — but the portal's replacement
>   rule currently lets the GHA ETF lane silently outrank it.
>
> The portal re-scores every card from discretized tokens, which absorbs
> *some* of the drift (it never trusts the posted score's sign). It does not
> absorb the parts that matter: the posted **`direction`** and the posted
> **`confluenceScore` magnitude** both flow straight into the stored score,
> action, and `state_key`.

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
| Deployed / scheduled? | **No** (source only) | **Yes** — `30 22 * * 1-5` | Yes — refreshes `00:30 UTC` |
| Failure mode | loud (Modal exception) | loud (red job, `[done]` gate) | **silent** — `200 {"error":"not found"}` |

**What actually runs on a schedule today:** only the GitHub Actions job. It
cards *both* stocks and ETFs with the JS pre-port engine. Modal
`universe-hydration` has never been deployed (see
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
| Vote values | strength-weighted `-3..+3` + per-category conviction bonus (`MA_CROSS`/`MACD` +0.5, `OBV_CMF` +0.3) | ternary `-1 / 0 / +1`, no bonus |
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
| `adjustment` param to Alpaca | `split` | *(none — raw prices)* ← also a real divergence |
| coverage floor | `MIN_COVERAGE_RATIO = 0.95`, run fails below it | none — GHA only fails on `written == 0` |

`hydrate-local.mjs`'s Alpaca call omits `adjustment=split` (compare
`modal_app.py:558`). A stock that split inside the 120-day window gets a price
discontinuity the Modal series wouldn't have — which moves every indicator for
that name.

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
`"hydrate-local"`. `docs/running-universe-hydration-locally.md` reports every
card in the table today is `source = hydrate-local` (100 %) — so in practice
you are running the **pre-port** engine on the whole universe, and the Modal
port's detector families (Bollinger, Stochastic, OBV/CMF, MA-cross) never reach
a stored card.

---

## 4. The GCP ETF overlap

The two universes are supposed to be disjoint — "gcp3 owns ETF rows, this job
owns stock rows" (`modal_app.py:19`). They are not, because **the scheduled
GHA job runs both lanes.** `hydrate-local.mjs` with no `--universe` walks
`stock` then `etf` (`hydrate-local.mjs:286`), and the workflow's default input
is `all` (`hydrate-universe.yml`).

So an ETF like `XLK` can be carded two ways:

| Path | Fields present | `dataQuality` | Engine |
|---|---|---|---|
| GHA `etf` lane | rsi, macd, adx, vol, confluence (5/5) | **1.0** | JS indicator confluence |
| `seed-etf-cards.mjs` from gcp3 | confluenceScore, direction (2/5) | **0.4** | gcp3 return/rank engine |

`shouldReplaceCard()` (`card-policy.ts`): same bar date → **higher
`dataQuality` wins**. The GHA ETF card (1.0) always beats the gcp3 ETF card
(0.4). **gcp3's ETF engine — the one that is actually tuned for ETFs — never
lands** whenever the GHA job has run that day. gcp3's `confluence_score` /
`ai_action` are, in practice, dead on arrival.

That may even be the preferable outcome (indicator parity across the whole
universe beats a bespoke ETF model on 54 symbols) — but right now it is an
*accident* of the quality heuristic, not a decision.

---

## 5. Making it robust — ranked

### R1. One confluence implementation, imported, not re-typed

The parity bug exists because the math is hand-copied into two languages. Kill
the copy:

- **Option A (preferred): the portal owns confluence.** Compute confluence in
  `lib/shared/card-policy.ts` (it is pure and dependency-free by design) from
  the raw indicators the row already carries. Hosts post **only**
  `rsi / macdCross / adx / volatilityPercentile` (+ the OHLCV frame digest the
  detector families need); the route computes `confluenceScore` and
  `direction`. Then there is exactly one confluence engine, in the language the
  score already lives in, covered by the tests that already exist.
  - Modal and `hydrate-local.mjs` both delete their confluence code.
  - `seed-etf-cards.mjs` keeps mapping gcp3's `ai_action` → `direction` (gcp3
    genuinely has no RSI/MACD), but stops sending a hand-scaled
    `confluenceScore` — it sends `confluence: "external"` provenance instead
    and lets the route bucket it.
- **Option B: a single vendored module.** Keep confluence host-side but ship
  *one* file — e.g. transpile `card-policy`'s confluence to a `.mjs` that
  `hydrate-local.mjs` imports and that Modal runs under `node` in a build
  step, or run the JS via `PyMiniRacer` in Modal. Uglier; only worth it if
  the frame-dependent detectors can't move server-side.

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
| `MIN_COVERAGE_RATIO` | **0.95** in GHA too | GHA currently only fails on total zero |
| `CHUNK_SIZE` | may stay different (200 Modal / 10 local) — batch size doesn't affect per-row math | — |

### R4. Pick one host, tag the rest as fallback

Per `docs/modal-deployment-and-local-triggering.md` §7 and
`docs/modal-vs-gcp-signal-coverage.md` Part 4:

- **Stocks + ETF indicator cards:** GitHub Actions is the live scheduler
  (`hydrate-universe.yml`, `30 22 * * 1-5`). Keep it. Do **not** deploy Modal
  `universe-hydration` unless GHA's 6 h ceiling or fan-out need forces it — and
  if you do, disable the GHA `schedule:` block in the same commit.
- **gcp3:** serving layer for its 54-ETF return model *only*. Either
  (a) stop the GHA `etf` lane (`--universe=stock` in the workflow) and let
  `seed-etf-cards.mjs` own ETF rows on a schedule, or (b) accept that the
  indicator engine owns ETFs too and retire `seed-etf-cards.mjs`. Decide;
  don't let `dataQuality` decide.
- Every writer already sets a distinct `ticker_cards.source`
  (`modal-eod` / `hydrate-local` / `gcp3`). Keep that — it is the only way to
  tell after the fact which engine wrote a row.

### R5. A CI guard against silent re-divergence

- Add `__tests__/hydration-constants.test.ts` asserting the Python JSON and the
  TS module agree (parse both, deep-equal).
- Add a lightweight check (script or test) that greps `modal_app.py` and
  `hydrate-indicators.mjs` for a `CONFLUENCE_CONTRACT_VERSION` string and fails
  if they differ — bump it deliberately when the model changes, the same
  pattern as `CARD_SCORE_VERSION` / `TAXONOMY_VERSION`.
- Run `__tests__/hydrate-indicators.test.ts` (already in `--project unit`) as a
  **required** check on any PR touching `deploy/**` or `scripts/lib/**`.

---

## 6. Acceptance checklist

Parity is "as robust as possible" when all of these hold:

- [ ] `confluence` has exactly one implementation, or a fixture test pins the
      JS output to the Python output at `1e-9` (R1 / R2).
- [ ] `LOOKBACK_DAYS`, min-bars, and Alpaca `adjustment` come from one shared
      source read by both Modal and `hydrate-local.mjs` (R3).
- [ ] A single documented decision records which host is live for
      stock cards and for ETF cards, and the non-live twin's schedule is
      disabled in code (R4).
- [ ] CI fails if `modal_app.py` and `hydrate-indicators.mjs` disagree on the
      confluence contract version or the shared constants (R5).
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
- `docs/running-universe-hydration-locally.md` — the pure-Node path; confirms
  100 % of stored cards are `source = hydrate-local`
- `scripts/local-signal-report.mjs` — local run of the JS engine only, emits
  `docs/local-signal-report.html`
- `__tests__/hydrate-indicators.test.ts` — the parity pin (indicators only)
- `lib/shared/card-policy.ts` / `lib/grounding/taxonomy.ts` — where the portal
  re-scores, and which posted fields it trusts
