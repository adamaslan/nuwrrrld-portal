---
date: 2026-08-18
type: incident
tags: [modal, scheduling, recommendation-bias, gha, deployment, coverage, process]
sources: [../max-coverage-simplest-path.md, ../gha-modal-core-feature-coverage.md, ../modal-vs-gcp-signal-coverage.md, ../pipeline-todo-blockers.md, ../../deploy/universe-hydration/modal_app.py, ../../deploy/precompute-ai/modal_app.py, ../../deploy/free-model-refresh/modal_app.py, ../../scripts/gen-portal-push-secret.sh]
---

# Incident — Modal Consistently Deferred Despite Being the Right Tool

## Date & severity

**2026-08-18.** Severity: **low technically, moderate procedurally.** Nothing
broke and no data was lost. The cost is opportunity and misdirection: a
well-suited compute lane sat unused for weeks while work routed around it, and
the wiki read as though Modal were covered when zero Modal jobs had ever run.

## What happened

Raised by the user during the PR #66 session: *"Claude was not recommending
Modal even though there is clearly a way to utilize it for this app."*

The first response was to push back, citing
`docs/gha-modal-core-feature-coverage.md`, which devotes three of six options
to Modal and calls Option D (*"Modal as the AI-work relocator"*) **"the biggest
unconventional win"** and **"the highest-leverage idea here."** On that
evidence the claim looked disproven.

That reading was wrong, because it cited the **older** doc. Sorting the source
docs by date reverses the conclusion. The two documents written **on 2026-08-18**
— the ones actually steering current work — consistently route around Modal:

| Source | What it says about Modal |
|---|---|
| `max-coverage-simplest-path.md:76` | The earlier Modal proposal (`universe-scale-hydration.md`) is *"substantially more machinery than the problem needs"* — and this doc explicitly supersedes its sequencing |
| `max-coverage-simplest-path.md:377` | A Modal pandas job *"creates a second RSI implementation"*; the recommended path is extending gcp3 instead |
| `max-coverage-simplest-path.md:292` | `OPENROUTER_API_KEY` in Modal — *"avoid this in the first version"* |
| `modal-vs-gcp-signal-coverage.md:197` | Quota-timed AI batches → *"either scheduler; pick one and delete the other"* — no preference given to the one already written |
| `pipeline-todo-blockers.md:150` | Blocker 6's fix: *"GHA is simpler per the workflow's own comment — no extra account"* |
| `.github/workflows/precompute-ai.yml:18` | *"GHA is the simpler default (no extra account, secrets already here)"* |

The same pattern repeated inside this session. `scripts/gen-portal-push-secret.sh`
was written to sync `PORTAL_PUSH_SECRET` to Vercel **automatically** while
deliberately **skipping Modal**, leaving it as printed manual instructions. The
stated reason is sound — `modal secret create --force` replaces a named secret
wholesale rather than merging, so writing only `PORTAL_PUSH_SECRET` would wipe
`ALPACA_API_KEY`/`ALPACA_API_SECRET` once those exist
([[entity-ticker-universe-pipeline]] known-failure #3). But the *outcome* is one
more place where the GHA/Vercel path got wired up end-to-end and the Modal path
got deferred to a human.

Net state at the time of writing: **three Modal apps exist in `deploy/`**
(`free-model-refresh`, `precompute-ai`, `universe-hydration`), a decision page
documents Option D as implemented, and **`modal deploy` has never been run for
any of them.**

## Root cause

Two compounding causes, only the second of which is about Modal at all.

**1. Each deferral was locally reasonable; the pattern was never evaluated.**
No single decision above is wrong. "Don't build a second RSI implementation"
is good engineering. "GHA needs no extra account" is true. "Don't wipe a Modal
secret you can't merge into" is correct. But each was decided in isolation
against a *generic* simplicity heuristic — fewer accounts, fewer services,
reuse what's wired — and nothing ever asked whether the accumulated verdict
matched the actual fit. It did not: Alpaca bulk hydration, pandas indicator
computation, and fan-out across ~4,300 tickers are precisely the work
`gha-modal-core-feature-coverage.md` Option F describes as *"the things Vercel
structurally cannot do."*

**2. Recency inverted the recommendation without anyone noticing.** The
pro-Modal analysis is older; the route-around-Modal guidance is newer and
therefore load-bearing for current work. A later doc superseding an earlier
one is normal and healthy — but here the supersession was about *sequencing*
(`max-coverage-simplest-path.md` says so explicitly) and silently carried a
tooling preference along with it. The tooling reversal was never argued on its
merits, so it was never reviewed.

A secondary contributor: **existence read as coverage.** Three `modal_app.py`
files and a decision page made Modal look done. This is the identical failure
mode already recorded on [[entity-openrouter-client]] — "a weekly job covering
half a surface leaves the other half to rot silently while reading as
coverage." Same shape, different surface.

## Resolution

- This page, recording the pattern rather than any single decision.
- [[entity-ticker-universe-pipeline]] and
  [[decision-precompute-ai-at-quota-reset]] now state plainly that no Modal job
  has ever been deployed, so "a Modal app exists" cannot keep reading as
  "Modal is running."
- **Not resolved:** the underlying choice. Blockers 4 (Alpaca credentials) and
  5 (`modal deploy`) remain open in `../pipeline-todo-blockers.md`. This
  incident does not decide them — it removes the false impression that they
  were already decided.

## Impact on design

- **Blocker 6 deserves a real argument, not a default.** The GHA-vs-Modal
  precompute duplicate should be resolved on merits — GHA's 6-hour job ceiling
  and lack of per-ticker fan-out versus Modal's extra account — rather than by
  "no extra account," which is a setup-cost argument masquerading as an
  architectural one.
- **The hydration lane may have no GHA equivalent.** Bulk Alpaca fetches plus
  pandas indicators across thousands of tickers is the Option F case. If Modal
  is rejected there, something must replace it (extending gcp3 is the doc's
  answer) — rejecting Modal without naming the replacement leaves the lane at
  zero, which is where it is now.
- **Simplicity heuristics need a scope.** "Fewer services" is a good default
  and a bad universal. Applied per-decision without a periodic look at the
  accumulated result, it reliably under-selects the tool that requires setup
  even when that tool is the correct one.

## Open items

- ❓ **Decide Blocker 6 on merits** — one precompute scheduler, with the
  reasoning written down. Currently both are scheduled at `10 0 * * *` against
  the same endpoint, double-spending quota for identical output.
- ❓ **Decide the hydration lane** — Modal + Alpaca, or extend gcp3's existing
  feature modules. Both are defensible; neither is chosen, and the lane is
  therefore dead. Blocks the entire ~4,300-ticker stock universe.
- ❓ **If Modal stays, deploy it.** Blockers 4 and 5. Three apps that have
  never run are worse than none — they read as coverage while providing zero.
- ❓ Should `gen-portal-push-secret.sh` gain a `--modal` flag that takes all
  required keys at once, so the Modal path is as automated as the Vercel path
  instead of permanently manual?

## See also

- [[entity-ticker-universe-pipeline]] — the pipeline whose stock lane this blocks
- [[decision-precompute-ai-at-quota-reset]] — Option D, implemented, never deployed
- [[entity-openrouter-client]] — the same "coverage that isn't" failure shape
- [[concept-wiki-led-development]] — the orient→change→ship→ingest loop this
  page is an instance of: the user's challenge became a recorded finding
- `../gha-modal-core-feature-coverage.md` — the pro-Modal analysis (Options C, D, F)
- `../max-coverage-simplest-path.md` — the later doc that routes around it
- `../pipeline-todo-blockers.md` — blockers 4, 5, 6
