---
date: 2026-07-20
type: concept
tags: [resilience, degradation, fallback, non-fatal, persistence]
sources: [../../lib/shared/portfolio-health-policy.ts, ../../lib/council-grounding.ts, ../../lib/council-db.ts, ../../lib/grounding/resolve.ts, ../../app/api/council/deliberate/route.ts, ../../app/error.tsx, ../../app/global-error.tsx, ../../app/not-found.tsx, PR#37, PR#82]
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
- `app/dashboard/HealthBanner.tsx` (PR #65) — the **UI-facing** end of the pattern: turns `/api/health`'s `down`/`degraded` verdict into a user-visible banner, the "and say so" clause made visible rather than logged. Asserted by [[entity-playwright-e2e]]'s health EXPOSE test.
- `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx` (PR #82) — the **render-time** end of the pattern. `error.tsx` catches a thrown route segment; `global-error.tsx` catches the root layout itself (which `error.tsx` cannot see, since it does not wrap the layout above it in its own segment); `not-found.tsx` catches the typo'd dynamic segment, reachable on `/verdict/[ticker]` and `/dashboard/holdfold/[ticker]`, which accept arbitrary strings.
- `app/api/signals/[ticker]/chat/route.ts` + `lib/signal-chat-local.ts` (2026-09-11)
  — the newest rung, and a full walk of the ladder in one route: upstream agent →
  shape-check → local grounded answer with `X-Signal-Chat-Source` → honest 503 when
  grounding itself is unavailable. Notably it degrades *inside the prompt* too,
  labelling `ai_degraded` timeframes as "rule-based fallback, not an AI read", so a
  weak basis cannot be narrated as a considered one. See
  [[decision-local-signal-chat-over-missing-gcp3-agent]].
- **Two violations found 2026-09-11**, both of which degraded to an *error* where a
  lesser answer was available: a 403 model primary that threw instead of falling
  through, and two routes whose 25 s abort killed the model fallback walk partway.
  Degrading correctly is not automatic — a budget or a status predicate that is
  merely *wrong* converts the ladder into a cliff
  ([[incident-2026-09-11-nulogdash-blind-sweep]]).
- Contrast: **CHAIR synthesis is the one exception** — if it fails, `deliberate` returns a hard 503 `Council synthesis unavailable`, because there's no meaningful degraded output without a synthesizer.

## Contradictions / tensions

> The stance is a double edge: a fully-degraded deliberation (grounding miss + several seats down + no persistence) still returns `200 OK` with a verdict. Nothing in the response schema signals *how* degraded it was to the end user — `degradedSeats` is returned but the UI's use of it isn't verified here.

> ❓ Open question: silent degradation optimizes for availability. For a financial-advice-adjacent product, is "always answer, even ungrounded" the right default, or should a total grounding miss surface a visible "low-confidence, ungrounded" banner to the user rather than only logging it?

> ✅ Further answer (PR #82): the pattern reached the **render** layer, which had been its largest hole. Until now the app had no `error.tsx`, `global-error.tsx`, or `not-found.tsx` at all — so the one failure mode with *no* defined lesser state was a component throwing during render, which fell through to Next.js's unstyled default screen. That is the exact inverse of this concept's rule: not a degraded-but-honest result, but an un-branded dead end with no recovery affordance, on paid routes. The three boundaries close it, and each surfaces `error.digest` — the hash that ties what the user saw to a server log line, making "tells them what was unavailable" actionable rather than merely polite. Note the Next.js 16 detail that makes this non-obvious to write: the retry prop is `unstable_retry`, not the older `reset`, so a from-memory implementation yields a button that silently does nothing — itself a silent-degradation bug.

> ✅ Partial answer (PR #65): at the *infrastructure* layer the "make it loud" side won. `app/dashboard/HealthBanner.tsx` polls `/api/health` on dashboard mount and renders a visible banner naming the affected dependency (market data / database / billing / Nu AI / sign-in) whenever one is `down` or `degraded` — the first UI surface that tells the user degradation is happening rather than only logging it. It deliberately treats `not_configured` as inert (expected in previews) and ignores its own `AbortError` on unmount, so it fires only on real degradation. This closes the "loud, not silent" question for backend-dependency health; the narrower grounding-miss case (per-request ungrounded answers) still degrades silently and remains open.

### Counterexample — Portfolio Health (2026-07-26)

The first observed case where the pattern **failed as designed**, turning the open question above from theory into a shipped harm. See
[[incident-2026-07-26-portfolio-health-endpoint-missing]].

Two distinct breakdowns, worth separating:

- **Degradation without a floor.** [[entity-portfolio-intelligence]] recorded the obligation that `health-ai` should fall back to the deterministic `health` score rather than error. But both depend on the *same* missing upstream route, so the fallback target was never healthier than the thing falling back to it. "Fall back to X" is not a resilience property unless X has an independent failure mode — a degradation chain is only as good as its terminal state.
- **Silent degradation that should have been loud.** `fetchHealth()` catches everything and returns `null`, flipping the prompt to "Portfolio health data: unavailable" and letting the model narrate a portfolio it was handed no data about. Unlike the council's `degradedSeats`, there is no field that could even carry the signal — the council tells CHAIR which seats were missing; nothing tells the user their health check was ungrounded.

The sharpened rule: **degrade to a lesser state, never to a plausible-looking fabrication.** The council degrades to "reason from general knowledge *and say so*." This path degraded to "reason from nothing, silently." The `and say so` clause is the part that carries the honesty, and it's exactly what was missing.

#### Resolution — the terminal state had to be *built*, not chosen (2026-09-11)

The first breakdown above named the defect precisely — "a degradation chain is only as good as its terminal state" — and that framing turned out to hide the actual work. There was no terminal state to fall back **to**. Both links in the chain pointed at the same missing gcp3 route, so no amount of re-ordering the fallbacks would have produced one.

The fix was to build a terminal state out of data the portal already owned: `ticker_cards`, the full-universe signal layer ([[entity-ticker-universe-pipeline]]), which can score a watchlist with no network call to anyone. See [[decision-local-portfolio-scoring-over-upstream-wait]].

Three things this adds to the pattern:

- **A terminal state must have an independent failure mode, and the way to get one is usually to own the data.** The council's terminal state is "reason from general knowledge," which is available precisely because it depends on nothing. `ticker_cards` qualifies for the same reason — it is in this repo's own database. A fallback that shares a dependency with the thing it backs up is not a fallback.
- **The honest floor is `null`, and something must be willing to return it.** A watchlist where not one ticker has a card yields **no score** — 503 with its own copy — rather than a number computed from nothing. That is the shape the original failure lacked: `score ?? 0` was a refusal to have a bottom, and it rendered as Grade F.
- **"And say so" needs a carrier, not just an intention.** The counterexample above notes there was "no field that could even carry the signal." There is now: `X-Portfolio-Health-Source: upstream|local`, rendered by the web client as a provenance line. Compare `degradedSeats` and `HealthBanner` — every honest degradation in this codebase has a named field behind it, and the ones that degrade silently are exactly the ones that don't.

> ⚠️ Still unresolved, and worth stating plainly: `health-ai` **still does not fall back to the score.** The obligation this page records has been satisfiable since 2026-09-11 and remains unsatisfied — the AI narrative goes on being ungrounded while a real, factor-level score sits one function call away. The counterexample is half-closed: the deterministic panel is honest, the narrated one is not.

> ⚠️ And the new failure mode is quieter than the one it replaced. A stale `ticker_cards` degrades the score with no error and no age badge — the same visible-age gap [[concept-cache-then-degrade]] records for stale-serve. "Route missing" was loud; "cards are six days old" is not. Degradation that succeeds is harder to notice than degradation that fails, which is the standing cost of this whole pattern.

## See also

- [[incident-2026-09-11-nulogdash-blind-sweep]] — two ladder-to-cliff regressions, and a feature that returned 503 for its whole life

- [[entity-grounding-tier-ladder]] — the miss/degraded mechanics
- [[entity-ai-council]] — per-seat isolation and the 503 exception
- [[decision-compile-time-grounding]] — the design that makes grounding optional-at-request-time in the first place
- [[decision-local-portfolio-scoring-over-upstream-wait]] — how the missing terminal state was built
- `gcp3/docs/wiki-gcp3/concept-no-mock-data.md` — the backend's related "honest empty over fake data" stance
