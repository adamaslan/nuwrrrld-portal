---
date: 2026-08-19
type: concept
tags: [taxonomy, signals, data-quality, macd, grounding, cards]
sources: [../../lib/shared/card-policy.ts, ../../lib/grounding/taxonomy.ts, ../../scripts/lib/hydrate-indicators.mjs, ../../app/api/pipeline/hydrate-universe/route.ts, PR#70]
---

# Concept — Three-State Signals: Absent, Measured-Negative, Measured-Positive

## The pattern

An indicator that can *fail to be computed* has **three** states, not two, and
collapsing any pair of them corrupts everything downstream:

| State | Wire form | Meaning | Counts as a gap? |
|---|---|---|---|
| Not computed | key **omitted** | too little history, vendor miss | **yes** |
| Computed, negative | explicit `null` | measured; the thing did not happen | **no** |
| Computed, positive | `"bullish"` / `"bearish"` | measured; it happened | no |

MACD is the canonical case. `macdCross()` returns `"missing"` when there are
fewer than `slow + signal` (35) bars, `null` when it computed cleanly and found
no crossover, and a direction string when a cross occurred. Only the first is a
data gap. A quiet tape genuinely has no MACD cross, and that is a *finding* —
scoring it as un-measurable would mark every calm market as un-explainable.

The distinction is carried end-to-end by key presence, not by value:

- `hydrate-local.mjs` sets `row.macdCross` only when the value is not
  `"missing"`, so an uncomputed indicator leaves **no key**.
- `macdOrMissing()` in the ingest route reads `"macdCross" in row` — presence,
  not truthiness — to separate `undefined` from `null`.
- `missingInputFields()` special-cases the field: every other input is missing
  when `== null`, but MACD is missing only when `=== undefined`.

JSON preserves this: `{"macdCross": null}` and `{}` survive a round trip as
distinct objects. The distinction is fragile in exactly one place — anything
that rebuilds the object with `??`, spread-with-defaults, or a schema that
coerces absent to null will silently merge two states into one.

## Why it earns the complexity

`data_quality` is the fraction of the five taxonomy inputs actually present,
and `isExplainable()` gates the quota-spending explain batch on
`missingFields.length === 0`. Collapse "no cross" into "not computed" and:

- every quiet-tape card drops from `dataQuality: 1.0` to `0.8`,
- `missing_fields` becomes `["macdCross"]` on all of them,
- `topCards()` — which requires `missing_fields = '{}'` — returns **nothing**.

That is not hypothetical. It is what PR #70 found: 880 cards all carrying
`missing_fields: ["macdCross"]`, an entirely empty ranking, and no alarm
anywhere, because an empty top-N looks exactly like a correct top-N over an
empty universe.

## The diagnostic signature

> **Whole-universe uniformity is the tell.** `dataQuality: 0.8` with
> `missing_fields: ["macdCross"]` on *most* symbols is a market observation.
> The same values on *every* symbol is a pipeline defect — real markets do not
> produce a uniform indicator state across 880 unrelated instruments.

This generalizes past MACD: any single value appearing on 100% of rows in a
field that is supposed to vary is evidence about the writer, not the world.

## Where it appears

- `lib/shared/card-policy.ts` — `missingInputFields()`, `dataQuality()`,
  `isExplainable()`; the docstring there describes a `"none"` sentinel that was
  never implemented (the type is `"bullish" | "bearish" | null`), so read the
  code rather than the comment.
- `lib/grounding/taxonomy.ts` — `SignalStateInput.macdCross`, `bucketMacd()`;
  the taxonomy's `MACD` vocabulary has an explicit `none` bucket, which is the
  state-key spelling of "computed, no cross."
- `scripts/lib/hydrate-indicators.mjs` — the `"missing"` sentinel at source.
- `app/api/pipeline/hydrate-universe/route.ts` — `macdOrMissing()`, the
  presence check that preserves the distinction across the wire.
- [[entity-ticker-universe-pipeline]] — known failures 7 and the ranking gate.

## Contradictions / tensions

- ⚠️ Contradiction: `card-policy.ts`'s `missingInputFields()` docstring says a
  no-cross observation is reported "as the literal `"none"`", but
  `SignalStateInput.macdCross` is typed `"bullish" | "bearish" | null` and no
  code path ever produces the string `"none"`. The *behavior* is correct; the
  comment describes an abandoned design. Unresolved — worth either
  implementing the sentinel or correcting the comment, since the mismatch cost
  real time when tracing an empty ranking.
- ❓ Open question: only MACD gets three states today. ADX and RSI return
  `null` for both "insufficient history" and legitimately-undefined readings,
  so they cannot make the same distinction. Whether that matters depends on
  whether a genuine "computed, no reading" case exists for them — unexamined.
- Tension with simplicity: four of five inputs use `== null` and one uses
  `=== undefined`. That asymmetry reads as a bug on every first encounter and
  has to be re-justified each time. It is load-bearing, which is why it is
  written down here rather than left in a comment.

## See also

- [[entity-ticker-universe-pipeline]] — the pipeline this protects, and the
  incident where collapsing the states emptied the ranking
- [[entity-grounding-tier-ladder]] — `state_key` is built from these buckets;
  a wrong MACD bucket points a card at the wrong grounding rules
- [[concept-graceful-degradation]] — the broader "degrade to less, never to
  wrong" principle this is one instance of
