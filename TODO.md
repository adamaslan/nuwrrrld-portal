# NuWrrrld portal — canonical TODO index

Last reconciled: **2026-10-11** (America/New_York)

This is the single entry point for unfinished work in this repository. Detailed
designs and runbooks remain in their source documents; this file links them so
they do not have to be copied and allowed to drift.

Repository work is governed by [`AGENTS.md`](AGENTS.md). Its Next.js,
delegation, security-boundary, and session-budget rules apply to every item in
this index.

## How to use this file

- Update this file when a TODO document, session handoff, or GitHub issue adds,
  closes, or materially changes work.
- Treat the sections below as the priority queue. Treat linked source documents
  as implementation detail and evidence.
- Do not count unchecked boxes as distinct tasks. The 370 boxes found in 29
  Markdown files include duplicates, acceptance checklists, historical incident
  follow-ups, and work owned by other repositories.
- `TODO2.md`, `TODO3.md`, and `TODO4.md` are completed pending-signal history,
  not active backlogs.

## Working rules from AGENTS.md

- Before changing Next.js code, read the relevant guide under
  `node_modules/next/dist/docs/`; do not rely on remembered APIs or conventions.
- Keep one unit of work to one branch and one session. Finish and hand it off
  before starting the next priority from this file.
- Use delegation for bulk discovery, mechanical edits, and diff review when
  available, but keep architecture and root-cause decisions in the main
  session.
- Keep auth, sessions, CSRF, rate limits, cryptography, webhook signatures, DB
  migrations/schema SQL, and `lib/pipeline-db-guard.ts` in the main session and
  require confirmation where `AGENTS.md` calls for it.
- Subagents must not commit, push, open PRs, or touch `.env*`; the main session
  owns git and external mutations.
- Prefer focused reads (`rg`, `head`, and bounded `sed`) and summarized logs.
  Write a real handoff before context grows too large or a session goes idle.

### Process TODOs

- [ ] Replace repeated `.claude/session-gaps.md` stub entries with a reliable
  handoff at the end of each active branch/session.
- [ ] At the start of each implementation item, record the exact source TODO,
  relevant caveat, branch, and verification target in the session handoff.
- [ ] Before closing an implementation item, review its diff and update this
  index plus the detailed source document in the same branch.

## Working this file with agents

Rules live in [`AGENTS.md`](AGENTS.md) (tiers, delegation, session budget). In short:

- **One item = one branch = one session.** Take the top unclaimed item in *Now*,
  or in *Next* when *Now* is blocked. Don't batch two items into one session.
- **Read only the queue**, not the inventory tables below. They are for audits:

  ```bash
  sed -n '/^## Now/,/^## GitHub issue rollup/p' TODO.md
  ```
- **The tag picks the lead tier** for the session:

  | Tag | Lead | Claude Code | Codex / GPT |
  |---|---|---|---|
  | `J` | Judgment: root cause, decisions, sensitive surfaces | Opus 5.5 | `gpt-6-astra` / `gpt-6.1-sol` high |
  | `W` | Workhorse: fix from a known cause, tests, ports | Sonnet 5.5 | `gpt-6.1-sol` |
  | `C` | Cheap: triage, log reading, reconciling lists | Haiku 5.5 | `gpt-6-luna` |
  | `H` | 🖱 Human: dashboard, secret, signature, or decision | — | — |
  | `X→Y` | Start in X (e.g. decide or investigate), then hand the rest to Y | | |

  A `W` or `C` session that discovers a sensitive surface (auth, Clerk/Stripe
  webhooks, DB migrations, `lib/pipeline-db-guard.ts`) stops and re-tags the item `J`.
- **Claim before starting** so a parallel agent (Claude or Codex) skips it: append
  `— *claimed <branch>, <YYYY-MM-DD>*` to the item, and do the work in its own worktree.
- **On finish**, check the box, link the PR, and keep the line until the next reconcile.
  Leave a 2–3 line note under the item if anything is left over.

## Now — production and pipeline health

- [ ] `W` Finish the public council sample cold-path fix — PR #285 adds the
  nightly stored-card producer and 26-hour persisted read; #281 already removed
  model calls from the public request. Focused tests pass. Await independent
  Claude verification and a scheduled producer run after merge before marking
  production behavior verified. Source: `docs/pain-points-100-2026-10-13.md` #26.
- [x] `W` Fix the missing dependency install in `compile-grounding-pack` —
  landed on `main` in PR #253 (`00ccb4e`). A branch dispatch
  [succeeded](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/38096257723)
  with `npm ci` and the driver-resolution check. No duplicate change was added
  to this older feature branch.
- [ ] `W` Verify the next `compile-grounding-pack` run from post-merge `main`,
  then close the stale failure issues through
  [#259](https://github.com/adamaslan/nuwrrrld-portal/issues/259). Do not trigger
  an extra run casually: compilation may spend up to 40 model calls. Separately
  investigate the successful branch run's 37/40 extraction timeouts.
- [x] `W` Fix and verify the Neon-to-SQLite backup — PR #248 (`a7feba07`) added
  the missing `ticker_cards.is_final`/`observed_at` schema parity. Scheduled run
  [38128838447](https://github.com/adamaslan/nuwrrrld-portal/actions/runs/38128838447)
  succeeded on 2026-10-11 with 50 tables, 517,763 rows, and an uploaded artifact.
- [ ] `W` Close the obsolete backup failure issues through
  [#250](https://github.com/adamaslan/nuwrrrld-portal/issues/250) now that the
  scheduled `main` run is green.
- [ ] `J` Investigate the afternoon pipeline failure in
  [#252](https://github.com/adamaslan/nuwrrrld-portal/issues/252). Reconcile the
  older claim that four routes are absent against current code before building.
- [ ] `J` Resolve or formally close [#111 nightly hydration](https://github.com/adamaslan/nuwrrrld-portal/issues/111)
  and [#114 stale ranked universe](https://github.com/adamaslan/nuwrrrld-portal/issues/114).
- [ ] `C` Triage every family in [GitHub issue rollup](#github-issue-rollup). Close
  obsolete duplicates only after the underlying workflow is verified green.
- [ ] `C` Reconcile the two failing and two degraded workflows in
  [`docs/pipeline-health-2026-10-11.html`](docs/pipeline-health-2026-10-11.html)
  with GitHub issues and this queue.

## Next — release blockers and operator actions

- [ ] `J+H` Complete Clerk production instance, MFA, session-policy, and browser
  verification work. Sources: [`docs/clerk-todos.md`](docs/clerk-todos.md),
  [`docs/clerk-dev-to-prod.md`](docs/clerk-dev-to-prod.md), and
  [`docs/manual-setup-todo.md`](docs/manual-setup-todo.md).
- [ ] `J+H` Finish Stripe validation: rotate/verify the secret, verify the live annual
  price, configure the webhook, and test signup plus downgrade. Sources:
  [`docs/stripe-price-consolidation.md`](docs/stripe-price-consolidation.md) and
  [`docs/manual-setup-todo.md`](docs/manual-setup-todo.md).
- [ ] `J+H` Create and use a non-production Neon branch for local live-run testing;
  keep `PRODUCTION_DB_HOST` armed so production writes are refused.
- [ ] `H` Restore/verify required production secrets and external monitoring,
  including the cross-repo `signals-app` OpenRouter secret where still absent.
- [ ] `W` Re-run authenticated browser checks after Clerk/Stripe configuration.
  Source: [`playwright-todo.md`](playwright-todo.md).
- [ ] `H` Finish privacy/compliance decisions and work: analytics and processor
  DPAs, LLM-provider terms, retention enforcement, policy rewrite, mobile
  consent/DSAR parity, and qualified review. Sources:
  [`docs/todo-auth-cookies-tracking.md`](docs/todo-auth-cookies-tracking.md),
  [`docs/privacy-register.md`](docs/privacy-register.md), and
  [`docs/todo-attribution-sync-followups.md`](docs/todo-attribution-sync-followups.md).

## Product and engineering backlog

- [ ] `W` Ship or explicitly defer landing-page Phase 3/4 in
  [`LANDING-REVAMP.md`](LANDING-REVAMP.md).
- [ ] `J` Decide and implement the market-snapshot plan in
  [`docs/market-snapshot-demotion-todo.md`](docs/market-snapshot-demotion-todo.md).
- [ ] `J→W` Build watchlist CSV import after deciding the 1,500-symbol cap/tiering.
  Source: [`docs/watchlist-csv-upload-plan.md`](docs/watchlist-csv-upload-plan.md).
- [ ] `J` Complete signal-engine parity/quality gates: one confluence contract,
  shared constants, quality reasons, universe coverage, and one live host.
  Sources: [`docs/signal-engine-three-phase-plan.md`](docs/signal-engine-three-phase-plan.md)
  and [`docs/signal-engine-parity-across-hosts.md`](docs/signal-engine-parity-across-hosts.md).
- [ ] `W` Complete paper-trading follow-ups: seat tilts, realistic/partial fills,
  history mirrors, gate tests, and the first written finding. Sources:
  [`docs/paper-portfolios-remaining-todo.md`](docs/paper-portfolios-remaining-todo.md)
  and [`docs/ai-paper-trading-report-2026-09-26.md`](docs/ai-paper-trading-report-2026-09-26.md).
- [ ] `W` Complete NWF4 follow-ups: SIP bars, card history, `live_prices.source`,
  backfills, full-day schedule verification, PR #241 disposition, and old
  wiki-lint errors. Source: [`docs/session-summary-2026-10-08-nwf4-jobs.md`](docs/session-summary-2026-10-08-nwf4-jobs.md).
- [ ] `C→J` Reassess the older MOO/import plans against current code before execution:
  [`docs/moo-council-simulation-todo.md`](docs/moo-council-simulation-todo.md),
  [`docs/moo-todo.md`](docs/moo-todo.md), and
  [`docs/nuwrrrld-portal-import/launch-todo.md`](docs/nuwrrrld-portal-import/launch-todo.md).

## GitHub issue rollup

Read-only `gh issue list` snapshot on 2026-10-11: **75 open issues** in the 14
families below. Links point to the newest issue in each family.

| Open | Family | Newest |
|---:|---|---:|
| 15 | Scheduled grounding-pack compile failed | [#259](https://github.com/adamaslan/nuwrrrld-portal/issues/259) |
| 1 | Afternoon pipeline failed | [#252](https://github.com/adamaslan/nuwrrrld-portal/issues/252) |
| 4 | Daily Neon→SQLite backup failed | [#250](https://github.com/adamaslan/nuwrrrld-portal/issues/250) |
| 4 | Nightly AI precompute failed | [#237](https://github.com/adamaslan/nuwrrrld-portal/issues/237) |
| 5 | Followed-tickers daily tracking failed | [#230](https://github.com/adamaslan/nuwrrrld-portal/issues/230) |
| 3 | Followed-tickers weekly judge failed | [#214](https://github.com/adamaslan/nuwrrrld-portal/issues/214) |
| 1 | Followed-tickers monthly selection failed | [#209](https://github.com/adamaslan/nuwrrrld-portal/issues/209) |
| 24 | Paper portfolios settle failed | [#202](https://github.com/adamaslan/nuwrrrld-portal/issues/202) |
| 4 | Paper portfolios preclose failed | [#195](https://github.com/adamaslan/nuwrrrld-portal/issues/195) |
| 3 | Weekly free-model chain refresh failed | [#192](https://github.com/adamaslan/nuwrrrld-portal/issues/192) |
| 7 | Paper portfolios midday failed | [#179](https://github.com/adamaslan/nuwrrrld-portal/issues/179) |
| 2 | Weekly grounding-pack compile failed | [#146](https://github.com/adamaslan/nuwrrrld-portal/issues/146) |
| 1 | Ranked universe is stale | [#114](https://github.com/adamaslan/nuwrrrld-portal/issues/114) |
| 1 | Nightly universe hydration is failing | [#111](https://github.com/adamaslan/nuwrrrld-portal/issues/111) |

## Memory and handoff audit

- `.claude/session-gaps.md` is a repeated automatic stub log, not a reliable
  backlog. It has no unique implementation task beyond handoff discipline.
  Some entries are dated 2026-10-12 although this audit date is 2026-10-11;
  treat that as a clock/automation anomaly, not future project state.
- [`docs/session-handoff.md`](docs/session-handoff.md) is an August auth/cookies
  snapshot. Its remaining work is represented above through current Clerk,
  privacy, attribution, and manual-setup sources.
- [`docs/todo-sept4.md`](docs/todo-sept4.md) is useful history, but its issue and
  PR claims must be rechecked before action.
- `docs/wiki-portal/` is durable design/incident memory. Its open checkboxes are
  indexed below; incident pages are not a second priority queue.

## Caveat register

Caveats are append-only warnings about work that shipped or was investigated;
they are not automatically actionable TODOs. Read the relevant caveat before
resuming its area of work. The canonical caveat index is
[`docs/caveats/README.md`](docs/caveats/README.md).

| Date | Caveat | Why it matters to the backlog |
|---|---|---|
| 2026-09-14 | [`council-paper-portfolios-db-safety`](docs/caveats/2026-09-14-council-paper-portfolios-db-safety.md) | Production-vs-development DB safety was not established before paper-portfolio work. |
| 2026-09-15 | [`paper-portfolios-phase4-5-6`](docs/caveats/2026-09-15-paper-portfolios-phase4-5-6.md) | Work existed on unmerged branches and had no live Neon/OpenRouter/Firestore verification. |
| 2026-09-15 | [`portfolio-liveness-watchlist-fix`](docs/caveats/2026-09-15-portfolio-liveness-watchlist-fix.md) | The fix merged while unrelated CI secret failures remained. |
| 2026-09-27 | [`engine-concurrent-session-collision`](docs/caveats/2026-09-27-engine-concurrent-session-collision.md) | An unidentified second process pushed to the same branch/worktree; verify ownership and branch state before related work. |

## Other TODO-like Markdown sources

The checkbox inventory below catches only literal `- [ ]` tasks. These named
plans, roadmaps, status reports, audits, reviews, blocker lists, and handoffs can
also contain unfinished work expressed as prose. They are included here so a
future audit does not miss them.

### Explicit TODO and next-step files

- [`TODO2.md`](TODO2.md), [`TODO3.md`](TODO3.md), and [`TODO4.md`](TODO4.md) —
  completed pending-signal history.
- [`docs/todo1.md`](docs/todo1.md) and [`docs/todo-sept4.md`](docs/todo-sept4.md)
  — older consolidated snapshots; revalidate claims before acting.
- [`docs/stripe-todo.md`](docs/stripe-todo.md),
  [`docs/portfolio-health-todo.md`](docs/portfolio-health-todo.md), and
  [`docs/pipeline-todo-blockers.md`](docs/pipeline-todo-blockers.md) — named
  TODO/blocker files without literal unchecked boxes in the current scan.
- [`docs/e2e-next-steps.md`](docs/e2e-next-steps.md) — browser/CI follow-ups.

### Plans and roadmaps

- [`docs/admin-totp-plan.md`](docs/admin-totp-plan.md),
  [`docs/beta-testers-robust-plan.md`](docs/beta-testers-robust-plan.md),
  [`docs/session-gaps-consent-plan.md`](docs/session-gaps-consent-plan.md), and
  [`docs/nwf-lab-finnhub-streamlit-plan.md`](docs/nwf-lab-finnhub-streamlit-plan.md).
- [`docs/openrouter-migration-and-db-parity-plan.md`](docs/openrouter-migration-and-db-parity-plan.md),
  [`docs/full-sync-plan.md`](docs/full-sync-plan.md), and
  [`docs/full-sync-roadmap.md`](docs/full-sync-roadmap.md).
- [`docs/nwf4-backfill-and-confluence-roadmap.md`](docs/nwf4-backfill-and-confluence-roadmap.md),
  [`docs/nulogdash-admin-console-plan.md`](docs/nulogdash-admin-console-plan.md),
  and [`docs/nulogdash-dashboard-plan.md`](docs/nulogdash-dashboard-plan.md).
- [`docs/Recent Docs/nuwrrrld-10x-robustness-plan.md`](docs/Recent%20Docs/nuwrrrld-10x-robustness-plan.md)
  — strategy input, not automatically committed scope.

### Status, issues, audits, reviews, and reports

- [`docs/known-bugs.md`](docs/known-bugs.md),
  [`docs/pipeline-route-status-issues.md`](docs/pipeline-route-status-issues.md),
  [`docs/modal-pipeline-status.md`](docs/modal-pipeline-status.md), and
  [`docs/free-model-rotation-status.md`](docs/free-model-rotation-status.md).
- [`docs/nuwrrrld-portal-import/modal-pipeline-issues.md`](docs/nuwrrrld-portal-import/modal-pipeline-issues.md),
  [`docs/holdfold-frontend-capacity-audit.md`](docs/holdfold-frontend-capacity-audit.md),
  and [`docs/docs-inventory.md`](docs/docs-inventory.md).
- [`docs/free-model-pr-review.md`](docs/free-model-pr-review.md),
  [`docs/review-pr-233-modal-backend.md`](docs/review-pr-233-modal-backend.md),
  and [`docs/openrouter-integration-report.md`](docs/openrouter-integration-report.md).
- [`docs/session-summary-e2e-feature-sweep.md`](docs/session-summary-e2e-feature-sweep.md),
  [`docs/session-handoff.md`](docs/session-handoff.md), and
  [`docs/local-pipeline-runs-and-html-reports.md`](docs/local-pipeline-runs-and-html-reports.md).

Files already named in the active queue or literal-checkbox inventory are not
repeated in this section merely because their filenames also contain `plan`,
`roadmap`, `report`, `audit`, or `summary`.

## Complete Markdown TODO inventory

Counts are literal unchecked boxes on 2026-10-11. This is the exhaustive map
of every other Markdown file containing one, including historical/cross-repo
work; it intentionally excludes this canonical index's deduplicated queue.

| Open | Source |
|---:|---|
| 6 | [`LANDING-REVAMP.md`](LANDING-REVAMP.md) |
| 3 | [`docs/admin-console-todo.md`](docs/admin-console-todo.md) |
| 9 | [`docs/ai-paper-trading-report-2026-09-26.md`](docs/ai-paper-trading-report-2026-09-26.md) |
| 6 | [`docs/clerk-dev-to-prod.md`](docs/clerk-dev-to-prod.md) |
| 11 | [`docs/clerk-todos.md`](docs/clerk-todos.md) |
| 5 | [`docs/cloud-only-mode.md`](docs/cloud-only-mode.md) |
| 49 | [`docs/manual-setup-todo.md`](docs/manual-setup-todo.md) |
| 15 | [`docs/market-snapshot-demotion-todo.md`](docs/market-snapshot-demotion-todo.md) |
| 26 | [`docs/moo-council-simulation-todo.md`](docs/moo-council-simulation-todo.md) |
| 9 | [`docs/moo-todo.md`](docs/moo-todo.md) |
| 4 | [`docs/nuwrrrld-portal-audit.md`](docs/nuwrrrld-portal-audit.md) |
| 56 | [`docs/nuwrrrld-portal-import/launch-todo.md`](docs/nuwrrrld-portal-import/launch-todo.md) |
| 4 | [`docs/paper-portfolios-remaining-todo.md`](docs/paper-portfolios-remaining-todo.md) |
| 15 | [`docs/portfolio-health-fix-plan.md`](docs/portfolio-health-fix-plan.md) |
| 3 | [`docs/privacy-register.md`](docs/privacy-register.md) |
| 31 | [`docs/roadmap-3-month.md`](docs/roadmap-3-month.md) |
| 12 | [`docs/signal-engine-parity-across-hosts.md`](docs/signal-engine-parity-across-hosts.md) |
| 16 | [`docs/signal-engine-three-phase-plan.md`](docs/signal-engine-three-phase-plan.md) |
| 5 | [`docs/stripe-price-consolidation.md`](docs/stripe-price-consolidation.md) |
| 7 | [`docs/todo-attribution-sync-followups.md`](docs/todo-attribution-sync-followups.md) |
| 38 | [`docs/todo-auth-cookies-tracking.md`](docs/todo-auth-cookies-tracking.md) |
| 9 | [`docs/watchlist-csv-upload-plan.md`](docs/watchlist-csv-upload-plan.md) |
| 3 | [`docs/wiki-portal/incident-2026-07-27-stripe-checkout-invalid-header.md`](docs/wiki-portal/incident-2026-07-27-stripe-checkout-invalid-header.md) |
| 3 | [`docs/wiki-portal/incident-2026-08-06-bugmerge1-command-file-loss.md`](docs/wiki-portal/incident-2026-08-06-bugmerge1-command-file-loss.md) |
| 4 | [`docs/wiki-portal/incident-2026-08-16-stash-recovery-and-cross-repo-drift.md`](docs/wiki-portal/incident-2026-08-16-stash-recovery-and-cross-repo-drift.md) |
| 3 | [`docs/wiki-portal/incident-2026-08-31-clerk-dev-handshake-redirect-loop.md`](docs/wiki-portal/incident-2026-08-31-clerk-dev-handshake-redirect-loop.md) |
| 4 | [`docs/wiki-portal/incident-2026-09-03-nightly-hydration-dead-15-days.md`](docs/wiki-portal/incident-2026-09-03-nightly-hydration-dead-15-days.md) |
| 6 | [`nextphase.md`](nextphase.md) |
| 8 | [`playwright-todo.md`](playwright-todo.md) |
| **370** | **Total in 29 source files** |

## Maintenance

- Re-run the Markdown inventory and GitHub issue rollup whenever this file is
  materially updated.
- When a source plan is complete, mark/archive it and remove it from active
  sections without deleting history.
- Keep one family entry for repeated automated issues; close duplicates only
  after verification.
