# Deploy runner decision — one path per scheduled job

**Status:** decision + live-conflict finding · **Phase:** 5 of
[openrouter-migration-and-db-parity-plan.md](openrouter-migration-and-db-parity-plan.md)

Every batch job in `deploy/*/modal_app.py` + `.github/workflows/*.yml` should
have exactly one *scheduled* runner. This audit found the actual state is
mixed: one genuine live conflict, one deliberately-redundant design that the
migration plan's Phase 5 draft mischaracterized as a conflict, and one
same-family-different-purpose pair that isn't a conflict at all.

## Finding 1 — `precompute-ai`: live double-fire (real conflict, unresolved)

`.github/workflows/precompute-ai.yml` (`cron: '10 0 * * *'`) and
`deploy/precompute-ai/modal_app.py` (`schedule=modal.Cron("10 0 * * *")`) are
both scheduled for **the same minute**. Both workflow files already say "run
ONE of GHA or Modal, not both" — the schedules just don't reflect that. If
the Modal app is actually deployed (`modal deploy` run against it), every
night both fire, doubling the call to `/api/pipeline/precompute-ai` against
the shared OpenRouter free-tier quota bucket the whole app draws from
(Phase 1-4 make that bucket OpenRouter-only, which makes a double-fire here
strictly more expensive, not less — one more reason to close this now).

**Recommendation:** keep GitHub Actions canonical (secrets are already there,
no separate Modal account dependency for this job) and stop scheduling the
Modal function.

**Not applied automatically.** Whether `deploy/precompute-ai/modal_app.py` is
currently live on Modal can't be determined from this repo checkout — only
`modal app list` against the actual account can confirm it, and disabling a
schedule that may be the one currently in production is exactly the
"destroy running state" case the global safety rule gates on confirmation.
**Action needed from you:** run `modal app list` (or check the Modal
dashboard) to confirm whether `nuwrrrld-precompute-ai` is deployed; if it is,
either `modal app stop nuwrrrld-precompute-ai` or remove the `schedule=`
kwarg from `deploy/precompute-ai/modal_app.py` and redeploy. The GHA side
needs no change — it's already the documented default.

## Finding 2 — `hydrate-universe` vs. `universe-hydration`: different design, not a duplicate

`.github/workflows/hydrate-universe.yml` runs weekdays at 22:30 UTC (a
same-day, after-close pass). `deploy/universe-hydration/modal_app.py` runs
daily at 00:05 UTC, and its own comment explains why: *"before the 00:10
precompute, so the AI batch ranks tonight's cards rather than last night's"*
— it exists specifically to feed `precompute-ai`'s 00:10 run with fresh
cards, a dependency the GHA weekday job doesn't serve. These are not the same
job on two platforms; they're two different passes with different purposes
(and, per the header comment, `hydrate-universe.yml` is itself careful about
this — "ONE of them" language there refers to *itself* vs. a same-platform
duplicate, not vs. the Modal job). **No change.** Leave both scheduled.

## Finding 3 — `free-model-refresh`: multi-platform redundancy is the design, not a fork

The original migration-plan draft (Phase 5, first pass) assumed
`deploy/free-model-refresh/`'s GCP Cloud Run scripts (`deploy-gcp.sh` +
`cloudbuild.yaml`) were a duplicate of the GHA `refresh-free-models.yml`
workflow, to be archived. `deploy/free-model-refresh/README.md` says
otherwise: this job runs on **three independent platforms on purpose** — GHA,
GCP Cloud Run, and Modal (plus a documented Zo option) — *"so no single
outage lets the chain rot."* Each is idempotent (whichever fires first
writes the chain; the others see no diff and no-op), and the job spends zero
model quota (it probes OpenRouter's catalog, doesn't call a model), so
running all three costs nothing extra beyond three cheap containers running
briefly once a week.

**Correction to the plan doc:** Phase 5's original wording ("move the GCP
Cloud Run scripts to file-archive") is wrong for this job and is not being
applied. **No change** — the GCP + Modal + Zo runners for `free-model-refresh`
stay as designed redundancy, not deploy-variant debt.

## Summary

| Job | Runners scheduled | Verdict |
|---|---|---|
| `precompute-ai` | GHA (00:10) + Modal (00:10) | **Conflict.** Keep GHA; needs manual Modal undeploy/schedule removal — see Finding 1. |
| `universe-hydration` (Modal) vs. `hydrate-universe` (GHA) | Modal (00:05 daily) + GHA (22:30 weekdays) | Not a conflict — different purposes, both stay. |
| `free-model-refresh` | GHA + GCP Cloud Run + Modal + Zo | Not a conflict — intentional redundancy, both stay. |

This is a documentation-only change (Phase 5's "PR (docs + delete)" note);
the one deletion the original draft proposed (`deploy/free-model-refresh`'s
GCP scripts) is retracted per Finding 3, and Finding 1's fix is left for you
to apply against the live Modal account rather than guessed at here.
