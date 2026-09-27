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

## Open items

- ❓ **Not yet confirmed on the real Ubuntu GitHub Actions runner.** The fix
  was verified with local `bash -e` reproductions only; local bash version
  and invocation differences from the actual runner mean the specific
  failure mode (which exact line trips `set -e`) couldn't be pinned down
  with full confidence — only that the fixed forms are safe regardless.
  Confirm on the next real dispatch (dry-run or the 730-day backfill in
  progress as of this writing).
- ❓ **The automatic `workflow_run` trigger has likely never completed
  successfully.** Every prior manual test supplied all four optional
  inputs; the scheduled/automatic path supplies none. If the "Store daily
  bars" step's `args=()` lines were the actual failure point (rather than
  only Summarize), the nightly automatic run may have been failing since
  PR #189 merged. Worth checking the first automatic run after PR #191
  merges to confirm it completes.

## See also

- [[entity-signal-engine]] — the feature this workflow serves
- [[incident-2026-09-11-sqlite-backup-dead-since-launch]] — same class of
  bug (a scheduled job's own glue code failing a preflight/summary step),
  much higher severity there because it ran silently broken for a week
- [[incident-2026-09-03-nightly-hydration-dead-15-days]] — the workflow
  `engine-nightly.yml` chains after
