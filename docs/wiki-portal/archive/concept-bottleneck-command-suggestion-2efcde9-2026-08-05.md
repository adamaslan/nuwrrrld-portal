---
ARCHIVED: 2026-08-16
REASON: Rebase conflict with a later, independently-written version of this
  page that landed on main (dated 2026-08-06) while this branch (squashed
  commit, originally authored 2026-08-05) sat unpushed. Both are genuine,
  differently-structured drafts of the same concept, not one superseding
  the other — archived rather than discarded per the project's
  archive-never-delete policy. The canonical page is
  docs/wiki-portal/concept-bottleneck-command-suggestion.md.
---

---
date: 2026-08-05
type: concept
tags: [dev-tooling, commands, workflow, meta, automation]
sources: [.claude/commands/, docs/wiki-portal/log.md]
---

# concept: Bottleneck-Driven Command Suggestion

## The pattern

New slash commands should be *proposed by evidence*, not invented on a hunch. A
command earns its place when the same friction shows up repeatedly across
sessions. This wiki already holds that evidence — `log.md` records every ingest,
query, and lint, and incident pages record every production failure. The pattern
here is: **mine that record for recurring bottlenecks, and when one crosses a
threshold, propose a command that would have absorbed it.**

A bottleneck is any step that is: (a) manual, (b) repeated, and (c) error-prone
or forgotten — the exact profile the existing commands were each born to fix.
`/bugmerge1` exists because pre-PR merge conflicts recurred; `/pr`'s secret scan
exists because a malformed key reached production
([[incident-2026-07-27-stripe-checkout-invalid-header]]).

### The signals to mine

| Source | Bottleneck signal | Example → candidate command |
| --- | --- | --- |
| `log.md` **query** lines | The same question asked ≥3× | Repeated "where does X get grounded?" → a `/ground-trace` explainer command |
| `log.md` **lint** lines | The same orphan / open-question recurring | Untracked test files flagged again → a `/commit-tests` guard |
| `incident-*.md` **root cause** | A class of failure that a pre-flight check would have caught | Malformed env key in prod → the secret scan now in `/pr` |
| PR review comments (via `/bugmerge1`) | The same review nit repeated across PRs | "you forgot the parity wiki-sync" → already a hook; promote to a command if it keeps recurring |
| Manual multi-step sequences in commit history | The same 4+ command chain typed by hand repeatedly | `rebase → build → force-push` → folded into `/bugmerge1` |

### The threshold

Propose a command when a bottleneck signal appears **≥3 times** across the
record, OR **once** if its cost is a production incident (one is enough — the
incident *is* the evidence). Below the threshold, do nothing: premature commands
are dead weight in `.claude/commands/`.

## Where it appears

- **The mechanism itself** — a new command, **`/suggest-commands`**, that reads
  `log.md` + the `incident-*.md` set + recent PR review comments, tallies
  recurring friction against the threshold, and *outputs a ranked list of
  proposed commands with a one-line rationale each*. It **proposes only** —
  writing a new `.claude/commands/*.md` stays a human decision, because a
  command encodes conventions a human must vouch for.
- **The feeding convention** — for the miner to work, friction has to be
  *logged*. This concept adds one optional `log.md` line type:

  ```
  ## [{date}] friction | {what was manual/repeated/forgotten} | cost: {rework|near-miss|incident}
  ```

  Anyone (or Claude, mid-task) appends a `friction` line when they hit a
  bottleneck. `/suggest-commands` reads these first — they're the highest-signal
  input because they're deliberately recorded, not inferred.
- **Existing commands as precedent** — every command in
  [[entity-dev-command-suite]] is retroactively an instance of this pattern; the
  mechanism just makes the loop explicit and repeatable instead of relying on
  someone remembering the pain.

## Contradictions / tensions

> ⚠️ Tension: the miner's best input (`friction` log lines) depends on humans
> remembering to log friction — the exact kind of "manual + forgotten" step the
> whole concept exists to eliminate. Mitigation: `/suggest-commands` also falls
> back to inferring bottlenecks from `query`/`lint` line frequency and incident
> root causes, which are logged for other reasons, so it degrades to
> honest-lesser rather than producing nothing — the same
> [[concept-graceful-degradation]] posture the app uses.

> ❓ Open question: should `/suggest-commands` be allowed to *draft* the proposed
> command file (as a diff for review) rather than only naming it? Drafting is
> more useful but raises the bar on the "a human must vouch for conventions"
> principle. Left as propose-only until the first few suggestions prove the
> mechanism's judgment.

> ❓ Open question: the threshold (≥3, or 1-if-incident) is a guess. Revisit once
> there's a log of accepted vs. rejected suggestions to calibrate against.

## See also

- [[entity-dev-command-suite]] — the commands this mechanism proposes additions to
- [[concept-graceful-degradation]] — the degrade-don't-fail posture the miner borrows
- [[concept-test-strategy]] — a standing source of `lint`/orphan friction the miner would surface
- [[SCHEMA]] → Log Format — where the new `friction` line type slots in
