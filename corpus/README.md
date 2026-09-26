# corpus/

The curated trading-knowledge corpus that `scripts/compile_grounding_pack.mjs`
compiles into `grounding_pack` (docs/ai-council-timeline.html, PR 2 —
"Compiler"). Markdown only, PR-reviewable like any other change.

## Where the corpus comes from

`trader-qa/` mirrors `docs/trader-qa/*.md` from the public
`adamaslan/ai-text-opt` repo, which is still where the corpus is written.
`scripts/sync-corpus.mjs` pulls it; `.github/workflows/sync-corpus.yml` runs
that weekly (and on demand) and opens a PR when anything changed, so every
corpus change is reviewed before it is compiled. Don't hand-edit files under
`trader-qa/`: the next sync overwrites them. Edit upstream instead.

Six upstream files are excluded because they describe the outlines or the RAG
tooling, not trading (see `EXCLUDED_FILES` in `scripts/sync-corpus.mjs`).

⚠️ `doc-3-recent-news-part1.md` and `doc-4-recent-news-part2.md` are
time-sensitive news and will go stale. Freshness front-matter (`as_of` /
`valid_days`, flagging stale evidence as degraded) is a planned follow-up.

## Naming convention (inherited from ai-text-opt-1024's ingest.py)

- Filenames containing `t1-`, `t2-`, `-qa.md`, or `-100-questions` are
  treated as Q&A content: chunked smaller (300 tokens / 40 overlap) so each
  Q&A pair stays atomic.
- `t1-*` / `t2-*` filenames also set that chunk's `trader_filter` column —
  T1 evidence never argues a T2 thesis and vice versa.
- Everything else is prose: chunked at 480 tokens / 96 overlap.
- Chunks shorter than `MIN_CHUNK_TOKENS` (80, ~320 chars) are dropped as
  stubs (lone headings, etc.) — see `scripts/grounding-chunker.mjs`.
