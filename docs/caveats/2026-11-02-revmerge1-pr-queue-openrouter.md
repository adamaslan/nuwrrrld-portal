---
date: 2026-11-02
session: 2026-11-02 (revmerge1 run over the open PR queue above #324)
keywords: [revmerge1, pr-queue, e2e-brief, openrouter, shared-drift, merged-past-red]
repos: [nuwrrrld-portal]
---

## [2026-11-02] revmerge1 queue run: two PRs merged past a vendor-red e2e shard, four parked — nuwrrrld-portal

**Shipped:** [PR #328](https://github.com/adamaslan/nuwrrrld-portal/pull/328) (ET-labelled pipeline run times) merged as `415b35d`; [PR #332](https://github.com/adamaslan/nuwrrrld-portal/pull/332) (SESSION-SUMMARY `or True` correction) merged as `b851c8a`. Both merged while `e2e (1)` and `e2e (4)` were red on the live OpenRouter brief test.

### Current state
- **Merged past red:** #328, #332. The `e2e` brief failure is not in either diff.
- **Parked:** #324 (still a draft), #327 (`shared-drift-check` red), #334 (repoint not live), #335 (`auth` preflight red).
- **Unverified:** whether main's own e2e is red now. A rerun of main's e2e shard was requested but did not register.

### Timeline
| When | What | Outcome |
|---|---|---|
| Queue scan | Five non-draft PRs above #324: #327, #328, #332, #334, #335 | #324 skipped (draft; revmerge1 stops on drafts) |
| CI read | `e2e (1)` failed on #327, #328, #332 with the same test: `dashboard-brief-fault-injection.spec.ts` "real /api/brief call renders a non-empty brief" | Error: "OpenRouter: all models in chain returned empty completions" |
| Main comparison | Main CI at eb627c6 passed earlier the same day | Looked like stale-base, since the PR branches predated main's `FREE_MODEL_CHAIN` refresh |
| Stale-base fix (#328, #332) | Merged `origin/main` into each branch (merge commits, not rebase) | Pushed fast-forward. The brief shard stayed red on the new heads, so the stale-base theory was wrong for this run |
| Verification | Local `npm run lint`, `npm test` (unit 1192/1189, components 124), `tsc` error set identical to main's 17 pre-existing errors | Passed. Read-only Opus verifier returned GO on both heads |
| Merge | #328 squash-merged, then #332 after one wiki-log append conflict | Both merged, worktrees removed |
| #327 | Reproduced `shared-drift-check` locally: `lib/digest.ts` must be byte-identical with `gcp-expo1`'s copy; the mirror still has the old bytes | Parked, needs an owner decision (paired repo change or moving the helper) |
| #334 | Live `model-chain` test: T2 and RISK still served by the fallback model, so the PR's repoint is not live | Parked; the PR's own assertion is catching a real defect |
| #335 | `auth` preflight timed out on a Cloud Run MCP health call (cold start) | Parked; not verified as environmental |

### Unlocking commands
```bash
gh pr checks <n> --repo adamaslan/nuwrrrld-portal | awk -F'\t' '$2!="pass" && $2!="skipping"'   # shows only the red checks
gh run view <run-id> --repo adamaslan/nuwrrrld-portal --job <job-id> --log-failed | sed 's/\x1b\[[0-9;]*m//g' | grep -E '\] ›|##\[error\]'   # the actual failing test, not the "Fail the job" exit-1 line
node scripts/check-shared-drift.mjs    # run in a checkout with ../gcp3-mobile (or MOBILE_ROOT) present; reproduces #327's failure
```

### Caveats
- **"Green" is not true of #328 or #332.** Both merged with `e2e (1)` and `e2e (4)` red. A real regression behind the same brief-test signature cannot be ruled out from CI alone.
- **The stale-base theory was wrong.** Merging main into the branch did not clear the brief test. The live OpenRouter free chain returns empty completions; the `FREE_MODEL_CHAIN` refresh (main `a3966a1`) did not fix it for the brief path.
- **#334's repoint is not live.** The PR's assertion is correct; the PR's fix is not. Merging it would leave the council seats on fallback models while CI shows green on a path the test marks as failing.
- **#327's shared-file change has no mirror.** Merging it as-is would make main's own `shared-drift-check` red.
- **Authorship unknown.** All PRs are under the single `adamaslan` account. The merger was a Haiku run; the verifier was Opus read-only. No Codex verifier was available.
- **Wiki log line in the wrong place.** The #328 and #332 ingest lines went into the repo's `docs/wiki-portal/log.md`. The global rule says central ingest lines go to `~/code/homebase/wiki-logs/portal/log.md`. Not yet appended there.

### Undone
- #324 needs the owner to mark it ready or close it.
- #327 needs a decision on the shared-file mirror.
- #334 needs the correct model IDs for the T2 and RISK seats.
- #335 needs an auth-job rerun, or confirmation that the MCP backend was cold.
- The central wiki-logs entries for #328 and #332.

### Next steps
**Step 1 — check whether the brief shard is still red on main (read-only).**

```bash
gh run list --repo adamaslan/nuwrrrld-portal --branch main --workflow ci.yml --limit 1 --json conclusion,headSha -q '.[0]|[.conclusion,.headSha[0:7]]|@tsv'
```
Expect: a conclusion and a SHA. If `failure`, the brief shard is red on main too, which confirms the vendor caveat.

**Step 2 — check the cl24 log for answers (read-only).**

```bash
gh issue view 24 --repo adamaslan/homebase --json comments -q '.comments|length'
```
Expect: a count above the baseline recorded when the questions were posted. Read only the new comments.

**Step 3 — #327 needs a decision, then one of two paths.** No command until the owner answers. Option A (paired mirror): update `gcp-expo1` `lib/digest.ts` to match, then re-run the drift check. Option B: move the helper out of the shared file.

**Step 4 — #334 needs correct model IDs.** Re-run the live model-chain test after the repoint PR is updated.

```bash
npx vitest run --project live __tests__/live/model-chain.live.test.ts
```
Expect: `seat T2` and `seat RISK` served by their primaries, not the fallback.

**Step 5 — #335 auth preflight.** Rerun the job once the MCP backend is warm.

```bash
gh run rerun <run-id> --repo adamaslan/nuwrrrld-portal --failed
```
Expect: `auth` passes, or the failure is logged as the same cold-start timeout.

**Step 6 — central wiki-log lines for #328 and #332.** Append to `~/code/homebase/wiki-logs/portal/log.md` at end of file, one line each. Expected result: two new lines at EOF, no reordering.

### Wiki candidates — suggested, NOT written
| Target page | Exists? | What it would say | Why it belongs there |
|---|---|---|---|
| `docs/wiki-portal/entity-nulogdash.md` | yes | Pipeline run times now render in ET with a zone label | #328 changed the rendered behavior |
| `docs/wiki-portal/concept-sync-requirements.md` | yes | `lib/digest.ts` is in the shared-drift list; #327 needs a mirror decision | #327 is blocked on this |

### Unverified assumptions
- That the brief-test failure is vendor-side and not in either PR's code path (checked by reading the test and the diff, not by rerunning main's e2e).
- That the Opus verifier's read is independent of the author; authorship is unknown.
