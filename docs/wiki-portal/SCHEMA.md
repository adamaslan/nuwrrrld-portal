# Wiki Schema — nuwrrrld-portal

The LLM owns this layer entirely. The user curates sources and asks questions; the LLM writes and maintains every wiki page. This schema mirrors `gcp3-mobile/docs/wiki-mobile/SCHEMA.md` — keep them in sync where the two repos share behavior (the AI Council originated in mobile and was ported here).

## Three Layers

```
docs/wiki-portal/raw/      — IMMUTABLE source documents. User drops files here. LLM reads, never writes.
docs/wiki-portal/          — LLM-written pages: entities, concepts, decisions, incidents, synthesis.
docs/wiki-portal/SCHEMA.md — This file. Co-evolved by user + LLM. Governs all wiki behavior.
```

Raw sources are evidence; wiki pages are interpretation. Never copy source material verbatim — always synthesize, integrate, and cross-link.

## Directory Layout

```
docs/wiki-portal/
├── SCHEMA.md              — This file (conventions + workflow)
├── index.md               — Catalog of every page + one-line summary
├── log.md                 — Append-only chronological record
├── overview.md            — System map, stack, current health
│
├── entity-*.md            — One page per named component (the hubs)
├── concept-*.md           — Cross-cutting patterns
├── incident-*.md          — One page per production incident
├── decision-*.md          — Recorded design decisions
│
└── raw/                   — Immutable source documents
```

## Page Types & What They Must Contain

### Entity Pages (`entity-*.md`)
One page per named component. These are the hubs — everything links to entities.

Required sections: **What it is**, **Where used**, **Known failures**, **Open questions**, **See also**.

### Concept Pages (`concept-*.md`)
Cross-cutting patterns and design choices.

Required sections: **The pattern**, **Where it appears**, **Contradictions / tensions**, **See also**.

### Incident Pages (`incident-*.md`)
One page per production incident. Must update every entity page it touches.

Required sections: **Date & severity**, **What happened**, **Root cause**, **Resolution**, **Impact on design**, **Open items**.

### Decision Pages (`decision-*.md`)
Recorded design decisions. The single most important thing a decision page does is explain *why*.

Required sections: **Decision**, **Date**, **Context**, **Alternatives considered**, **Consequences**, **Validated by**, **See also**.

## Page Conventions

- **Filename**: kebab-case prefix tells the type: `entity-`, `concept-`, `incident-`, `decision-`
- **Frontmatter**:
  ```yaml
  ---
  date: 2026-07-18
  type: entity | concept | incident | decision | overview
  tags: [council, grounding, llm]
  sources: [../../lib/openrouter.ts, PR#37]
  ---
  ```
- **Link style**: `[[filename|text]]`
- **Contradiction notices**: `> ⚠️ Contradiction: page X says A; code says B. Unresolved.`
- **Open question notices**: `> ❓ Open question: …`

## Cross-Repo Boundary

This wiki is portal-only. When a question crosses into the mobile app or a backend, link by path (not `[[…]]`, since Obsidian-style wikilinks don't cross vaults):

```
See `gcp3-mobile/docs/wiki-mobile/entity-council-composer.md` for the mobile council's prompt builders.
```

Never edit another repo's wiki from a portal session.

## Secret Policy

**Never write real API keys, tokens, Clerk publishable keys, GCP project IDs, database URLs, or Cloud Run hostnames into wiki pages.**

Use placeholders:
- Backend URL → `{gcp3-backend-url}`
- OpenRouter key → `{openrouter-api-key}` (env `OPENROUTER_API_KEY`)
- Neon connection → `{database-url}` (env `DATABASE_URL`)

## On PR Creation

Whenever a PR is opened for this repo (`gh pr create`), treat the PR as an ingest source before finishing the task:

1. **Secret scan** — grep the diff for credentials before reading
2. **Read the diff + PR description** — extract key facts, decisions, contradictions
3. **Identify which pages to create or update** — new entity → `entity-*.md`; new incident → `incident-*.md` (+ update every entity it touches); design decision revealed → `decision-*.md`; contradiction → mark inline on both pages
4. **Never copy verbatim** — synthesize, integrate, cross-link
5. **Update `index.md`** — add any new pages
6. **Append to `log.md`** — `## [{date}] ingest | PR #{number} {title} | pages touched: N`

A single source should typically touch 3–10 pages. If it touches 1, you're not integrating enough.

## Log Format

```
## [2026-07-18] ingest | PR #37 compile-time grounding PR 3/4 | pages touched: 7
## [2026-07-18] query | Where does RISK get its counter-argument?
## [2026-07-18] lint | 1 orphan, 2 open questions
## [2026-08-05] friction | had to hand-rebase 3 stacked PRs before merge | cost: rework
```

The `friction` line type feeds the command-suggestion miner (see
[[concept-bottleneck-command-suggestion]]): append one whenever a manual,
repeated, or forgotten step costs you rework, a near-miss, or an incident.
`cost:` is one of `rework | near-miss | incident`.
