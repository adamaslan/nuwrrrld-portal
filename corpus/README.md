# corpus/

The curated trading-knowledge corpus that `scripts/compile_grounding_pack.mjs`
compiles into `grounding_pack` (docs/ai-council-timeline.html, PR 2 —
"Compiler"). Markdown only, PR-reviewable like any other change.

## Status: production corpus not yet migrated

The real corpus — `t1-tactical-opportunist-100-questions.md`,
`t2-structured-growth-investor-100-questions.md`, the sector/options/macro
Q&A sets, `trader-profiles-updated.md`, etc. — lives in ai-text-opt-1024's
configured `DOCS_ROOT` (`../ai-text-opt/docs`), a sibling repo that is not
checked out in this environment. It was **not** copied into this directory
sight-unseen; only the two placeholder files below (clearly marked as
samples) exist here today, so the compile pipeline has something to chunk
and extract against end-to-end before the real migration.

**Before compiling a real pack:** copy the actual corpus markdown from the
`ai-text-opt` repo into this directory (flat or in subfolders — the
compiler walks recursively), then remove `sample/`.

## Naming convention (inherited from ai-text-opt-1024's ingest.py)

- Filenames containing `t1-`, `t2-`, `-qa.md`, or `-100-questions` are
  treated as Q&A content: chunked smaller (300 tokens / 40 overlap) so each
  Q&A pair stays atomic.
- `t1-*` / `t2-*` filenames also set that chunk's `trader_filter` column —
  T1 evidence never argues a T2 thesis and vice versa.
- Everything else is prose: chunked at 480 tokens / 96 overlap.
- Chunks shorter than `MIN_CHUNK_TOKENS` (80, ~320 chars) are dropped as
  stubs (lone headings, etc.) — see `scripts/grounding-chunker.mjs`.
