---
date: 2026-07-20
type: entity
tags: [grounding, compiler, corpus, chunker, ci, neon]
sources: [../../scripts/compile_grounding_pack.mjs, ../../scripts/grounding-chunker.mjs, ../../corpus/README.md, ../../.github/workflows/compile-grounding-pack.yml, PR#36, PR#37]
---

# Entity: Grounding Compiler (`scripts/compile_grounding_pack.mjs` + `corpus/`)

The **one place a model ever reads the corpus.** It walks `corpus/**/*.md`, chunks each file, and extracts per-chunk rule tuples into `grounding_pack` — keyed on the [[entity-grounding-tier-ladder]] taxonomy. At request time nothing reads the corpus; the council reads the compiled pack.

## What it is

A dependency-light Node ESM script (native `fetch` + `@neondatabase/serverless` only — the same philosophy as `refresh-free-models.mjs`). Pipeline:

1. **Walk** `corpus/` recursively for `.md`.
2. **Chunk** each file via `grounding-chunker.mjs`:
   - Q&A files (`t1-`, `t2-`, `-qa.md`, `-100-questions`) → 300 tokens / 40 overlap, so each Q&A pair stays atomic.
   - `t1-*` / `t2-*` filenames also set the chunk's `trader_filter` column — this is where the horizon wall originates.
   - Prose → 480 tokens / 96 overlap.
   - Chunks under `MIN_CHUNK_TOKENS` (80, ~320 chars) are dropped as stubs.
3. **Upsert** `corpus_chunks`.
4. **Extract** rule tuples via one batched LLM call per chunk (`COMPILE_MODEL`, default a `:free` model), keyed to the taxonomy state-key space.
5. **Upsert** `grounding_pack` (`ON CONFLICT` — idempotent, re-runs safe).

**The hard invariant:** a rule can only enter the pack if its `quote` is a *verbatim substring* of the chunk body. The pack physically cannot contain text the corpus doesn't.

## Where used

- Produces the `grounding_pack` and `corpus_chunks` tables that [[entity-grounding-tier-ladder]] reads at Tiers 0–2
- Runs in CI: `.github/workflows/compile-grounding-pack.yml` — weekly (Mondays 06:23 UTC), on any `corpus/**` or chunker/compiler push to `main`, and manual `workflow_dispatch`

## Versioning

Every row is stamped with `CORPUS_VERSION` (git short SHA, else `"dev"`) and `TAXONOMY_VERSION`. [[entity-grounding-tier-ladder]] compares these to flag a `degraded` (stale) pack.

## Known failures

1. **Production corpus not yet migrated.** `corpus/` currently holds only two clearly-marked sample files (`sample/t1-sample-swing-notes.md`, `t2-sample-growth-notes.md`). The real corpus lives in a sibling repo (`ai-text-opt-1024`'s `DOCS_ROOT`) not checked out here — so today's compiled pack is a placeholder proving the pipeline end-to-end, not real trading knowledge. See `corpus/README.md`.
2. **Under-constrained rule → Cartesian blow-up.** A rule that pins few taxonomy dimensions expands into many `state_key` rows; `MAX_EXPANDED_ROWS_PER_RULE` (24) caps this.
3. **Extraction model returns malformed tuples.** The verbatim-quote invariant rejects fabricated evidence, but a chunk that yields zero valid rules simply contributes nothing — silent under-coverage rather than an error.

## Open questions

- ❓ When the real corpus migrates, `sample/` must be removed (per `corpus/README.md`). Is there a guard that prevents a production compile from silently running against sample data?
- ❓ `COMPILE_MODEL` is a single free-tier model; extraction quality gates the whole grounding system. Should extraction use a stronger paid model given it runs weekly, not per-request?

## See also

- [[entity-grounding-tier-ladder]] — the request-time consumer of what this builds
- [[decision-compile-time-grounding]] — why extraction is a build step, not a request step
- [[concept-graceful-degradation]] — the "pack lags, serve stale-but-flagged" behavior
- `gcp3/docs/wiki-gcp3/entity-bake-pipeline.md` — the backend's analogous "compile ahead of the request" pattern
