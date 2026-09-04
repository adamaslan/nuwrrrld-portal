# Deploy runner decision — one path per scheduled job

**Status:** decision + live-conflict finding · **Phase:** 5 of
[openrouter-migration-and-db-parity-plan.md](openrouter-migration-and-db-parity-plan.md)

Every batch job in `deploy/*/modal_app.py` + `.github/workflows/*.yml` should
have one *scheduled* runner unless this audit explicitly documents intentional
multi-platform redundancy (see Finding 3's `free-model-refresh`, which keeps
four by design). This audit found the actual state is mixed: one genuine live
conflict, one deliberately-redundant design that the migration plan's Phase 5
draft mischaracterized as a conflict, and one same-family-different-purpose
pair that isn't a conflict at all.

## Finding 1 — `precompute-ai`: live double-fire (real conflict, unresolved)

`.github/workflows/precompute-ai.yml` (`cron: '10 0 * * *'`) and
`deploy/precompute-ai/modal_app.py` (`schedule=modal.Cron("10 0 * * *")`) are
both scheduled for **the same minute**. Both workflow files already say "run
ONE of GHA or Modal, not both" — the schedules just don't reflect that.

This is likely latent rather than active: `docs/wiki-portal/incident-2026-08-18-modal-under-recommended.md`
established that as of 2026-08-18, `modal deploy` had never been run for any
of the three Modal apps in `deploy/`, `precompute-ai` included. If that's
still true, nobody is currently double-billed — but the schedule conflict is
real and worth fixing before someone does deploy it, rather than
discovering the double-spend after the fact. If the Modal app *has* since
been deployed, every night both fire, doubling the call to
`/api/pipeline/precompute-ai` against the shared OpenRouter free-tier quota
bucket the whole app draws from (Phase 1-4 make that bucket
OpenRouter-only, which makes a double-fire here strictly more expensive, not
less — one more reason to close this now).

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

## Finding 2 — `hydrate-universe` vs. `universe-hydration`: overlapping on the stock lane (real conflict, unresolved)

**Corrected from an earlier draft of this finding, which concluded "No
change" — that conclusion was wrong.** `.github/workflows/hydrate-universe.yml`
runs weekdays at 22:30 UTC; `deploy/universe-hydration/modal_app.py` runs
daily at 00:05 UTC, and its own comment explains the timing: *"before the
00:10 precompute, so the AI batch ranks tonight's cards rather than last
night's."* The timing difference is real and the Modal job's purpose (feed
`precompute-ai` fresh cards) is genuine — but that doesn't make them
non-overlapping. `deploy/universe-hydration/modal_app.py`'s scheduled call
explicitly posts `"universe": "stock"` only (the module's own header: *"gcp3
owns ETF rows, this job owns stock rows"*). `hydrate-universe.yml`'s
scheduled (cron) trigger carries no `universe` input at all —
`github.event.inputs.universe` is empty on a cron fire, not `workflow_dispatch`
— so `IN_UNIVERSE` never gets set and the `--universe=` flag is never added,
meaning the script defaults to **both lanes**, exactly like a manual
`workflow_dispatch` with `universe: all`. So every weeknight, if the Modal app
is live: both runners fetch Alpaca bars for the stock universe and POST to
`/api/pipeline/hydrate-universe`, independently — the same live-double-fire
shape as Finding 1's `precompute-ai` conflict, just staggered by ~90 minutes
(22:30 vs. the next 00:05) rather than firing at the same minute.

**Not applied automatically, same reason as Finding 1**: whether
`nuwrrrld-universe-hydration` is actually deployed on Modal can't be
determined from this checkout. **Action needed from you:** run `modal app
list` to confirm. If it's live, either restrict `hydrate-universe.yml`'s
scheduled trigger to `--universe=etf` (the lane Modal doesn't cover) or stop
the Modal schedule and let the GHA job own both lanes — don't leave both
covering stock unconditionally.

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
