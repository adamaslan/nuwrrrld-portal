---
ARCHIVED: 2026-08-16
REASON: Rebase conflict with a later, independently-written version of this
  page that landed on main (dated 2026-08-06) while this branch (squashed
  commit, originally authored 2026-08-05) sat unpushed. Both are genuine,
  differently-structured drafts of the same concept, not one superseding
  the other — archived rather than discarded per the project's
  archive-never-delete policy. The canonical page is
  docs/wiki-portal/concept-global-automation-layer.md.
---

---
date: 2026-08-05
type: concept
tags: [dev-tooling, commands, workflow, automation, hooks, cross-repo]
sources: [~/.claude/commands/, ~/.claude/rules/, ~/.claude/settings.json, ~/.claude/scripts/]
---

# concept: Global Automation Layer (`~/.claude/`)

> Cross-boundary note: this page documents config that lives in the user's home
> `~/.claude/`, *not* in this repo. It's worth a wiki page because these globals
> materially shape how the portal gets built — but they are shared across every
> project, so treat this as a map, not a source of truth to edit from here.

## The pattern

Above the repo-local [[entity-dev-command-suite]] sits a **global** layer of
commands, always-on rules, and enforcement hooks in `~/.claude/`. Where the
repo-local commands are portal-specific playbooks, the global layer is
cross-project machinery that *automates the build process* and *enforces the
conventions the repo commands assume*. Three kinds:

### 1. Global commands (`~/.claude/commands/*.md`) — the reusable verbs

| Command | What it automates | Relation to portal |
| --- | --- | --- |
| **`/geepr`** | Stack-agnostic branch → secret-scan → commit → PR. | The general form of the portal's `/pr`. |
| **`/bugz`** | Finds PRs with bug comments across **all** `adamaslan` repos, auto-fixes, pushes, merges. | The multi-repo parent of the portal's conflict-hardened `/bugmerge1`. |
| **`/reb`** | Rebase current branch onto `main` so PRs merge cleanly. | The primitive `/bugmerge1` and `/pr`'s conflict guard lean on. |
| **`/rem1`** | Fullstack loop: fix real-data wiring → PR → fix review comments → verify live data → summarize. | End-to-end driver over the portal + backend. |
| **`/maxtoke`** | Biweekly portal + mobile PR loop at minimum token cost. | Cadence wrapper around `/pr` + `/sync-pr`. |
| **`/locrun`** | Runs the NuWrrrld local signal pipeline (yfinance/Finnhub → Firestore → HTML → portal push). | Feeds this portal's signal plane — see [[entity-signal-data-plane]]. |
| **`/cost-savings`** | Reference for spending fewer tokens/dollars across all projects. | Governs how all the above are run. |
| **`/chunky1`**, **`/openclaw-scrape`** | Corpus chunking/embedding and web scraping. | Data-prep, upstream of grounding. |

The lineage worth noting: **`/geepr` → `/pr`**, **`/bugz` → `/bugmerge1`**. The
repo-local commands are hardened, portal-scoped specializations of the global
verbs — the global one is broad and cross-repo, the local one adds this repo's
build check, secret patterns, and (for `/bugmerge1`) the conflict-free rebase
loop.

### 2. Global rules (`~/.claude/rules/*.md`) — always-on conventions

- **`mobile-web-wiki-sync.md`** — the load-bearing one for this repo. Requires
  that any PR in `nuwrrrld-portal` *or* `gcp3-mobile` refresh the parity docs in
  **both** wikis in the same task. See [[concept-mobile-web-parity]] /
  [[concept-sync-requirements]].
- **`context-bloat-warning.md`** — the 6-tier context-pressure badge system.
- **`mamba-rules.md`** — mamba-first Python env policy (relevant to `/locrun`
  and `/chunky1`, which run in mamba envs, not to the Next.js portal itself).

### 3. Enforcement hooks (`~/.claude/settings.json` + `~/.claude/scripts/`)

The rules above aren't just documentation — a `PostToolUse` hook on `Bash`
fires on `gh pr create` **and** `gh pr merge` and runs
`~/.claude/scripts/wiki-guard.mjs`. It *verifies* rather than reminds:

- **uncommitted wiki files** in either repo (the failure that actually happened
  repeatedly — wiki content written but never committed with the PR it
  documents),
- **unpushed wiki commits**, and
- **`wiki-lint.mjs` findings** — schema violations, cross-boundary links,
  real-shaped secrets, and disagreement between the two repos' parity headline
  percentages.

The guard always exits 0 (never breaks a PR flow) and its trigger regex is
anchored to command position so merely *mentioning* `gh pr create` in a heredoc
doesn't trip it.

## Where it appears

- Every portal PR passes through this layer: `/pr` (local) or `/geepr` (global)
  opens it, the `wiki-guard` hook fires on the `gh pr create`, and the parity
  rule forces the two wikis into agreement — all before the turn ends.
- `/bugmerge1` (local) is where a developer drops down from the global `/bugz`
  when they need conflict-free, single-repo merging with an explicit rebase loop.
- `/locrun` is the practical bridge from the global layer into the app's data:
  it's how the portal's signal plane gets fed locally.

## Contradictions / tensions

> ⚠️ Tension: the global layer enforces **wiki** hygiene on every PR (via the
> hook) but enforces **test/lint** hygiene on none — consistent with
> [[concept-test-strategy]], where nothing runs the unit suite in CI and
> `npm run lint` crashes repo-wide. Build passing is verified; tests passing is
> trusted.

> ❓ Open question: `/bugmerge1` (local) and `/bugz` (global) overlap heavily.
> Should `/bugmerge1` simply call `/bugz` scoped to this repo plus a rebase
> pre-step, rather than re-implementing the comment-fix flow? Tracked as an open
> question on [[entity-dev-command-suite]] too.

> Candidate automations this map surfaces (feed to
> [[concept-bottleneck-command-suggestion]]): a `/reb`-all-PRs batch rebase; a
> local pre-push hook that runs the vitest unit suite the CI gap leaves
> unenforced; a `/commit-tests` guard for the recurring untracked-test-file lint.

## See also

- [[entity-dev-command-suite]] — the repo-local commands these globals generalize
- [[concept-bottleneck-command-suggestion]] — how the candidate automations above get proposed
- [[concept-mobile-web-parity]] / [[concept-sync-requirements]] — what the parity rule + hook keep true
- [[concept-test-strategy]] — the hygiene the global layer does *not* enforce
