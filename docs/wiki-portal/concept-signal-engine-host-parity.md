---
date: 2026-09-03
type: concept
tags: [pipeline, hydration, confluence, parity, modal, github-actions, gcp, taxonomy]
sources: [../signal-engine-parity-across-hosts.md, ../../deploy/universe-hydration/modal_app.py, ../../scripts/lib/hydrate-indicators.mjs, ../../lib/shared/card-policy.ts, ../../lib/grounding/taxonomy.ts, ../../scripts/seed-etf-cards.mjs]
---

# Concept — Signal-Engine Parity Across Hosts

## The pattern

The same `ticker_cards` table is written by three engines that were never
reconciled:

| Host | Engine | Universe | `source` |
|---|---|---|---|
| **Modal** `universe-hydration` | 7-detector strength-weighted confluence, gated direction (`raw ≥ 0.35` **and** `≥ 3` agreeing votes) | stock | `modal-eod` |
| **GitHub Actions** `hydrate-universe.yml` → `hydrate-local.mjs` | **pre-port** 2-indicator vote (RSI + MACD only), any lean → direction | stock **and** etf | `hydrate-local` |
| **GCP** `gcp3` → `seed-etf-cards.mjs` | 52-week range + relative strength + multi-period return | 54 ETFs | `gcp3` |

Modal and GHA are *meant* to be byte-identical — the header of
`scripts/lib/hydrate-indicators.mjs` says "the two write into the same table,
so a numeric divergence would mean two symbols were scored on different
scales." GCP is *meant* to be different, for a non-overlapping universe.

**Reality: the raw indicators (RSI/MACD/ADX/vol) are pinned and equal; the
`confluence` function has drifted and is not pinned by any test.** Modal runs
the full signals-app port; the JS still runs the pre-port version. Different
detector count, vote model, RSI tiers, normalization, ADX amplification,
direction rule, and score sign (Modal signed −100..100, JS unsigned 0..100).

### What the portal absorbs, and what it doesn't

`POST /api/pipeline/hydrate-universe` re-scores every card from discretized
tokens (`buildCard` → `scoreCard`), so it does **not** store the posted
`confluenceScore` directly. That absorbs the score's *sign* (`bucketConfluence`
takes `Math.abs`; `scoreCard` takes the sign from `direction`). It does **not**
absorb:

- the posted **`direction`** — passed through verbatim, and it *is* the sign of
  the directional core in `scoreCard` (`sign × {weak:10,moderate:30,strong:50}`);
- the posted **`confluenceScore` magnitude** — buckets to weak/moderate/strong;
- **`volatilityPercentile`** — different for Modal's 365-day vs JS's 120-day
  lookback (it is a percentile over the whole history);
- the resulting **`state_key`** — 2 of its 7 dimensions (`confluence`, `dir`)
  come from the drifted engine.

So `ticker_cards.score`, `.action`, `.state_key` for a symbol/day depend on
which host hydrated it. In practice every stored card is `hydrate-local`, so the
production ranking runs the pre-port engine and Modal's detector families
(Bollinger, Stochastic, OBV/CMF, MA-cross) have never reached a card.

## Where it appears

- `deploy/universe-hydration/modal_app.py` `_confluence()` — the authoritative
  port; also `_bollinger_votes`, `_stochastic_votes`, `_obv_cmf_votes`,
  `_ma_cross_votes`, `_STRENGTH_WEIGHT`, `_CATEGORY_BONUS`.
- `scripts/lib/hydrate-indicators.mjs` `confluence()` — the drifted pre-port
  version GHA actually runs.
- `__tests__/hydrate-indicators.test.ts` — pins RSI/MACD/ADX/vol at 1e-9;
  tests `confluence` only for internal properties, never against Python.
- `lib/grounding/taxonomy.ts` `bucketConfluence()` / `toStateKeyParts()` —
  where the posted magnitude and direction enter the token tuple.
- `lib/shared/card-policy.ts` `scoreCard()` / `shouldReplaceCard()` /
  `dataQuality()` — the re-score, and the `dataQuality` tie-break that lets the
  GHA ETF lane silently outrank gcp3's ETF model.
- `scripts/seed-etf-cards.mjs` `toSignalInput()` — the gcp3 → taxonomy mapper.

## Contradictions / tensions

- **The header comment claims a parity that does not hold.** `confluence` is
  explicitly *not* covered by the parity test, and it has diverged.
- **`dataQuality` is a field-completeness ratio, not a quality measure.** Five
  fields from a truncated 40-bar window outrank two fields from a purpose-built
  ETF model, so gcp3's ETF cards never land when GHA has run. The parity doc's
  §6.1 (port signals-app's real `data_quality.py`) fixes this as a side effect.
- **Lookback disagreement is load-bearing, not cosmetic.** 365 vs 120 days
  changes `volatilityPercentile` buckets and makes Modal's 50/200 MA detector
  computable only on its side.
- **`feed` and `adjustment` are unpinned** — `feed` resolves from the Alpaca
  *account plan* (`iex` vs `sip`), so a plan upgrade changes every indicator
  with no diff. `hydrate-local.mjs` also omits `adjustment=split` that Modal
  sends.
- **Fixing the drift by editing two files re-introduces it.** The remediation
  (parity doc R1) is to have exactly one confluence implementation — preferably
  server-side in `card-policy.ts`, with hosts posting only raw indicators.

## See also

- `../signal-engine-parity-across-hosts.md` — the full audit, findings §0–§4,
  remediation R0–R7, signals-app port plan §6, rate-limit math §7
- [[entity-ticker-universe-pipeline]] — the pipeline; its "Local runner"
  section describes the port that has since drifted
- [[incident-2026-09-03-nightly-hydration-dead-15-days]] — §0.1, outranks the
  drift: nothing has been writing cards for 15 days
- [[concept-three-state-signal]] — the MACD omit/null/cross distinction both
  engines must preserve
- [[incident-2026-08-31-signals-go-deeper-contract-drift]] — a sibling
  "two implementations of one contract drifted" incident
- `../modal-vs-gcp-signal-coverage.md` — why gcp3 and Modal are not substitutes
