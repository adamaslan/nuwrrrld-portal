---
date: 2026-08-06
type: concept
tags: [workflow, wiki, process, devops, cli-commands, automation]
sources: [../../.claude/commands/bugmerge1.md, ../../.claude/commands/postbugmergerev.md, ../../.claude/commands/pr.md, ./SCHEMA.md, ./log.md, ~/.claude/rules/mobile-web-wiki-sync.md]
---

# Concept: Wiki-Led Development

A development process in which **this wiki is not documentation *about* the work — it is the control surface *for* the work.** The wiki is the authoritative model of the system's current state; every code change begins by orienting against it and is only complete once a PR-triggered, hook-enforced ingest has reconciled it back to the new truth.

The ordinary relationship is inverted. Normally docs *trail* code: you ship, then (maybe) you write it up, and the wiki is a lagging, lossy mirror that goes stale. Wiki-led development flips the causality — the wiki *leads*, and a PR is not finished when code merges but when the wiki reflects the new ground truth. `SCHEMA.md` already states the thesis: *"A single source should typically touch 3–10 pages. If it touches 1, you're not integrating enough."* The wiki is meant to move on every change.

## The pattern

A four-step loop, closed:

```
        ┌──────────────────────────────────────────────┐
        │  WIKI = ground-truth model of the system      │
        │  (entities · concepts · decisions · incidents │
        │   · parity matrix · % synced)                 │
        └──────────────────────────────────────────────┘
             ▲                              │
   (4) INGEST │                              │ (1) ORIENT
   reconcile  │                              │ read wiki to know
   wiki to    │                              │ current state before
   new truth  │                              ▼ touching anything
        ┌─────┴─────┐                  ┌───────────────┐
        │ (3) SHIP  │◄─────────────────│ (2) CHANGE    │
        │ gh pr     │                  │ /bugmerge1 →  │
        │ create;   │                  │ fix code;     │
        │ guard     │                  │ /postbugmerge │
        │ verifies  │                  │ rev → deepen  │
        └───────────┘                  └───────────────┘
```

1. **Orient** — read the wiki to learn the state of the world before touching code (which PRs are in flight, what's drifted between surfaces, what incidents constrain the next move).
2. **Change** — make the code change, bounded by what step 1 revealed.
3. **Ship** — `gh pr create` is the *event that demands reconciliation*; the enforcement hook fires here.
4. **Ingest** — read the PR *as a source* into the wiki per `SCHEMA.md`'s "On PR Creation" workflow. The wiki now leads again for the next cycle.

Three properties are what earn the name *led* rather than merely *documented*:

- **Enforced, not requested.** A `PostToolUse` hook on `gh pr create`/`gh pr merge` runs `wiki-guard.mjs`, which *verifies* rather than reminds — it fails on uncommitted wiki files, unpushed wiki commits, and `wiki-lint` findings. That makes the wiki a **gate**, not a suggestion. (See `~/.claude/rules/mobile-web-wiki-sync.md`.)
- **Computed truth, not prose.** The [[concept-mobile-web-parity]] matrix and its headline `% synced` are *derived state with an invariant* — `wiki-lint` fails if the two repos' numbers disagree. That's the wiki behaving like a typed model with checkable invariants, not a folder of notes.
- **Closes the loop back into behavior.** Information must be able to flow wiki → code → wiki. The proof is [[incident-2026-08-06-bugmerge1-command-file-loss]]: an incident was written, it changed `/bugmerge1`'s guardrails (self-integrity check, out-of-tree backup), and the next execution behaves differently. In doc-trailing development an incident write-up is a tombstone; here it is a patch to the process.

## Where it appears

The `.claude/commands/` suite is the set of verbs this process runs on:

| Command / mechanism | Role in the loop |
|---|---|
| `/bugmerge1` | **Change** (cheap pass) — delegates git-mechanical steps to Haiku; self-protects using knowledge *from* the wiki ([[incident-2026-08-06-bugmerge1-command-file-loss]]) |
| `/postbugmergerev` | **Change** (deepen pass) — Opus/Sonnet re-reviews Haiku's merged fixes; sequences the wiki ingest *before* `gh pr create` so shipping and reconciling are one atomic act |
| `/pr`, `/sync-pr` | **Ship** — the events that trigger mandatory ingest |
| `wiki` skill + `SCHEMA.md` | the **grammar** — defines what a valid wiki mutation is |
| `wiki-guard` + `wiki-lint` hooks | the **enforcement** — makes "led" real rather than aspirational |
| `~/.claude/rules/mobile-web-wiki-sync.md` | the **cross-surface invariant** — keeps the portal and mobile wikis one coherent model |

`/postbugmergerev` step 6 is the pattern in miniature: it insists the wiki edits be committed *on the branch before* `gh pr create`, so reconciliation is part of the change, not a follow-up to it. `log.md` is the running evidence that the loop turns — each `ingest` line is one completed cycle.

## Contradictions / tensions

> The process has an **ingest tax on every PR**. It is well-suited to this solo, agent-driven repo where the wiki *is* the shared brain; it would be heavier for a large team merging at high velocity. The Haiku-delegation split in `/bugmerge1` is partly a cost-control response — push mechanical steps to a cheap model, reserve judgment for the strong one.

> The process once **assumed the reader** — the payoff is largest when cold-started agents (or a human weeks later) genuinely orient from the wiki first, yet nothing forced step 1. The guard enforces *ingest* (step 4) but cannot by itself enforce *orientation* (step 1); if no one reads the wiki, the ingest tax buys a model nobody consults. This is now mitigated by the enforcement layer below, not left as an open assumption.

## Enforcing orientation (closing the "assumes the reader" gap)

**Orient-first** is the countermeasure to the reader-assumption tension. The goal: make it structurally hard to start a change *without* reading the wiki, and make the wiki the thing a cold-started agent lands on first. Five mechanisms, weakest-to-strongest:

1. **Step 0: Orient, via a single entry point** — [[START-HERE]] is the one page a cold-started agent reads first: a 60-second orient (`overview` → `index` → newest `log.md` line) plus a **task-routed reading order** ("touching the council? read these four pages in this order"). Both `overview.md` and `index.md` point at it up top, so whichever page an agent lands on first funnels into the same orient path. This turns step 1 of the loop from an assumption into a signposted on-ramp.
2. **The wiki is greppable and keyword-dense** — pages front-load the terms an agent would search for (`orient`, `ground truth`, `parity matrix`, `% synced`, `ingest`, `known failures`, `open question`). A cold agent running `grep -ri "parity"` or `grep -ri "known failures"` over the repo lands in the wiki, not scattered code comments. Keyword density *is* discoverability.
3. **Dense cross-references make the wiki traversable** — every page's **See also** links its neighbors, so arriving at *any* page (via grep, a code `sources:` back-reference, or a stack trace mentioning an entity) puts the whole model one hop away. Entity pages are the hubs; `index.md` is the catalog; `overview.md` is the map. Orientation is cheap because the graph is connected.
4. **Code points back at the wiki** — an entity/concept page's `sources:` frontmatter names the files it models, and the convention is to leave a back-reference near non-obvious code (`// see docs/wiki-portal/concept-…`). The reader working in code is nudged toward the page that explains *why*, so orientation can start from wherever the agent already is.
5. **`log.md` reveals the last cycle** — the newest `ingest` line answers "what changed most recently and which pages hold it," so orientation can start from *recency* instead of a cold read of the whole catalog.

> ❓ Open question (narrowed): the guard still cannot *prove* an agent read the wiki before editing — orientation is now **instructed and made easy**, not mechanically verified. A future `PreToolUse` check (e.g. warn when a session edits a file whose entity page hasn't been opened this session) would close the last of the gap; today the enforcement is the step-0 instruction plus discoverability, which is a large improvement over the bare assumption.

> **Wiki quality is load-bearing.** If the parity matrix is wrong, step 1 poisons every downstream decision. This is exactly why the lint invariants and the "synthesize, never copy the diff" rule matter — a wiki-led process is only as good as the fidelity of its model. The known gap that the parity headline's empirical basis can lag its claims (see [[concept-mobile-web-parity]]) is a live instance of this risk.

## See also

- [[START-HERE]] — the orientation entry point this concept's step-0 enforcement is built on
- [[incident-2026-08-06-bugmerge1-command-file-loss]] — the clearest wiki → code → wiki feedback instance
- [[concept-mobile-web-parity]] — the computed-truth invariant the guard checks across repos
- [[concept-sync-requirements]] — what each surface still owes, recomputed on every ingest
- [[concept-small-model-prompting]] — the cost-control philosophy behind the Haiku delegation this process leans on
- `.claude/commands/bugmerge1.md` — Change (cheap pass)
- `.claude/commands/postbugmergerev.md` — Change (deepen pass), with the ingest-before-`gh pr create` ordering
- `~/.claude/rules/mobile-web-wiki-sync.md` — the enforcement + cross-repo invariant this concept depends on
- `gcp3-mobile/docs/wiki-mobile/concept-mobile-web-parity.md` — the mirror surface this process keeps in sync
