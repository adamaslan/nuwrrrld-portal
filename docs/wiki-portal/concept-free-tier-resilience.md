---
date: 2026-07-30
type: concept
tags: [free-tier, cost, resilience, openrouter, quota, fallback, cron]
sources: [../../lib/openrouter.ts, ../../scripts/refresh-free-models.mjs, ../../.github/workflows/refresh-free-models.yml, PR#44]
---

# Concept — Staying Robust on a Free Tier

Every model call in this portal runs on an OpenRouter `:free` model
([[decision-free-tier-model-chain]]). That decision buys $0 marginal inference
and, in exchange, imports someone else's rate limits, someone else's model
churn, and someone else's outages. This page is about the machinery that keeps
$0 from meaning *unreliable* — and where that machinery currently falls short.

## The pattern

Free-tier robustness is layered. No single layer is sufficient; each catches a
different failure.

**Layer 1 — Redundancy within a request.** `runSeat()` builds
`[primaryModel, ...FREE_MODEL_CHAIN]` (deduped) and falls through on
**402 / 429 / 5xx** with a 20 s per-model timeout. One dead model is invisible
to the caller.

**Layer 2 — Freshness across weeks.** OpenRouter's free roster churns, so
`scripts/refresh-free-models.mjs` runs on a cron (Mondays 06:17 UTC) to rewrite
`FREE_MODEL_CHAIN`. It doesn't trust the catalog: it keeps only $0-priced
models *and then live-probes each one*, because a model can be priced $0 and
still return 402/429. The grounding compile is scheduled at 06:23 —
deliberately after — so it builds against the freshened list.

**Layer 3 — Refuse to make things worse.** The refresh script carries
`MIN_WORKING = 1`: if fewer than one model survives probing, it writes nothing
and exits non-zero, leaving the last known-good chain in place. A refresh that
can't verify anything must not strand the app with an empty chain.

**Layer 4 — Degrade honestly at the edges.** When the chain is genuinely
exhausted, routes return a real error rather than inventing output — the same
principle as [[concept-graceful-degradation]]. `/api/brief` was fixed in PR #46
to 503 instead of letting a model narrate missing data.

**Layer 5 — Spend the best model where difficulty is irreducible.** Seat→model
assignment treats capability as a budget: the hardest job (CHAIR synthesis)
gets the strongest free model; work reduced to classification (the CHAIR
verdict vote) gets `SMALLEST_MODEL`. See [[concept-small-model-prompting]].

## Where it appears

- `lib/openrouter.ts` — `FREE_MODEL_CHAIN`, `SEAT_MODELS`, `SMALLEST_MODEL`,
  `runSeat` fallthrough ([[entity-openrouter-client]])
- `scripts/refresh-free-models.mjs` — catalog filter, live probe, `MIN_WORKING`
  guard, preference ranking
- `.github/workflows/refresh-free-models.yml` — Mondays 06:17 UTC
- `.github/workflows/compile-grounding-pack.yml` — Mondays 06:23 UTC, ordered
  after the refresh ([[decision-compile-time-grounding]])
- `__tests__/live/model-chain.live.test.ts` — asserts the chain has real
  fallback margin, not just one surviving model

## The ceiling nobody designed for

The layers above all assume failures are **per-model**. They are not.

OpenRouter's free tier caps the **API key**, not the model: 50 requests/day
across every free model, raised to 1000/day with ≥10 credits on the account.
When that ceiling is hit, *every* model returns 429 simultaneously — so:

- `runSeat`'s fallthrough exhausts the whole chain and throws,
- the refresh script's probe sees "0 working models" and, correctly per
  `MIN_WORKING`, refuses to write,
- and **neither can distinguish "the entire free roster died" from "we're out
  of requests until midnight UTC."**

Observed 2026-07-30: all 14 candidate models returned 429 with
`X-RateLimit-Remaining: 0` and `limit_source: openrouter_free_tier_daily`.
The signal that disambiguates it is on the 429 body itself
(`X-RateLimit-Reset`, a UTC-midnight epoch) and on `GET /api/v1/key` — neither
of which any code path currently reads.

This also explains a standing CI failure: the refresh cron has failed on both
recent scheduled runs (2026-07-20 and 2026-07-27). A weekly job that probes 14
models can itself consume a meaningful share of a 50/day budget.

## Concrete hardening (highest value first)

1. **Read the 429 body.** Detect `limit_source: openrouter_free_tier_daily`
   and surface "quota exhausted, resets at {X-RateLimit-Reset}" instead of
   "all models failed." One parse turns a mystery into a fact.
2. **Pre-flight the refresh script.** Check `GET /api/v1/key` before probing;
   if remaining is ~0, exit 0 with "skipped — quota exhausted" rather than
   exit 1 with "0 working models." That alone fixes the weekly red cron.
3. **Budget the probe.** Probe until `CHAIN_SIZE` models pass, then stop —
   currently it probes the full candidate list even after finding enough.
4. **Separate the keys.** CI/cron probing and user-facing inference share one
   key and therefore one 50/day budget. A dedicated key for automation stops
   maintenance from eating production capacity.
5. **Add the 10 credits.** $10 once moves the ceiling 50 → 1000/day and makes
   most of the above merely nice-to-have. The $0-*marginal*-cost property of
   [[decision-free-tier-model-chain]] survives intact.

## Contradictions / tensions

> ⚠️ Contradiction: [[decision-free-tier-model-chain]] lists as *not validated*
> "whether free-tier rate limits hold up under real concurrent user load." As
> of 2026-07-30 that is **refuted, not merely unvalidated** — the cap is
> account-wide and was exhausted by ordinary development plus one cron. The
> decision page has been updated; the design has not.

> ⚠️ Contradiction: the system is architected as though model failures are
> independent (chain, fallthrough, per-model timeout), but the dominant
> real-world failure is perfectly *correlated* across all models. Redundancy
> across models cannot mitigate a shared-quota failure — only a second key,
> paid capacity, or graceful deferral can.

> ⚠️ Sharpened 2026-08-18: the correlation is worse than the shared quota
> alone, because the chain is also **single-vendor**. All four
> `FREE_MODEL_CHAIN` entries are `nvidia/*:free`
> ([[entity-openrouter-client]] known-failure #6), so even a vendor-scoped
> failure — not just an account-scoped one — takes the whole chain at once.
> The redundancy is nominal in two independent dimensions simultaneously.
> `refresh-free-models.mjs` produces this without intending to: it ranks on
> "$0 and probes healthy" with no vendor-diversity constraint, so it inherits
> whatever monoculture the free tier has that week. A per-vendor cap in the
> ranking is the smallest change that makes the existing chain machinery mean
> what it appears to mean.

> ⚠️ Contradiction added 2026-08-18: this page (and the whole free-tier design)
> assumes the *chain* is the thing that rots and gets refreshed weekly. But
> `SEAT_MODELS` — the other model list in the same file — has no scheduled
> maintainer, and 5 of its 6 primaries no longer exist
> ([[entity-openrouter-client]] known-failure #5). A weekly job that maintains
> half a surface leaves the other half to rot *silently*, which is worse than
> no job at all: the presence of automation is read as coverage.

> ❓ Open question: should a whole-chain 429 fail loudly (current behavior) or
> serve a stale cached deliberation? [[concept-cache-then-degrade]] argues for
> stale-over-nothing on the data plane; no equivalent decision has been
> recorded for model output, where staleness is arguably worse.

## See also

- [[decision-free-tier-model-chain]] — the decision this page operationalizes
- [[entity-openrouter-client]] — `runSeat`, the chain, known failures
- [[concept-graceful-degradation]] · [[concept-cache-then-degrade]] — the degradation rules
- [[concept-small-model-prompting]] — how prompts survive weak free models
- [[concept-test-strategy]] — why the `live` project is opt-in and retry-tolerant
- `../gha-modal-core-feature-coverage.md` — the scheduled-maintenance argument these two 2026-08-18 findings motivate
- `../api-failure-mitigation-build-options.md` — the degradation options for when the chain does fail
- `gcp3-mobile/docs/wiki-mobile/concept-free-tier-resilience.md` — the mobile counterpart (GCP infra free tiers, a different axis)
