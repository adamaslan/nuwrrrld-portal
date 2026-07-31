---
date: 2026-07-24
type: entity
tags: [signals, holdfold, data, cache, gcp3, real-data]
sources: [../../lib/shared/signal-lookup.ts, ../../lib/holdfold-cache-db.ts, ../../lib/shared/signalFilters.ts, ../../app/api/signals, ../../app/api/holdfold/route.ts]
---

# Entity — Signal Data Plane

> **Canonical signals doc.** Start here for anything signal-related. The
> narrower pages ([[decision-pending-signals-queue]], [[entity-live-price-tier]],
> [[entity-holdfold-cache]]) cover one lane each and link back here;
> `../findings-signal-loop-hardening.html` is a point-in-time snapshot of the
> PR #40 hardening pass, not a living doc; `../live-data-wiring.md` (2026-06-28)
> predates the cache/queue architecture and is an archive candidate.

## What it is

The read path that turns the **gcp3 backend** signal digest into everything the
portal shows outside the AI Council: the Signals feed, Hold/Fold verdicts, and
the per-ticker grounding briefs the Council itself consumes. It is a thin,
defensive fetch-and-shape layer — the portal computes no indicators of its own;
it renders what gcp3 already baked.

Three moving parts:

- **Per-ticker lookup** — `lib/shared/signal-lookup.ts` hits
  `{gcp3-backend-url}/signals?symbol=X` (env `MCP_BACKEND_URL`), returns the raw
  entry, and can format a plain-text "REAL DATA brief" (`ai_action`,
  `confluence_score`, `ai_summary`, top signals). Single-sourced so Council
  grounding and Nu AI chat parse identically. As of TODO2 this is a
  **read-through L2**: fresh `signal_cache` hit → live fetch (8 s timeout, warms
  the cache) → *stale* cache on backend outage → null. TODO3 made the freshness
  window **volatility-aware** (`cacheTtlMinutes`: hot/actionable → 5 min, quiet
  → 30, else 15) and the cache read **discriminated** (`hit | miss | broken`,
  where `broken` logs `cache_broken` instead of masquerading as a cold miss).
  Pure validation/freshness/backoff logic lives in `lib/shared/signal-policy.ts`
  (DB-free, unit-tested).
- **Digest / Hold-Fold fetch + shape** — `app/api/holdfold/route.ts` and
  `app/api/signals/*` pull the full digest and reshape it into `SignalPayload` /
  `HoldFoldVerdict` records for the dashboard.
- **Client-side filter/sort** — `lib/shared/signalFilters.ts`
  (`filterSignals`/`sortSignals`, `CONFIDENCE_RANK`) shared verbatim with the
  mobile `DigestScreen` so both surfaces filter identically.

## Where used

- `app/dashboard/signals/SignalsClient.tsx` — the live feed (search / direction
  filter / sort, expandable cards, Go-Deeper → Council).
- `app/dashboard/holdfold/HoldFoldClient.tsx` — the Hold/Fold verdict list and
  detail panel.
- `lib/council-grounding.ts` → Tier 1 of the [[entity-grounding-tier-ladder]]:
  the per-ticker brief is the freshest, most specific grounding a seat can get.
- Nu AI chat grounding (`fetchTickerSignalBrief`).

## Known failures

1. **In-memory cache lost on cold start** — `app/api/holdfold/route.ts` once held
   an in-memory module-level `cached` var; every deploy/cold start wiped it and
   hammered the backend. Fixed by the 2026-07-15 audit with a Neon-backed L2
   ([[entity-holdfold-cache]] / `lib/holdfold-cache-db.ts`, 15-min TTL). See
   [[concept-cache-then-degrade]].
2. **Malformed signal element crash** — a non-object element in an entry's
   `signals[]` array threw on `s.detail` and killed the whole fetch; PR #37
   hardened `formatTickerBrief` to guard each element.
3. **Hardcoded backend host** — `MCP_BACKEND_URL` falls back to a literal
   Cloud Run hostname; if that URL rotates and the env var is unset, every
   lookup *now* falls back to stale `signal_cache` (TODO2) before returning
   `null` — a rotated host degrades to old-but-real data, not an empty feed.

## Open questions

- ✅ ~~Should the per-ticker lookup share a Neon L2?~~ **Done (TODO2).**
  `fetchTickerEntry` reads/writes the `signal_cache` table; N Council briefs
  within a TTL window now collapse to 1 backend hit. Cache read/write is
  try/catch-guarded ([[concept-cache-then-degrade]]).
- ❓ `signal_cache` (per-ticker), `holdfold_cache` (global blob), and
  `signal_digest_cache` now overlap — three caches worth consolidating once the
  drain path ([[decision-pending-signals-queue]]) is proven in production.
- ❓ There is still no freshness contract on `/signals?symbol=X` itself;
  `SignalsClient` renders an `isStale` badge from digest metadata, but the
  single-ticker path infers freshness only from the `signal_cache` timestamp.

## See also

- [[entity-holdfold-cache]] — the Neon L2 that backs the Hold/Fold path
- [[entity-backtest-engine]] — the *separate* engine for historical hit-rates
- [[entity-grounding-tier-ladder]] — consumes the per-ticker brief as Tier 1
- [[concept-cache-then-degrade]] — the resilience pattern this plane follows
- [[decision-pending-signals-queue]] — how a watchlist-add reaches `signal_cache`
- [[entity-live-price-tier]] — the Finnhub live-price lane + Modal drain cron
- `../findings-signal-loop-hardening.html` — snapshot of the four hardening passes
- `gcp3/docs/wiki-gcp3/overview.md` — the backend that bakes the signals
