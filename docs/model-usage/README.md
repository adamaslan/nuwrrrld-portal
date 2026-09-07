# Model usage reports

Dated rollups of **which OpenRouter models actually served each pipeline run**,
and how well — one file per period.

## Where the data comes from

Every model-spending pipeline route writes one append-only row to the
`pipeline_run_log` table (`lib/db/schema.sql`, helper in
`lib/pipeline-run-log-db.ts`) at the end of each invocation:

| pipeline | unit of work | model call per unit |
|---|---|---|
| `followed-tickers` | one live pick | T1 grounded verdict (`runSeat("T1")`) |
| `followed-tickers-judge` | one gold entry / one sample score | QUANT judge call (`runSeat("QUANT")`) |
| `precompute-ai` | one ticker batch | portfolio-health narrative (`fetchWithModelFallbackChecked`) |

The row records the per-model rollup (`calls`, `empty` completions,
`fallbacks` = times the seat's primary lost and `FREE_MODEL_CHAIN` rescued it,
avg latency), a compact per-unit list, and pipeline-specific totals. A failed
insert is logged and swallowed — losing an audit row must never fail a run.

## Generating a report

```bash
npm run model-usage                        # this week  -> docs/model-usage/<Mon>-week.md
npm run model-usage -- --period day        # today      -> docs/model-usage/<date>-day.md
npm run model-usage -- --period month      # this month -> docs/model-usage/<YYYY-MM>-month.md
npm run model-usage -- --period week --date 2026-09-01   # the week containing that date
npm run model-usage -- --stdout --dry-run  # print, write nothing
```

Needs `DATABASE_URL` (read from the environment, or from `.env.local` as a
fallback, same as `npm run db:migrate`). Zero extra dependencies.

Each report has: a **by-model** table (calls, share, empty, chain-rescued, avg
latency, `$0` for `:free` / `⚠ paid` otherwise), a **by-pipeline** breakdown, a
chronological **runs** table, and a supplementary tally of interactive-council
calls from `council_messages`.

## "Cheapest / free models, always"

The rotation chain (`FREE_MODEL_CHAIN` in `lib/openrouter.ts`) is `:free`
`$0`-priced models **only**, by construction — `scripts/refresh-free-models.mjs`
never puts a paid id in it. The seat primaries (`SEAT_MODELS`) are
hand-maintained and *can* be paid; the same script's seat audit now prints
`ok` / `PAID` / `DEAD` per seat so a paid seat can't hide (it did once — see
`docs/free-model-rotation-status.md` P2). A `⚠ paid` row in any report here is
the signal to repoint that seat at a `:free` id.
