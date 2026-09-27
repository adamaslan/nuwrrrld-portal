---
date: 2026-09-27
type: incident
tags: [ci, github-actions, bash, set-e, engine, shadow-mode]
sources: [../../.github/workflows/engine-nightly.yml, PR#189, PR#191]
---

# Incident — `engine-nightly.yml` Summarize Step Fails Under `set -e`

## Date & severity

**Caught 2026-09-27** during the first manual dry-run verification of
`engine-nightly.yml` (PR #189's own smoke test, run 36337116507), fixed same
day (PR #191). **Low.** The workflow was one day old and had not yet run
unattended — this is a "caught before it ever ran in the wild" finding, not a
silent-failure-in-production incident like
[[incident-2026-09-11-sqlite-backup-dead-since-launch]] or
[[incident-2026-09-03-nightly-hydration-dead-15-days]].

## What happened

A dry-run dispatch of `engine-nightly.yml` (`backfillDays=400 feed=iex
limit=20 dryRun=true`) fetched bars correctly — `[start] feed=iex
since=2025-08-23 symbols=20 dryRun=true` / `[done] symbols=20 fetched=5480
written=0 rejected=0` — but the run was still marked `failure` overall. The
"Summarize" step, `if: always()`, exited 1 while writing the
`GITHUB_STEP_SUMMARY`.

## Root cause

Two instances of the same shell pattern in the workflow are fragile under
`set -e`/`set -euo pipefail`:

1. **Summarize step**: `[ -f "$f" ] && { ...block... }` inside a `for`
   loop. When `run.log` doesn't exist — which is exactly what happens on a
   dry run, since `dryRun=true` makes the "Run the engine (shadow)" step's
   `if:` condition skip it entirely — the failed test can propagate as the
   step's own exit status.
2. **Store daily bars step**: four lines building `args=()` from optional
   `workflow_dispatch` inputs (`[ -n "${IN_BACKFILL}" ] && args+=(...)`,
   etc.) use the identical `test && action` shape. These are exercised
   every run, not just dry runs, including the *automatic* `workflow_run`
   trigger (after "Nightly universe hydration") where none of the four
   inputs are set at all.

Both are the same underlying hazard: a bare `cond && action` as a complete
statement is not a safe idiom under `set -e` once the possibility of `cond`
being false is real, because bash's exemption for commands inside `&&`/`||`
lists does not reliably cover every position and shell version. This didn't
surface in the "Store daily bars" step during the dry-run test only because
that particular invocation happened to supply values for all four inputs.

## Resolution

PR #191 rewrote both to forms that are unambiguously exit-0-safe when the
condition is false:

- Block form → `if [ -f "$f" ]; then ...block... fi`
- Single-line form → `[ -n "${IN_BACKFILL}" ] && args+=(...) || true` (repeated for all four)

Verified locally (`bash -e` against extracted script fragments) that the
fixed forms produce exit 0 in both the true and false branches. Not yet
verified against an actual GitHub Actions Ubuntu runner — see open items.

## Impact on design

None — [[entity-signal-engine]]'s nightly automation design (fetch bars,
then run detectors in shadow mode, chained after hydration) is unaffected.
This was a shell-idiom bug in the workflow's own glue code, not in
`lib/engine/` or the bar-fetch/run scripts themselves, which the dry run
proved correct (5,480 bars fetched, 0 written as expected, 0 rejected).

## Correction: the `args=()` lines were not actually the fatal path

The real 730-day backfill (run 36337851579, dispatched with `backfillDays=730
feed=iex` — `limit` and `dryRun` left at their unset/default values, so
`IN_LIMIT=""` and `IN_DRY_RUN="false"`) ran on the **unfixed** workflow (PR
#191 had not yet merged) and completed `success` end to end: 481,468 bars
across 978 tickers stored, then a shadow engine run against 974 tickers, 0
failed, 0 degraded, 87 hits. `IN_LIMIT=""` hit line 76's false-test branch —
the same shape suspected of being fatal — and the step did not abort.

So the confirmed, reproduced failure is narrower than first written above:
**only** the Summarize step's `[ -f "$f" ] && { block }` form, and only when
`run.log` is genuinely absent (the dry-run case, where the engine-run step is
skipped by its own `if:`). The four `args=()` lines in "Store daily bars" do
not appear to be live bugs on the actual runner — evidently a bare `test &&
action` as a complete statement is more forgiving of a false test under this
runner's bash than the local reproduction attempts suggested. The `|| true`
fix for those four lines is kept anyway as cheap, unambiguous insurance, but
this incident should not be read as evidence they were ever broken in
practice.

## Open items

- ❓ **The Summarize-step fix itself is still unconfirmed on a real dispatch.**
  Verified only via local `bash -e` reproduction of the extracted script
  fragment. Confirm on the next dry-run dispatch after PR #191 merges.
- ❓ **No automatic `workflow_run` trigger has fired yet.** As of this
  writing, `gh run list --workflow engine-nightly.yml` shows exactly two
  runs, both `workflow_dispatch` (the dry-run and the real backfill in this
  incident). The automatic trigger only fires after "Nightly universe
  hydration" completes on its own schedule, which hasn't happened since PR
  #189 merged. Given the correction above, it's now expected to succeed,
  but check the first one directly once it fires.

## See also

- [[entity-signal-engine]] — the feature this workflow serves
- [[incident-2026-09-11-sqlite-backup-dead-since-launch]] — same class of
  bug (a scheduled job's own glue code failing a preflight/summary step),
  much higher severity there because it ran silently broken for a week
- [[incident-2026-09-03-nightly-hydration-dead-15-days]] — the workflow
  `engine-nightly.yml` chains after
