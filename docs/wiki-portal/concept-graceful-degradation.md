---
date: 2026-07-20
type: concept
tags: [resilience, degradation, fallback, non-fatal, persistence]
sources: [../../lib/council-grounding.ts, ../../lib/council-db.ts, ../../lib/grounding/resolve.ts, ../../app/api/council/deliberate/route.ts, PR#37]
---

# Concept: Graceful Degradation

Across the council stack, every dependency that *can* be missing degrades to a lesser-but-honest result rather than failing the request. The user always gets an answer; the system tells them (or logs) what was unavailable.

## The pattern

The same stance appears at every layer:

- **Grounding miss** → the brief becomes "reason from general knowledge and say so." The council runs ungrounded rather than erroring ([[entity-grounding-tier-ladder]]).
- **Stale pack** → served with a `degraded: true` flag instead of withheld.
- **A seat's model chain exhausts** → `Promise.allSettled` isolates it; the seat lands in `degradedSeats`/`emptySeats` and the CHAIR is *told which seats were unavailable* so it synthesizes honestly.
- **Persistence unreachable** → `lib/council-db.ts` wraps every call in try/catch. A deliberation still runs and returns; it just isn't saved and the quota isn't enforced. "Persistence is a durability feature, not a hard dependency of the request path."
- **Live signal fetch times out** (8 s) → grounding falls through to FTS or miss rather than blocking.

The consistent rule: **the request path has exactly one hard dependency — the OpenRouter call itself.** Everything else has a defined lesser state.

## Where it appears

- [[entity-grounding-tier-ladder]] — miss → ungrounded; stale → degraded flag
- [[entity-ai-council]] — per-seat isolation, `degradedSeats`, CHAIR informed of gaps
- `lib/council-db.ts` — non-fatal persistence
- Contrast: **CHAIR synthesis is the one exception** — if it fails, `deliberate` returns a hard 503 `Council synthesis unavailable`, because there's no meaningful degraded output without a synthesizer.

## Contradictions / tensions

> The stance is a double edge: a fully-degraded deliberation (grounding miss + several seats down + no persistence) still returns `200 OK` with a verdict. Nothing in the response schema signals *how* degraded it was to the end user — `degradedSeats` is returned but the UI's use of it isn't verified here.

> ❓ Open question: silent degradation optimizes for availability. For a financial-advice-adjacent product, is "always answer, even ungrounded" the right default, or should a total grounding miss surface a visible "low-confidence, ungrounded" banner to the user rather than only logging it?

## See also

- [[entity-grounding-tier-ladder]] — the miss/degraded mechanics
- [[entity-ai-council]] — per-seat isolation and the 503 exception
- [[decision-compile-time-grounding]] — the design that makes grounding optional-at-request-time in the first place
- `gcp3/docs/wiki-gcp3/concept-no-mock-data.md` — the backend's related "honest empty over fake data" stance
