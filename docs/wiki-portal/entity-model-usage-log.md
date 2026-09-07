---
date: 2026-09-07
type: entity
tags: [observability, models, pipelines, openrouter, cost, audit]
sources: [../../lib/pipeline-run-log-db.ts, ../../lib/db/schema.sql, ../../scripts/model-usage-report.mjs, ../../app/api/pipeline/followed-tickers/route.ts, ../../app/api/pipeline/followed-tickers-judge/route.ts, ../../app/api/pipeline/precompute-ai/route.ts, ../../.github/workflows/model-usage-report.yml, ../model-usage/README.md, PR#115]
---

# Entity: Model-Usage Log (`pipeline_run_log`)

The audit trail that answers *which OpenRouter model actually served each pipeline run, on what, and how well* — rolled up by day / week / month into committed markdown. Shipped in PR #115.

## What it is

Before this, model-per-call was recorded only where a table already had a `model` column — `council_messages` (interactive council), `precomputed_ai`, `public_demo_cache`. The daily [[concept-followed-tickers-tracking|followed-tickers]] pipeline and the weekly judge run recorded *nothing* about which model produced a verdict: `followed-tickers`' `councilVerdictFor` fetched a T1 answer and threw the served model away. So "are we still all-`:free`, and which models are doing the work" was unanswerable without reading Actions logs.

- **`pipeline_run_log`** (`lib/db/schema.sql`) — append-only, one row per invocation of a model-spending pipeline route:

  | column | meaning |
  |---|---|
  | `pipeline` | `followed-tickers` \| `followed-tickers-judge` \| `precompute-ai` |
  | `run_at`, `dry_run`, `session` | when, whether it was a dry run, optional caller run id |
  | `items_total` / `items_ai` | units seen / units that spent a model call |
  | `models` (jsonb) | `{ "<model id>": { calls, empty, fallbacks, avgLatencyMs } }` — `fallbacks` = the seat's primary lost and `FREE_MODEL_CHAIN` served; `empty` = HTTP-200 with no content |
  | `items` (jsonb) | compact per-unit list `[{ subject, seat, model, outcome }]`, `outcome ∈ ok \| empty \| fail \| skip` |
  | `summary` (jsonb) | pipeline-specific totals (cohortSize, councilDegraded, generated, goldAgreement, verdictsGraded, …) |

- **`lib/pipeline-run-log-db.ts`** — `logPipelineRun(run)` (one INSERT) and `rollupModels(items)` (pure fold from the flat item list to the `models` column). **Best-effort by design**: `logPipelineRun` catches and logs its own errors and returns a boolean — nothing in a request path reads the table back, so losing an audit row must never fail a pipeline run. This is the opposite stance from [[concept-followed-tickers-tracking|followed-tickers-db]], where a dropped write is fatal.

- **`scripts/model-usage-report.mjs`** (`npm run model-usage`) — reads the table for a `--period day|week|month` window (anchored on `--date`, default today) and writes `docs/model-usage/<start>-<period>.md`: a by-model table (calls, share, empty, chain-rescued, avg latency, `$0` for `:free` / `⚠ paid` otherwise), a by-pipeline breakdown, a chronological runs table, and a supplementary `council_messages` tally. Degrades to an explanatory stub if the table doesn't exist yet (un-migrated DB). Same `.env.local` fallback as `db-migrate`; zero extra deps.

- **`.github/workflows/model-usage-report.yml`** — Mondays 05:00 UTC (previous ISO week) + the 1st at 05:10 UTC (previous month); generates the file and opens a PR via `peter-evans/create-pull-request`. Read-only against Neon; uses the existing `DATABASE_URL` secret.

## Where used

The three model-spending pipeline routes each call `logPipelineRun` once at the end; nothing else writes the table, and only `model-usage-report.mjs` + the workflow read it.

| pipeline | unit | model source |
|---|---|---|
| `followed-tickers` ([[concept-followed-tickers-tracking]]) | one live pick | `runSeat("T1")` return — `councilVerdictFor` now returns `{ model, latencyMs, fallback, empty }`; `fallback` via `seatPrimaryModel("T1")` (new export on [[entity-openrouter-client]]) |
| `followed-tickers-judge` | one gold entry / one sample score | `makeJudgeCall` records a `RunItem` per `runSeat("QUANT")` as a side effect; a `phase` label marks gold-gate vs sample |
| `precompute-ai` ([[entity-ticker-universe-pipeline]] sibling) | one ticker batch | `results[].model` from `fetchWithModelFallbackChecked` (already captured pre-PR) — `fallback` unknown, that helper doesn't report chain position |

Reads: `npm run model-usage` locally, and `model-usage-report.yml` on the weekly/monthly cron. The generated files live in `docs/model-usage/` (`README.md` there is operator-facing).

## Known failures

- **No token counts.** `runSeat` / `fetchWithModelFallbackChecked` don't return usage, so per-call cost isn't computed. Reports mark `:free` as `$0` and anything else as `⚠ paid` — "spent real money", not a figure.
- **`precompute-ai` fallback depth is invisible.** `fetchWithModelFallbackChecked` returns only the winning model, not whether it was the first tried, so those rows always show `fallbacks: 0`.
- **Interactive surfaces aren't in this table.** `/api/nuai`, `/api/brief`, `/api/portfolio/health-ai` still record only tokens-per-user-per-day (`nuai_usage`), not which model. The report pulls `council_messages` as a partial supplement; the `fetchWithModelFallback*` routes are still dark.
- **Early-return runs don't log.** A pipeline that exits before any model call (`precompute-ai` with zero subjects, `followed-tickers` with an empty cohort) writes no row — nothing to record, but a reader can't tell "didn't run" from "ran, logged nothing".
- **Migration-gated.** The table only exists after `npm run db:migrate` (auto on deploy via `prebuild`). Until then the report emits a stub instead of failing — but a run before the migration lands is lost, not backfilled.

## Open questions

- ❓ Should `runSeat` return token usage so the report can show real cost, not just `$0` / `⚠ paid`? OpenRouter returns `usage` on the completion; nothing reads it today.
- ❓ Should the `fetchWithModelFallback*` routes (`/api/nuai`, `/api/brief`, `/api/portfolio/health-ai`) write `pipeline_run_log` rows too, or is per-user-per-day token count in `nuai_usage` enough for the interactive path?
- ❓ `pipeline_run_log` is append-only with no retention policy — a daily pipeline writes ~365 rows/year. Prune, or leave it (rows are small)?
- ❓ Should a `⚠ paid` row or a spike in `fallbacks` fail a check / open an issue, rather than only appearing in a markdown file nobody is required to read? (mirrors the "nothing fails a build on a dead seat" open item on [[entity-openrouter-client]])

## See also

- [[entity-openrouter-client]] — `runSeat`, `seatPrimaryModel`, `FREE_MODEL_CHAIN`; the models this log names
- [[concept-free-tier-resilience]] — this log is Layer 6, the missing observability layer for that pattern
- [[decision-free-tier-model-chain]] — the `$0` invariant this log makes checkable after the fact
- [[concept-followed-tickers-tracking]] — one of the three logged pipelines
- [[entity-db-parity-suite]] — `pipeline_run_log` rides the same schema-parity contract
- [[entity-dev-command-suite]] — `npm run model-usage` alongside the other run/report scripts
- `../model-usage/README.md` — operator-facing usage
- `../free-model-rotation-status.md` — the P1–P4 audit this shipped with
