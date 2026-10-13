<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Model tiers — same rules for every coding agent

This file is read by Claude Code (via `CLAUDE.md`), OpenAI Codex, Cursor, and other
AGENTS.md-aware tools. Rules are written per **tier**, not per vendor.

| Tier | Use for | Claude Code | Codex / GPT | Other |
|---|---|---|---|---|
| **Judgment** | root cause, architecture, task decomposition, merge order, sensitive surfaces | Opus 5.5 (main session) | `gpt-6-astra`; `gpt-6.1-sol` at high effort | — |
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

The main session holds judgment. Lower tiers do the bulk reading and mechanical edits,
and they return **summaries, not file contents**. Every tool result kept out of the main
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
- Lower tiers never commit, push, open PRs, or touch `.env*`. The main session does git.

# Session budget — one unit of work per session

Cost per turn grows with context, and each new session re-pays the fixed instruction load.
The sweet spot is in between:

- **One unit = one branch = one session.** Pick it from `TODO.md` → *Now*, finish it,
  open a PR, then start fresh.
- **Restart when the work you've added ≈ 1.5× the starting context** (roughly when the
  context-bloat badge reaches Tier 3, or about half the window). Write the handoff first
  (`end-session` skill or `docs/session-handoff.md`), then start a new session from it.
- **Idle more than an hour → start fresh from the handoff.** The prompt cache has expired,
  so resuming costs about as much as a new session and carries stale context.
- Read ranges, not files: `rg`, `sed -n 'a,bp'`, `gh run view --log-failed | tail -80`.
  Read only the *Now* section of `TODO.md`, not the inventory tables.

# One agent per worktree — across tools

Claude Code and Codex must never work in the same checkout at the same time. A Codex run
switching branches corrupts a Claude session's tree, and vice versa. Give each concurrent
agent its own worktree:

```bash
git fetch origin main && git worktree add ../nuwrrrld-portal-<unit> -b <type>/<unit> origin/main
```
