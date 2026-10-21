# NWF consolidated TODO — Terraform first

**Prepared:** 2026-10-20 (America/New_York)

**Scope:** Portal production health, the new pipeline slot, release gates, and NWF4.
**Status rule:** An unchecked item is a proposed or still-open gate, not a claim that nothing has been built. Recheck live state before changing infrastructure or closing a task.

This is a working queue synthesized from the ten entries in [the shortlist](nwf-todo-docs-shortlist-2026-10-20.md). Those entries name seven distinct documents because `TODO.md`, the GCP pipeline update, and the NWF4 roadmap appear twice. The repository's [canonical TODO](../TODO.md) remains the master index; reconcile completed items back into it. The 2026-10-19 task board and live PR search on 2026-10-20 supersede older status claims where they conflict.

## Work split — 2026-10-20

| Assignee | Items (11 each) | Focus |
|---|---|---|
| Codex A (this task) | T01–T04, P01–P03, P05, S01, N01–N02 | Terraform review, pipeline verification, and NWF4 first implementation stages |
| Codex B (separate worktree) | P04, P06, S02–S04, N03–N04, R01–R04 | Health/issue reconciliation, cutover and release gates, NWF4 operational checks |

Assignments do not mean completion. Each worker should update only its assigned tasks with evidence and leave approval or production gates open until they are actually satisfied.

## Current progress — 2026-10-21

- **Codex A / Terraform:** PR #292 is still draft at head `6537d108`. Its recorded plan is from 2026-10-17 (17 creates, 0 changes, 0 destroys); refresh it before any apply. The PR body records Claude's independent verification on 2026-10-17 with no blockers. The latest listed CI has a failing E2E shard for the real dashboard brief call; it is not a Terraform check. No apply was run. Static inspection confirms the project guard is fixed to `ttb-lang1`, protected resources use `prevent_destroy`, cleanup remains dry-run, and WIF is scoped to the numeric repository and configured ref. T01/T02 stay open for the fresh plan and exact approval gate.
- **Codex A / hydration:** Scheduled run [#39523318736](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/39523318736) failed on October 20 with “Alpaca shared budget unavailable,” zero cards written, and 1,033 post failures. In branch `codex/nwf-consolidated-a`, `lib/alpaca-budget.mjs` now maps AWS CLI errors to allow-listed diagnostic categories (missing/invalid credentials, access denied, missing table, throttling, network, timeout, missing CLI, capacity exhaustion, or unknown) while continuing to suppress raw stderr. Added classification coverage; targeted budget tests pass (13 tests). This does not prove which AWS failure occurred or restore hydration; a rerun with the new log category and runtime/operator checks are still required. No secret values were read. P01/T03 remain open.
- **Codex A / afternoon pipeline:** The four intended routes remain absent from the current main snapshot and issue [#252](https://github.com/adamaslan/nuwrrrld-portal/issues/252) remains open. Recent green runs completed in 7–11 seconds; verify the gate outcome before treating them as execution. P02 remains open pending a route-versus-retirement decision.
- **Codex A / run status:** PR [#260](https://github.com/adamaslan/nuwrrrld-portal/pull/260) merged on October 11, so the October 16 audit's branch-only status is stale. Hydration run #39523318736 wrote a failure status, but live NULL-status counts across all pipelines still need verification. P03 remains open.
- **Codex B / alerts and backlog:** In the separate worktree, Codex B verified PR #271 is merged, grounding recovery closed #203 and #193, older #268 remains open, and hydration failure #39523318736 appended a comment to open issue #282. Recent backup, precompute, paper-portfolio, and followed-ticker runs were successful. P04/P06 remain open pending stale-issue reconciliation and hydration diagnosis. Codex B's report and wiki edits are in branch `codex/nwf-consolidated-half`; they are not merged into this checkout.

## Priority 0 — Terraform and new slot foundation

**Current evidence:** [PR #292](https://github.com/adamaslan/nuwrrrld-portal/pull/292) is open with a Terraform foundation for a separately named slot in the existing billed `ttb-lang1` project. Its PR body reports a saved plan of **17 creates, 0 changes, 0 destroys**, a versioned GCS state bucket, validation passes, and **no apply**. The October 16 [GCP audit](gcp-pipeline-update-2026-10-16.md) described an unbilled dedicated project; PR #292 records the later owner choice to use `ttb-lang1`. Verify the PR head and a fresh plan before relying on either snapshot.

- [ ] **T01 — [Codex A] Finish PR #292 review and make the Terraform plan reviewable.** Confirm the target project and slot names, backend and state locking/recovery, resource ownership, IAM scope, WIF trust restriction, Secret Manager containers, artifact/image retention, budget implications, and isolation from `gcp3-backend`. Attach a fresh, sanitized plan summary showing creates/changes/destroys and resolve review findings. **Done when:** independent review is recorded and the plan's zero-destroy gate is explicit. Source: [PR #292](https://github.com/adamaslan/nuwrrrld-portal/pull/292), [GCP audit](gcp-pipeline-update-2026-10-16.md).
- [ ] **T02 — [Codex A] Decide the infrastructure apply gate.** Obtain the owner's approval of the exact saved plan and project before any `terraform apply`; confirm state backup/recovery and rollback steps. **Done when:** the approved plan can be tied to the applied commit and cloud resource inventory, or the PR is explicitly left unapplied. Source: [PR #292](https://github.com/adamaslan/nuwrrrld-portal/pull/292).
- [ ] **T03 — [Codex A] Prove the runtime dependencies before scheduling slot 2.** Provision and test branch-scoped Neon access, the shared Alpaca/DynamoDB rate budget dependency, runtime credentials, image delivery, and an operator-visible health endpoint. Merged PR #296 still says its worker must not be deployed or scheduled until these are addressed. **Done when:** a manual, bounded run writes only to the intended hydration branch and reports coverage/failure clearly. Sources: [PR #296](https://github.com/adamaslan/nuwrrrld-portal/pull/296), the October 19 session board.
- [ ] **T04 — [Codex A] Reconcile the old dedicated project.** Record whether the unbilled project remains reserved or can be retired later; check quota and cost without deleting resources as part of this TODO. **Done when:** the project inventory and intended owner are documented. Source: [GCP audit](gcp-pipeline-update-2026-10-16.md), [PR #292](https://github.com/adamaslan/nuwrrrld-portal/pull/292).

## Priority 1 — Production pipelines and trustworthy health

- [ ] **P01 — [Codex A] Repair `hydrate-universe` and stale-card coverage.** Investigate the audit's 184 failures/14 days, partial runs, missing symbols, and current `ticker_cards` freshness; prove a full successful run and a red signal for insufficient coverage. Reconcile issues [#111](https://github.com/adamaslan/nuwrrrld-portal/issues/111) and [#114](https://github.com/adamaslan/nuwrrrld-portal/issues/114). Sources: [GCP audit](gcp-pipeline-update-2026-10-16.md), [canonical TODO](../TODO.md).
- [ ] **P02 — [Codex A] Fix the afternoon workflow's missing targets.** Decide whether to implement its four intended routes or retire the schedule after checking consumers. A green gate-skipped workflow is not proof of work. Reconcile [#252](https://github.com/adamaslan/nuwrrrld-portal/issues/252). Sources: [GCP audit](gcp-pipeline-update-2026-10-16.md), [manual setup](manual-setup-todo.md).
- [ ] **P03 — [Codex A] Verify run-ledger status after merged PR #260.** Check recent rows for NULL status across hydration, precompute, followed-ticker, and paper runs; investigate any residuals before closing. The old `origin/fix/pipeline-run-status` branch and October 16 audit predate PR #260. Source: [PR #260](https://github.com/adamaslan/nuwrrrld-portal/pull/260), [GCP audit](gcp-pipeline-update-2026-10-16.md).
- [ ] **P04 — [Codex B] Give every scheduled pipeline a truthful alert.** Measure missing runs, stale output, partial coverage, repeated failure, alert delivery, recovery, and issue deduplication. Include slot 2 services in health checks. Verify the deployed impact and threshold introduced by merged [PR #299](https://github.com/adamaslan/nuwrrrld-portal/pull/299). Sources: [atlas](nwf-app-atlas-and-100-pain-points.md), the October 19 session board, [manual setup](manual-setup-todo.md).
- [ ] **P05 — [Codex A] Reconcile schedulers and costs.** Inventory active GitHub Actions, Modal, GCP Scheduler, and Vercel jobs; identify duplicate writers and missing routes; inspect current retry settings and premarket warmup failures before proposing live changes. Verify budget alarms and operating cost after Terraform. Source: [GCP audit](gcp-pipeline-update-2026-10-16.md), [atlas](nwf-app-atlas-and-100-pain-points.md).
- [ ] **P06 — [Codex B] Clear the issue backlog by evidence.** Verify the post-merge grounding-pack run, its extraction timeouts, the green backup run, and current paper/followed-ticker/precompute failures before closing duplicate issues. Source: [canonical TODO](../TODO.md).

## Priority 2 — Slot 2 product acceptance and cutover

- [ ] **S01 — [Codex A] Signals and ticker cards.** Continue the guarded portal reader and per-ticker fallback after worker [#296](https://github.com/adamaslan/nuwrrrld-portal/pull/296) merged on October 20; test freshness, rate limits, credentials, partial data, and live read behavior. No production cutover until the Terraform/runtime gates and end-to-end acceptance pass. Source: the October 19 session board.
- [ ] **S02 — [Codex B] Market brief, portfolio health, industry intelligence, and feedback.** Finish the local worktrees; test empty/stale/partial/upstream failures and actual deployed data or Discord delivery. Keep mobile release and Schwab broker status tracked with their owning app. Source: the October 19 session board.
- [ ] **S03 — [Codex B] Followed tickers, paper books, arena, and nightly writers.** Decide data/history migration, identify every writer and side effect, prove schedule and run logs, and choose whether the shadow engine moves or stops. Sources: the October 19 session board, [atlas](nwf-app-atlas-and-100-pain-points.md).
- [ ] **S04 — [Codex B] Promotion, rollback, and slot 1 retirement.** Choose the table-copy/role/snapshot strategy, rehearse rollback, prove portal and mobile reads, and obtain separate approval before disabling any old scheduler or resource. Source: the October 19 session board.

## Priority 3 — NWF4 shadow pipeline to measured promotion

**Verified baseline:** PR [#241](https://github.com/adamaslan/nuwrrrld-portal/pull/241) merged on 2026-10-09 according to the [roadmap](nwf4-backfill-and-confluence-roadmap.md); seven jobs were deployed and exercised, but news weight remains **0**. The October 8 [session record](session-summary-2026-10-08-nwf4-jobs.md) is historical and still says PR #241 was pending.

- [ ] **N01 — [Codex A] Build N1 history backfill in stages B0–B7.** Start with a dry-run cost/volume census. Add SIP daily bars including SPY, raw archive and provenance, ordered article load, existing scorers, aggregation, outcome labels, and fit/holdout metrics. Add the specified tracking schema only through the project's DB migration approval path. **Done when:** coverage and the promotion metrics are reproducible from historical sessions. Source: [NWF4 roadmap](nwf4-backfill-and-confluence-roadmap.md).
- [ ] **N02 — [Codex A] Wire N3 confluence at weight 0.** Implement the planned score reader, shared function and card fields through the DB migration gate; prove existing scores are byte-identical while weight is zero. Source: [NWF4 roadmap](nwf4-backfill-and-confluence-roadmap.md).
- [ ] **N03 — [Codex B] Decide N4 promotion only from measured evidence.** Require the roadmap's session/pair thresholds, two passing weekly evaluations, holdout results, and owner sign-off on the first nonzero weight. Source: [NWF4 roadmap](nwf4-backfill-and-confluence-roadmap.md).
- [ ] **N04 — [Codex B] Complete operating gaps.** Check a full market day's schedules, labeler and Saturday evaluator; add `live_prices` source/feed provenance through DB review; resolve old wiki lint findings. Do not re-open the deliberately disabled LLM scorer without a new owner decision. Sources: [session record](session-summary-2026-10-08-nwf4-jobs.md), [NWF4 roadmap](nwf4-backfill-and-confluence-roadmap.md).

## Priority 4 — Release, data, and product quality

- [ ] **R01 — [Codex B] Close human release gates.** Verify Clerk production login/MFA/session policy; billing configuration, webhook, signup and downgrade; external error and uptime monitoring; stored production access settings; privacy/vendor/retention decisions. Recheck the older [manual setup](manual-setup-todo.md) status before acting: some unchecked sections were later marked done or obsolete in its September 14 verification table. Source: [canonical TODO](../TODO.md).
- [ ] **R02 — [Codex B] Establish safe development data and backups.** Create a nonproduction Neon branch for local live runs, retain the armed production-host guard, test a restore from a Neon snapshot/backup, and choose archive retention. Sources: [manual setup](manual-setup-todo.md), the October 19 session board.
- [ ] **R03 — [Codex B] Resolve the atlas's highest-risk correctness gaps.** Define zero-data behavior for AI seats, reject declared-but-empty inputs, settle sector mapping and signal-score validation, identify the `pending_signals` drainer, and audit invoice ownership. Treat the 150 pain points as an inventory to verify, not 150 automatically open tickets. Source: [atlas](nwf-app-atlas-and-100-pain-points.md).
- [ ] **R04 — [Codex B] Reconcile remaining product plans.** Prioritize market snapshot, watchlist CSV limits, signal-engine parity, paper-trading quality, and landing-page work from the [canonical TODO](../TODO.md) after the production and cutover gates above.

## Pull requests to disposition

GitHub search on **2026-10-20** returned three open portal PRs. Verify checks and head commits at review time; a PR body or prior local worktree is not deployment evidence.

| Order | PR | Next action |
|---|---|---|
| 1 | [#292 — Terraform foundation](https://github.com/adamaslan/nuwrrrld-portal/pull/292) | Complete T01/T02. Review a fresh plan and explicit owner apply gate before promotion from draft. |
| 2 | [#298 — free-model chain refresh](https://github.com/adamaslan/nuwrrrld-portal/pull/298) | Check live probe validity, model pricing, CI, and whether a redeploy is needed. |
| 3 | [#300 — model usage report](https://github.com/adamaslan/nuwrrrld-portal/pull/300) | Check generated data window and any paid/empty/rescued model calls; merge only if the report is current and useful. |

**Merged since the prior task-board snapshot:** [#296 slot 2 hydration worker](https://github.com/adamaslan/nuwrrrld-portal/pull/296) merged October 20, but its deployment/runtime gates remain open under T03/S01.

**Referenced earlier PRs:** [#291 preflight](https://github.com/adamaslan/nuwrrrld-portal/pull/291), [#295 preflight follow-up](https://github.com/adamaslan/nuwrrrld-portal/pull/295), [#293 schedule consolidation](https://github.com/adamaslan/nuwrrrld-portal/pull/293), and [#297 model preflight](https://github.com/adamaslan/nuwrrrld-portal/pull/297) are reported merged in the October 19 board; [#241 NWF4](https://github.com/adamaslan/nuwrrrld-portal/pull/241) is reported merged in the roadmap. `gh pr view` confirmed [#290 Alpaca-first local pipeline](https://github.com/adamaslan/nuwrrrld-portal/pull/290) merged October 16 and [#299 card freshness](https://github.com/adamaslan/nuwrrrld-portal/pull/299) merged October 19 (New York time). Their deployment and outcome checks remain separate tasks. The October 19 board's open-PR list is a dated snapshot, not today's queue.

## Keeping this queue accurate

For each item, record an owner, branch/PR, latest evidence date, and explicit completion proof in the canonical TODO. Codex A implementation is in branch `codex/nwf-consolidated-a`; no PR has been opened yet. Close an item only after checking the running workflow, deployed route, database result, or user-facing behavior relevant to it. When two source documents disagree, keep both dates visible and verify current state before making a cloud or production change.
