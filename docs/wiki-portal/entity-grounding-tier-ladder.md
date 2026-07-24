---
date: 2026-07-20
type: entity
tags: [grounding, taxonomy, corpus, deterministic, neon]
sources: [../../lib/grounding/resolve.ts, ../../lib/grounding/taxonomy.ts, ../../lib/council-grounding.ts, PR#35, PR#36, PR#37]
---

# Entity: Grounding Tier Ladder (`lib/grounding/*` + `lib/council-grounding.ts`)

The deterministic, zero-model-cost lookup that assembles each council seat's factual brief at request time. Every seat argues over the *same* compiled evidence, sliced differently — the horizon wall and RISK's counter-argument are enforced in SQL, not left to the model to remember.

## What it is

Two cooperating layers:

1. **`buildGroundedBrief(question, ticker, seat)`** (`lib/council-grounding.ts`) — the per-seat assembler. Fetches the live signal payload once (gcp3 `/signals?symbol=X`), derives the structured taxonomy fields from it, then calls the resolver with a seat-specific slice.
2. **`resolveGrounding(...)`** (`lib/grounding/resolve.ts`) — the four-tier search hierarchy. First tier to succeed wins:

| Tier | Source | Latency | Mechanism |
|---|---|---|---|
| 0 | compiled `grounding_pack` | ~5 ms | SQL join on `state_key` — an indexed lookup, not a search |
| 1 | `corpus_chunks` body | ~15 ms | Postgres full-text search |
| 2 | doc2query `search_terms` | ~15 ms | FTS over query-expansion terms |
| miss | — | — | honest ungrounded status; logged to `grounding_misses` |

**Zero model calls, zero embedding round-trips.** Everything runs on the same Neon connection that already fetches hit-rates and prior verdicts.

## The taxonomy (`lib/grounding/taxonomy.ts`)

Tier 0 only works because the signal state is a *finite, enumerable* key space. `toStateKey()` is pure — same `SignalStateInput` + horizon always yields the same key — so the pack lookup is a plain indexed join. Six dimensions bucket into a `state_key`:

| Dimension | Buckets | Boundaries |
|---|---|---|
| RSI | oversold / neutral / overbought | ≤30 / 30–70 / ≥70 |
| MACD cross | bullish_cross / bearish_cross / none | — |
| ADX | trending / ranging | ≥25 trending |
| Volatility | low / normal / high | ≤33 / 33–67 / ≥67 pct |
| Confluence | weak / moderate / strong | \|score\| ≥34 / ≥67 |
| Direction | bullish / bearish / neutral | — |

Plus `horizon` (`t1` \| `t2`). `TAXONOMY_VERSION` (`TAXONOMY_V1`) stamps every pack row; bumping it invalidates every existing `state_key` — the same discipline as a chunk-hash version bump.

## Per-seat slicing

`buildGroundedBrief` requests a different slice for each seat, so the seat wiring is a data-layer property:

- **T1 / T2** — `horizon: 't1'|'t2'`, `traderFilter: 'T1'|'T2'`. T1 evidence never argues a T2 thesis; the corpus itself carries `trader_filter` from the filename ([[entity-grounding-compiler]]).
- **RISK** — a *counter-slice*: pack rows whose `direction` is the `opposite()` of the live signal. `opposite(neutral)` is null, so RISK falls back to no direction filter rather than an empty brief.
- **MACRO** — Tier 1/2 FTS only; macro isn't in the taxonomy.
- **QUANT** — no pack rules at all; numbers only.
- **CHAIR** — reads the whole assembled context.

## Where used

- [[entity-ai-council]] — every seat's round-1 and the CHAIR brief come from here (`app/api/council/deliberate/route.ts` calls `buildGroundedBrief` per seat)
- [[concept-verdict-repair-loop]] — the numeric cross-check validates verdict numbers against *this brief's* text
- The compiled pack it reads is produced by [[entity-grounding-compiler]]

## Known failures

1. **Total grounding miss.** If no tier answers, the brief degrades to "reason from general knowledge and say so" — an honest ungrounded status, never a hard failure. The miss is logged to `grounding_misses` for later corpus gap-filling.
2. **Stale pack (`degraded: true`).** If a pack row's `corpus_version` lags the current compiler version, the result is flagged degraded but still served — evidence that's slightly old beats no evidence.
3. **Live signal fetch times out.** `fetchSignalData` aborts after 8 s (`FETCH_TIMEOUT_MS`); the taxonomy fields are then unavailable, forcing a fall-through past Tier 0 to FTS or miss.

## Open questions

- ❓ The gcp3 backend URL is a hardcoded fallback (`MCP_BACKEND_URL ?? "https://…run.app"`) — should a missing env var be a hard config error instead of silently using the baked-in host?
- ❓ Tier 2 (doc2query expansion) exists in the resolver but the corpus that would populate `search_terms` isn't migrated yet ([[entity-grounding-compiler]] — sample corpus only). Is Tier 2 ever actually hit in production today?

## See also

- [[entity-ai-council]] — the consumer of every brief
- [[entity-grounding-compiler]] — how the pack this reads gets built
- [[decision-compile-time-grounding]] — why lookups are compiled, not embedded at request time
- [[concept-graceful-degradation]] — the "run ungrounded rather than fail" stance
- `gcp3/docs/wiki-gcp3/endpoint-signals.md` — the upstream `/signals` endpoint this fetches from
