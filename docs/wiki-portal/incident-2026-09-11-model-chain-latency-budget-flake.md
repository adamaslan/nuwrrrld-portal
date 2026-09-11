---
date: 2026-09-11
type: incident
tags: [ci, live-tests, openrouter, council, flaky-test, latency]
sources: [../../__tests__/live/model-chain.live.test.ts, ../../__tests__/live/_harness.ts, ../../lib/openrouter.ts, PR#119, PR#97]
---

# Incident: CHAIR Blew Its 20s Latency Budget Twice in One Full-Suite Run

## Date & severity

**2026-09-11** — Severity: **Low**. No product code was at fault and nothing
shipped broken: this surfaced in a local `npx vitest run` (full suite,
`__tests__/live/**` included) taken as a post-merge sanity check after
[[entity-billing]]'s PR #119, not in a CI gate — `model-chain.live.test.ts`
is excluded from `npm test`/CI, same as when this exact tension was first
logged as an open question on [[entity-openrouter-client]] during PR #97. This
page exists to convert that open question into a dated occurrence, since it
has now recurred with a worse outlier than the one that originally raised it.

## What happened

A full local test run (`npx tsc --noEmit` + `npx vitest run`, no path filter)
finished with **11 failed / 718 passed / 14 skipped (743 total)**, 2 failed
test files, after **1613s**. Every assertion failure captured from the run's
tail was the same shape, in `LIVE: every council seat can actually answer >
seat CHAIR returns a non-empty answer`:

```
AssertionError: expected 20887 to be less than 20000
AssertionError: expected 26847 to be less than 20000
```

Both are `expect(result.latencyMs).toBeLessThan(SEAT_LATENCY_BUDGET_MS)` in
`model-chain.live.test.ts:76`, where `SEAT_LATENCY_BUDGET_MS = 20_000`
(`__tests__/live/_harness.ts`). CHAIR runs
`nvidia/nemotron-3-ultra-550b-a55b:free` — a 550B synthesis model, the
heaviest of the six seat primaries by design ([[entity-ai-council]] calls it
"synthesis (hardest job)").

**Limitation on this write-up**: the background task runner that captured
this run kept only a size-capped tail of stdout (44 lines survived out of a
1613s run), so the two `AssertionError`s above are the only two of the 11
failed assertions with recovered detail, and the *second* failing test file
from the "2 failed | 57 passed" file-level summary was never identified — its
name scrolled out of the buffer before the run finished. This page documents
what was recovered, not a complete account of the run.

## Root cause

Not a regression — a **known, already-flagged tension recurring worse than
before**. [[entity-openrouter-client]]'s open questions section already
recorded (from PR #97, 2026-09-02):

> Live-tested against the real catalog with the #9 fixes applied,
> `__tests__/live/model-chain.live.test.ts`'s 20s `SEAT_LATENCY_BUDGET_MS`
> failed 6/20 assertions (MACRO/QUANT/CHAIR each hit 20.7–23.8s at least
> once) — is 20s still the right SLA for an all-reasoning-model chain?

This run's 26.8s outlier is **~3s past the worst previously observed value**
(23.8s), on the same seat family (CHAIR, the largest model). The budget was
never re-derived after that PR #97 observation — it's still the original
20,000ms constant with no measured basis given since. This is a genuine
network/inference-latency variance in a real, uncached call to a 550B
free-tier model, not a bug in `runSeat`, `fetchWithModelFallback`, or the test
itself.

## Resolution

**Not resolved — this page is the record of recurrence, not a fix.** The
underlying tension (`SEAT_LATENCY_BUDGET_MS` fixed at 20s vs. an
all-reasoning-model chain whose heaviest member has now been observed at
20.7s, 23.8s, 20.9s, and 26.8s across two separate live runs) is unchanged
from PR #97. No code change was made in response to this run — flagging it
here is what lets the next occurrence be read as "third time" rather than
rediscovered from zero.

## Impact on design

- **A live-only suite excluded from CI needs an explicit review cadence, or
  its open questions rot.** This tension sat as one bullet on
  [[entity-openrouter-client]] for 9 days with no owner and no re-check;
  nothing forced anyone to look at it again until an unrelated full-suite run
  happened to hit the same seat harder.
- **A capped log buffer on a long-running background command loses the exact
  failure it was meant to prove.** 1613s of `vitest run` output was reduced
  to a 44-line tail, so this incident can name CHAIR's two worst
  latencies but not the second failed file or the other 9 failed assertions
  at all. A run expected to exceed a buffer's retention window should redirect
  to a file (`vitest run > run.log 2>&1`) rather than rely on a background
  task's captured stdout.
- **A hardcoded latency SLA on a free-tier reasoning model is measuring
  variance the code doesn't control.** `SEAT_LATENCY_BUDGET_MS` asserts
  against OpenRouter's live inference time for whichever provider is serving
  `nvidia/nemotron-3-ultra-550b-a55b:free` at call time — a number this
  codebase has no lever over. The four observed values (20.7s, 23.8s, 20.9s,
  26.8s) span 6.1s and are not obviously bounded above.

## Open items

- ❓ **Carried forward from PR #97, now with a fourth data point**: is 20s
  still the right `SEAT_LATENCY_BUDGET_MS`, or does CHAIR (and possibly
  MACRO/QUANT) need either a higher budget, a per-seat budget scaled to model
  size, or a fast non-reasoning entry ahead of the slow ones in
  `FREE_MODEL_CHAIN`? Two live runs, five months apart in observation but
  never actually re-measured in between, have now both broken 20s on the
  heaviest seat.
- ❓ What was the second failing test file? Not recovered from this run — if
  it recurs, capture full output to a file rather than relying on a
  background task's tail buffer.
- ❓ Should `model-chain.live.test.ts` record a rolling latency history
  (append observed `latencyMs` per seat to a local file each live run) so the
  next occurrence has real distribution data instead of four anecdotal
  points across two runs?

## See also

- [[entity-openrouter-client]] — open question this incident confirms recurred, and `runSeat`'s 20s per-model timeout this budget is distinct from (timeout is fetch-level; this budget is a test assertion on top of a successful call)
- [[entity-ai-council]] — CHAIR's role as the heaviest seat by design
- `../../__tests__/live/model-chain.live.test.ts` — the suite and exact assertion (line 76)
- `../../__tests__/live/_harness.ts` — where `SEAT_LATENCY_BUDGET_MS` is defined
