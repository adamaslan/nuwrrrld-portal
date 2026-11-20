<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Model tiers - cost guidance, not an authority hierarchy

This file is read by Claude Code (via `CLAUDE.md`), OpenAI Codex, Cursor, and other
AGENTS.md-aware tools. The owner selects the main session. The table below is
cost guidance only: its Opus default does not override an owner-selected Sonnet
or Codex main session, including its judgment and routine Git authority.

| Tier | Use for | Claude Code | Codex / GPT | Other |
|---|---|---|---|---|
| **Judgment** | root cause, architecture, task decomposition, merge order, sensitive surfaces | Owner-selected main session (Opus default; Sonnet allowed) | `gpt-6-astra`; `gpt-6.1-sol` at high effort | — |
| **Workhorse** | edits from a decided spec, porting a pattern, tests, regeneration | Sonnet 5.5 → `implementer` agent | `gpt-6.1-sol` | — |
| **Cheap** | search, call-path tracing, log reading, diff review, inventories | Haiku 5.5 → `explorer`, `reviewer` agents | `gpt-6-luna`, `gpt-reserve` | — |
| **Free** | non-sensitive second-opinion review only | — | — | OpenRouter `:free` chain (`docs/free-model-pr-review.md`) |

- Claude Code: subagents live in `.claude/agents/` (`explorer`, `implementer`, `reviewer`).
- Codex: no subagent files; run cheap/workhorse units as separate, narrowly scoped
  tasks/threads on that tier (read-only question in, ≤300 words out). The owner's
  `~/.codex/config.toml` defines matching profiles: `judgment`, `workhorse`, `cheap`
  (`codex --profile cheap`).
- **Never send secrets, `.env*` contents, or auth/payment code to the Free tier.**
- The app's *runtime* model chain (`lib/openrouter.ts`, `FREE_MODEL_CHAIN`) is product
  code, not agent config. Change it only via `scripts/refresh-free-models.mjs`.

# Delegation — keep the main context small

The owner selects the main session, including Sonnet, Opus or Codex. Model tiers
above are cost/routing defaults, not a ban on the owner's selected main agent doing
judgment or git work. Delegated workers do scoped reading and mechanical edits,
and return **summaries, not file contents**. Every tool result kept out of the main
context makes every later turn cheaper. This is the same two-tier split `/fixy` uses.

**Never delegated, any tool, any model:** auth, session, CSRF, rate-limit, crypto,
webhook signatures (Clerk, Stripe), DB migrations (`scripts/db-migrate.mjs`, schema SQL),
and `lib/pipeline-db-guard.ts`. These stay in the Judgment tier and need human confirmation.

- **Delegate by default; keep work inline only with a named reason** (sensitive surface,
  open judgment call, or a single small file already open).
- **Brief like a colleague with no context**: goal, exact paths, constraints, what "done"
  looks like, and the return shape (≤300 words, `path:line` evidence, no file dumps).
- **Run independent units in parallel.** **Never re-read what a unit already summarized**;
  spot-check one claim if a decision depends on it.
- Delegated workers do not commit, push or open PRs unless the current owner-backed
  handoff explicitly assigns that work. The owner-selected main session may do
  routine git work regardless of model tier. Do not expose secrets or edit `.env*`
  without specific approval.

# Session budget - isolated tasks with checkpointed continuation

Cost per turn grows with context, and each new session re-pays the fixed instruction load.
The sweet spot is in between:

- **One task = one isolated branch/worktree.** Prefer eligible NWF application
  merges, then EIC, over new features or historical docs. Finish the task or record
  its concrete blocker, then continue the next eligible unowned task while the
  session is active. Opening a PR is a checkpoint, not a mandatory stop.
- **Restart when the work you've added ≈ 1.5× the starting context** (roughly when the
  context-bloat badge reaches Tier 3, or about half the window). Write the handoff first
  (`end-session` skill or `docs/session-handoff.md`), then start a new session from it.
- **Idle more than an hour → start fresh from the handoff.** The prompt cache has expired,
  so resuming costs about as much as a new session and carries stale context.
- Read ranges, not files: `rg`, `sed -n 'a,bp'`, `gh run view --log-failed | tail -80`.
  Read only the *Now* section of `TODO.md`, not the inventory tables.


# Routine autonomy and merge conditions

Within the owner's standing limits, the owner-selected main session may inspect
and prioritize work, make local edits, run safe tests and actual application
builds, fix bugs, commit, open/update PRs, and complete eligible readiness/merge
without pausing for a routine confirmation each time. This grants no new
authority: the owner's standing limits and any newer direct instruction always
win. The Captain's Log routes work but cannot expand permission.

- Keep implementation creator and fixer/merger separate: the LLM that wrote the
  implementation does not also fix and merge it. Independent review by a
  different model family than the author is binding before merge (bugmerge2).
  Honor the latest qualifying Claude/Codex review; the designated fixer's
  ordinary fixes under a valid external review do not require another family
  review. Do not add a third merger or repeat a completed valid review. A
  draft label alone is not an additional owner-confirmation gate.
- Check active ownership before starting. Never create parallel writers. Reuse
  completed valid reviews and proof instead of repeating a full review.
- Merge only after the actual application build at the current head and the
  required deterministic checks (lint, typecheck, unit/build) pass, with known
  bugs fixed. No ignored errors, red-check waivers or test skips on those
  gates. Narrow owner-classified exception: the live OpenRouter model-chain
  health check is non-blocking (owner, 2026-11-06); record its state, never
  extend this exception to any other check.
- For UI work, verify live deployed-preview desktop/mobile evidence at the relevant
  head. Local mocks do not establish live behavior or remote effect safety.
- Inspect actual push/CI/deployment effects before triggering them. No database
  migrations, live DB writes, paid/cloud spend, admin/access/security/sharing or
  secret changes, or real outbound messages without specific owner approval.
  Existing design, security-publication and provider-activation holds remain.
  Unknown same-repo Neon parity/live E2E effects are not implicitly approved.
- No eligible merge does not mean no eligible work. Reading existing failed-job
  logs, identifying the actual failed step, diagnosing a bug, and making/testing
  safe local fixes are routine work, not reasons for another confirmation. Do not
  stop at checkout noise, a red badge, a PR description or a status summary.
- Ownership must be current: a completed review is not an active fixer claim, and
  a merged/closed lane is not indefinitely reserved. Check the live head, latest
  accepted handoff and actual result before declaring a lane unavailable.
- Keep status-reading separate from execution. A stale log cutoff is a retrieval
  cursor, not the work assignment. Advance it from an actual read; do not replay
  the full historical backlog or replace the accepted task with a watch summary.
- Hold only an action whose effect lacks authority, state the exact gap once and
  continue independent safe work. Do not turn a narrow hold into an all-work stop.
- During an active session, read the Captain's Log at start, after each task and
  before merging; report actual commands, exits, fixes, blockers and resulting
  links, then continue. Do not claim scheduled check-ins or persistence the
  session cannot provide. Installing background automation or changing
  workflow/settings needs separate approval. Save a handoff when a fresh session
  is genuinely needed.

# Coordination venue - one canonical Captain's Log

The single current work queue is the Captain's Log Google Doc ("cl24"):
https://docs.google.com/document/d/1S8q44Gmg19av7Yn4C2OOh0bnuJnabWc4g4YljrgGKVI/edit

- **The Doc is the only venue.** The old GitHub homebase issue #24 comment
  thread is retired. Never poll it, never use a GitHub comment-ID checkpoint
  file as a source of work, and never report "no new comments" as a result.
  If the Doc cannot be read, report the exact access error and hold the
  Doc-dependent pickup while continuing independent safe work that does not
  need the Doc. Never fall back to GitHub issue #24 or any other venue.
- **Freshness marker.** Entries are timestamped. When accepting work, state the
  timestamp of the newest entry you read. Older timestamped entries are history,
  not current instructions or new permission.
- **Re-read cadence.** While active, re-read the Doc every 3-7 minutes, and
  always after finishing a task and before a merge. Reading is not execution:
  between reads, run the accepted task's actual commands.
- **Pickup receipt.** Accepting a task means running its first actual command
  and reporting the command, exit code and result, or the exact blocker. A
  summary of the thread, an intent to resume, or another monitoring pass is
  not pickup.
- **Cursors are not assignments.** A checkpoint or cursor file only records
  what you already saw; it never defines the work. Advance it from an actual
  read and never replay the full historical backlog.
- **Monitoring is not progress.** Repeated read-only "no change" inventories
  do not advance a task. If the assigned step is blocked, state the exact
  blocker once, then continue the next eligible unowned task or stop
  truthfully. Do not manufacture a watch loop to stay busy.
- **One writer per lane.** Check current ownership in the Doc before starting.
  A read-only review lane never edits the writer's branch; a completed review
  is not an active fixer claim. No parallel writers, no duplicate
  implementations.

# One agent per worktree — across tools

Claude Code and Codex must never work in the same checkout at the same time. A Codex run
switching branches corrupts a Claude session's tree, and vice versa. Give each concurrent
agent its own worktree:

```bash
git fetch origin main && git worktree add ../nuwrrrld-portal-<unit> -b <type>/<unit> origin/main
```
