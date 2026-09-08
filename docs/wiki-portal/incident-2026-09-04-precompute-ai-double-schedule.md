---
date: 2026-09-04
type: incident
tags: [scheduling, modal, github-actions, openrouter, quota]
sources: [../../.github/workflows/precompute-ai.yml, ../../deploy/precompute-ai/modal_app.py, ../deploy-runner-decision.md, PR#105]
---

# Incident: `precompute-ai` scheduled on both GHA and Modal for the same minute

## Date & severity

Found 2026-09-04, during the Phase 5/6 audit pass of
`docs/openrouter-migration-and-db-parity-plan.md`. Severity: **low, likely
latent rather than active** — [[incident-2026-08-18-modal-under-recommended]]
established that as of 2026-08-18, "`modal deploy` has never been run for any
of" the three Modal apps in `deploy/`, `precompute-ai` included. If that is
still true, the two schedules below are a bug waiting for someone to run
`modal deploy deploy/precompute-ai/modal_app.py`, not an active double-spend
today. Logged anyway because the schedule conflict itself is real, unrelated
to whether it's currently triggered, and worth fixing before that deploy
ever happens rather than after.

## What happened

`.github/workflows/precompute-ai.yml` (`cron: '10 0 * * *'`) and
`deploy/precompute-ai/modal_app.py` (`schedule=modal.Cron("10 0 * * *")`) are
both scheduled for the exact same UTC minute. Both files' own header comments
already say "run ONE of GHA or Modal, not both" — the schedules simply never
enforced that. If the Modal function is currently deployed (`modal deploy`
has been run against it), every night both fire and both call
`POST /api/pipeline/precompute-ai`, doubling the draw against the single
shared OpenRouter free-tier quota bucket for identical output.

## Root cause

The two runners were built as a documented either/or pair (per the "run ONE"
comment in each file) but nothing kept their `schedule=` values from drifting
into simultaneous activation — there's no single source of truth for "which
one is currently the live scheduler," so a `modal deploy` at any point in the
past could have silently turned this from a documented choice into an active
conflict with no error, no crash, and no signal beyond doubled quota spend.

## Resolution

**Code half resolved (`feat/pipeline-full-runs-nulogdash`, 2026-09-08).**
`deploy/precompute-ai/modal_app.py` no longer carries `schedule=modal.Cron(...)`
— the `@app.function` is now a manual/failover runner only, and its docstring
plus an inline comment state that GHA (`precompute-ai.yml`) owns the schedule
and that re-adding a Modal `schedule=` must happen *in the same change* that
disables the GHA workflow, never alongside it. The two `10 0 * * *` cron lines
can no longer both be active from a plain `modal deploy`.

**Operational half still open.** The code change is inert until someone runs
`modal deploy deploy/precompute-ai/modal_app.py` (to pick up the removed
schedule) or `modal app stop nuwrrrld-precompute-ai` against the real account —
tracked in `docs/manual-setup-todo.md` §5e. If the app was ever deployed with
the old schedule, both runners keep firing until that deploy/stop happens.

Prior state, for context:

**Not resolved in PR #105.** Determining which scheduler is currently live
requires `modal app list` (or the Modal dashboard) against the real account —
information not available from a repo checkout — and disabling a schedule
that might be the one currently in production is a "destroy running state"
action the destructive-action rule in `~/.claude/CLAUDE.md` gates on
explicit confirmation, not something to guess at from source alone.
Documented instead, with the concrete recommendation (keep GHA, stop
scheduling Modal) in `docs/deploy-runner-decision.md` Finding 1, and the
specific manual step needed (`modal app stop nuwrrrld-precompute-ai` or
remove `schedule=` from `deploy/precompute-ai/modal_app.py` and redeploy)
left for the repo owner.

## Impact on design

- This is the concrete argument for [[entity-db-parity-suite]] and the
  wider Phase 1-4 OpenRouter consolidation happening in the same plan: once
  every model call in every runtime shares one OpenRouter key's daily quota,
  a scheduling bug like this one gets strictly more expensive, not less —
  there's no longer a second provider's separate quota to absorb the
  duplicate spend.
- Surfaces a gap worth closing generally: no repo-level way to answer
  "which scheduler is actually live for job X" without checking each
  platform's own dashboard/CLI. Not fixed here; noted as the kind of
  cross-platform drift `docs/deploy-runner-decision.md` exists to catch on
  future audits.

## Open items

- ❓ Confirm via `modal app list` whether `nuwrrrld-precompute-ai` is
  currently deployed; if so, `modal deploy` (to adopt the now-removed
  schedule) or `modal app stop` it. `docs/manual-setup-todo.md` §5e.
- ✅ `schedule=` removed from `deploy/precompute-ai/modal_app.py`
  (`feat/pipeline-full-runs-nulogdash`) — a bare `modal deploy` can no longer
  recreate the collision.
- ❓ Should `deploy-runner-decision.md`-style audits become a standing check
  (e.g. a periodic diff of every `cron`/`modal.Cron` schedule across the repo)
  rather than a one-time finding, given this drift happened silently once
  already?

## See also

- `../deploy-runner-decision.md` — the full Phase 5/6 audit this incident came out of, including the two adjacent non-conflicts it also checked (`hydrate-universe` vs. `universe-hydration`, `free-model-refresh`'s intentional multi-platform redundancy)
- [[incident-2026-08-18-modal-under-recommended]] — established that none of the three `deploy/*/modal_app.py` apps had ever been deployed as of 2026-08-18; this incident's severity assessment rests on that likely still holding
- [[entity-db-parity-suite]] — the other half of the same PR's changes
