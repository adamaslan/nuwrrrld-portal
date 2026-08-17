---
date: 2026-08-16
type: incident
tags: [git, stash, merge-conflicts, wiki-integrity, cross-repo, ci]
sources: [../../lib/nulogdash.ts, ../../app/dashboard/nulogdash/page.tsx, ../../lib/subscription.ts, ../../scripts/stash-status.mjs, ../../scripts/check-shared-drift.mjs, PR#60, gcp-expo1#36]
---

# Incident: Stashed Feature Work Recovery Produced a Silent Wiki-Log Duplication and a Cross-Repo Drift Gate Deadlock

## Date & severity

**2026-08-16** — Severity: **Moderate**. No data loss, no secrets exposed, no bad code reached `main`. Two distinct near-misses were caught before merge: a self-inflicted duplicate block in `log.md` (caught by manual full-file review, not tooling) and a real security-relevant auth bug in the recovered code (caught by test-driven review before the PR was even opened).

## What happened

A routine "create the admin HTML report" task surfaced that `NULOGDASH_ADMIN_EMAILS` gated a page (`app/dashboard/nulogdash`) that did not exist on disk. Investigation found the entire feature — the admin dashboard, a full component-testing layer (testing-library/jsdom/jest-axe), API hardening across `brief`/`holdfold`/`portfolio-health`, and five wiki pages of accumulated narrative — sitting untracked and uncommitted inside `stash@{0}` on branch `fix/stripe-checkout-hardening`, itself 15 commits stale against `origin/main`.

Recovery proceeded in stages across the session:

1. Applied the stash, reviewed the diff, ran the full verify loop (`tsc --noEmit`, `npm test`, `next build`), committed.
2. Found and fixed a real admin-gate bypass: `isNulogdashAdmin` read `emailAddresses[0]`, accepting unverified addresses and trusting array position over `primaryEmailAddressId`. Fixed with 22 pinned test cases, verified by reverting the fix and confirming 5 of them fail against the old logic.
3. Added `canPerformAdminAction()` — MFA gating layered on top of the identity check, kept as a separate function so read access degrades gracefully instead of an unexplained `notFound()`.
4. Attempted to rebase the resulting 5-commit branch onto `origin/main`. **This is where the incident happened.**

Rebasing 5 separate commits meant the same conflicting wiki pages (`log.md`, `concept-mobile-web-parity.md`, `concept-sync-requirements.md`, `index.md`) had to be conflict-resolved **once per commit**, since each commit in the original stack had touched them incrementally. Mid-way through the second conflict round, a mechanical `sed`/regex-based resolution attempt silently produced a duplicated block in `log.md` — the entire PR #45 incident writeup, plus three other log entries, appeared twice. This was only caught by explicitly reading the full resolved file rather than trusting `git diff` or the conflict-marker count.

## Root cause

**Primary — stale branch, incremental conflicts.** The branch's first commit was 15 commits behind `origin/main` by the time the stash was applied and committed on top. Every wiki page `main` had also updated in the interim (via its own subsequent PRs #48–#59) became a conflict at *every* commit in the stack that touched it, not just once. Resolving the same logical conflict 3–5 times, by hand, under time pressure, is exactly the condition under which a copy-paste or regex-substitution error slips through — which is what happened.

**Secondary — trusting partial diffs over full-file reads.** The duplication was invisible to `git diff --check` (no conflict markers remained) and to a quick `grep -c` on marker counts (also zero). It was only caught by reading the complete resolved file end-to-end and independently verifying section/heading counts. A faster, less careful resolution pass would have shipped a wiki with a doubled incident entry straight to `main`.

**Tertiary — cross-repo CI dependency not anticipated.** Once conflicts were resolved and the PR pushed, CI's `shared-drift-check` job failed: a real fix kept during conflict resolution (`lib/subscription.ts`'s `trialEnd` now only serializes while `status === 'trialing'`) made the portal's copy diverge from `gcp3-mobile`'s stale copy. The drift-check gate compares each repo's shared files against the *other repo's `main`* — so portal's check can't go green until mobile's fix is *merged*, and vice versa if mobile's own gate were checked first. This is a structural chicken-and-egg in a two-repo byte-identical CI gate that wasn't visible until it was hit live.

## Resolution

1. **Squash before rebase.** Once the duplication was caught and fixed, the entire 5-commit stack was squashed into one commit (`git reset --soft <base>`) before rebasing. This reduced "resolve the same wiki conflict N times" to "resolve it once" — eliminating the repeated-resolution surface that produced the bug in the first place. Confirmed via `git rebase --abort` + retry rather than patching forward on a tree already suspected of corruption.
2. **Full-file verification discipline.** Every wiki-page conflict resolution in the second (squashed) rebase pass was followed by a complete `Read` of the file plus an explicit duplicate-heading grep (`sort | uniq -d`) before staging — not just a marker-count check.
3. **CI-caught lint gap closed.** `npm run lint` is not part of the standard local verify loop (`tsc --noEmit` / `npm test` / `next build`); three unused test imports from the recovered stash content only surfaced on GitHub Actions. Fixed and pushed as a follow-up commit once caught.
4. **Cross-repo drift fixed at the source, not worked around.** Rather than reverting the `trialEnd` correctness fix to avoid the drift check, the same fix was ported byte-for-byte to `gcp3-mobile/lib/subscription.ts` (verified via local `tsc --noEmit` and a local run of `check-shared-drift.mjs` pointed at both branches) and opened as a companion PR (`gcp-expo1#36`). Portal's PR #60 was merged first since its own tests/lint/build were green and the branch was unprotected; mobile's drift check will clear once #36 merges against portal's now-updated `main`.

## Impact on design

- **`scripts/stash-status.mjs`** (added this session, `npm run stash:status`) now exists specifically so a stash holding real, uncommitted feature work doesn't go unnoticed for an unbounded period again — it surfaces base-branch existence, tracked/untracked file counts, and whether a stash predates the branch's own current HEAD.
- Confirms the existing `/bugmerge1` guidance ("resolve mechanical conflicts, but semantic/ambiguous ones → stop and report") generalizes to: **when a multi-commit branch's rebase would force the same conflict to be resolved more than once, squash first.** This should be added explicitly to that command's guardrails.
- Cross-repo drift gates (`check-shared-drift.mjs` on both `nuwrrrld-portal` and `gcp3-mobile`) have an inherent sequencing dependency neither repo's CI config currently documents: a fix to a shared file requires **both** PRs to exist before **either** drift check can pass, and the merge order matters (merge the side with otherwise-green CI first, since neither branch is protected).
- Reinforces [[concept-wiki-led-development]]'s premise that the wiki is a control surface, not passive documentation — a corrupted `log.md` merged to `main` would have actively misled the next cold-started agent reading it, not just been an aesthetic blemish.

## Open items

- [ ] Add "squash multi-commit branches before rebasing onto a stale base" to `/bugmerge1`'s guardrails, generalized from this incident (mirrors the earlier bugmerge1-command-file-loss pattern of promoting a one-off recovery into a systemic rule).
- [ ] Consider adding `npm run lint` to the standard local verification loop (alongside `tsc --noEmit`/`npm test`/`next build`) so CI-only lint failures like the three unused imports here stop reaching GitHub Actions before being caught locally.
- [ ] Document the cross-repo drift-gate merge-order dependency (this incident's "Root cause — Tertiary") in `concept-sync-requirements.md` or a dedicated concept page, since it will recur any time a shared file changes on one side first.
- [ ] Confirm `gcp-expo1#36` merges and re-check that `nuwrrrld-portal`'s `shared-drift-check` on `main` goes green retroactively (no action needed if so — CI on already-merged commits doesn't re-run automatically, but the next PR touching a shared file will confirm it).

## See also

- [[concept-wiki-led-development]] — the wiki-as-control-surface premise this incident's corruption risk threatened
- [[incident-2026-08-06-bugmerge1-command-file-loss]] — the prior incident in the same family (recovery-workflow git operations threatening the wiki/command layer itself), whose systemic-fix pattern (promote a one-off recovery into a rule) this incident's Open Items follow
- [[concept-sync-requirements]] — the shared-core de-drift tracking this incident's cross-repo fix contributes to
- [[entity-dev-command-suite]] — `/bugmerge1`, whose guardrails this incident's Open Items propose extending
- `gcp3-mobile/docs/wiki-mobile/` — the mobile-side mirror; the `lib/subscription.ts` fix and this incident should be cross-referenced there per the mobile-web-wiki-sync rule
