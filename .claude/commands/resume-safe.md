# /resume-safe — Checkpoint Before the Token Limit, Then Resume

Watches context/token pressure during a long wiki-led automated-dev run. When it
gets **close to the limit**, it stops cleanly at a safe boundary, writes a
**resume checkpoint** to the wiki log so no state is lost, schedules a wakeup to
**resume the work**, and — when the work finally finishes — emits an **HTML
summary** of everything that changed (both a local file and a published artifact,
per the global `artifact-and-local-html` rule).

The point: a long automated run should never hit a hard context wall mid-edit and
lose its place. `/resume-safe` makes the run *survive* the limit by checkpointing
into the wiki (the durable memory) and picking up where it left off.

## 0. Orient (wiki-led dev — first)

Read `docs/wiki-portal/START-HERE.md` and [[concept-wiki-led-development]]. The
checkpoint and resume both go **through the wiki log**, so orientation is also how
a resumed run re-establishes context after a wakeup.

## Guardrails

- **Never stop mid-edit.** Checkpoint only at a safe boundary: between files, after
  a successful build, or after a committed step — never with a half-written file.
- **Checkpoint is append-only** to `log.md` — never rewrite log history.
- **No secrets** in the checkpoint or the HTML summary — env vars by name only.
- **Destructive-action safety still applies** — a resume must re-confirm before any
  destructive step; a checkpoint does not pre-authorize anything.

## Token-pressure tiers (when to act)

Assess pressure each turn (per the global context-bloat rule). Act at:

- **Tier 4 (Heavy, ~60–75%)** — finish the current safe unit, then **checkpoint +
  schedule resume**. Don't start a new large unit.
- **Tier 5+ (Critical, ~75%+)** — checkpoint **immediately** at the nearest safe
  boundary; do not begin anything new.

## Execute

### 1. Write the resume checkpoint (when pressure hits the tier above)

```bash
cd /Users/adamaslan/code/nuwrrrld-portal/docs/wiki-portal

printf '\n## [%s] checkpoint | resume-safe | done: %s | next: %s | branch: %s\n' \
  "$(date +%F)" \
  "<what is finished + committed so far>" \
  "<the exact next step to resume with>" \
  "$(git -C /Users/adamaslan/code/nuwrrrld-portal rev-parse --abbrev-ref HEAD)" \
  >> log.md

# Preserve any uncommitted work so a fresh session can recover it (pathspec-scoped,
# never a bare `git stash -u` — see the bugmerge1 incident).
git -C /Users/adamaslan/code/nuwrrrld-portal status --porcelain
```

The `next:` field must be a **concrete, self-contained instruction** — a resumed
run (possibly a cold session) executes it after re-orienting from START-HERE.

### 2. Schedule the resume

Use the harness wakeup so work continues automatically after the pressure clears
(a fresh window resets context):

- Schedule a wakeup whose prompt is: re-run `/resume-safe`, which will read the
  newest `checkpoint` line from `log.md` and continue from its `next:` step.
- Pick the delay from what you're waiting on (a fresh session is immediate;
  otherwise a short fallback). Keep the same prompt so the loop repeats until the
  work is done.

### 3. Resume (when re-invoked)

```bash
# Read the most recent checkpoint and pick up its `next:` step.
grep -n "| checkpoint |" docs/wiki-portal/log.md | tail -1
```

Re-orient (START-HERE), restore any stashed work, and execute the `next:` step.
Continue the run; re-checkpoint again if pressure returns. Loop until `next:` is
"done".

### 4. When the work is FULLY finished — HTML summary (both surfaces)

Per the global `artifact-and-local-html` rule, produce **two** outputs from one
authoring pass:

1. Write a self-contained HTML summary to
   `docs/wiki-portal/reports/resume-safe-<date>.html` — theme-aware, no external
   assets — covering: the task, each checkpoint/resume cycle, files changed, wiki
   pages touched, and the final state (build/tests/PR).
2. Publish it as an Artifact from that same file path (shareable URL + preview).

Then close the loop in the wiki:

```bash
printf '\n## [%s] ingest | resume-safe run complete | pages touched: %s\n' \
  "$(date +%F)" "<N>" >> docs/wiki-portal/log.md
```

If a checkpoint/resume cycle was itself a bottleneck (e.g. the run was too big for
one window), log a `/friction` line so `/suggest-commands` can see it.

## See also

- `docs/wiki-portal/concept-wiki-led-development.md` — the loop the checkpoint rides on
- `/friction` — log the run if the split itself was friction
- `~/.claude/rules/artifact-and-local-html.md` — why the summary is both file + artifact
- `~/.claude/rules/context-bloat-warning.md` — the tier signals this command acts on
