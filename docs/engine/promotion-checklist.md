# Engine promotion checklist

What must be true before a signal-engine output is promoted from shadow to
user-facing (ladder on, card numerics live, holdem reading engine levels). The
plan is homebase `harness/CLOUD-ENGINE.md`; the fib definition and evidence are
`harness/FIBONACCI.md`.

**Rule:** the goal and the kill line are written and committed **before** the
results they judge are looked at. Changing either afterwards voids the
evaluation.

## 1. Goal and kill line (set by the owner, before evaluating)

Baseline being tested: the default signal (bullish 0.618–0.65 golden-pocket
hold on above-average volume) measured +1.2 points over the 21-day baseline,
z = 1.8, full universe.

| | Value | Set on |
|---|---|---|
| Goal: metric and threshold that means "promote" | _owner to fill_ | _date_ |
| Kill line: result that means "stop, do not promote" | _owner to fill_ | _date_ |
| Sample floor: minimum labeled hits before judging | _owner to fill_ | _date_ |

## 2. Data gates (checked from `engine_*` tables)

- [ ] Shadow ran for at least 10 trading days with no failed nightly run.
- [ ] Every hit that differs from signals-app `detector_hits` for the same
      ticker and date is explained by the data source (IEX vs yfinance) or fixed.
- [ ] Feed decision recorded (IEX vs SIP) — see CLOUD-ENGINE.md §3.5.
- [ ] `engine_runs.degraded_n` is 0, or every degraded ticker is explained.

```bash
# Last 15 runs: counts and degraded tickers
node --env-file=.env.local -e '
import("@neondatabase/serverless").then(async ({ neon }) => {
  const sql = neon(process.env.DATABASE_URL);
  console.table(await sql`SELECT id, mode, feed, bar_date::text, tickers_ok, tickers_skipped, tickers_failed, degraded_n, hits_n FROM engine_runs ORDER BY started_at DESC LIMIT 15`);
});'
```

## 3. Backtest gate

- [ ] Goal from §1 met on labeled hits (`engine_forward_returns`), at or above
      the sample floor.
- [ ] Kill line from §1 not crossed.

```bash
# Default-hit outcomes at the 21-day horizon
node --env-file=.env.local -e '
import("@neondatabase/serverless").then(async ({ neon }) => {
  const sql = neon(process.env.DATABASE_URL);
  console.table(await sql`
    SELECT count(*)::int AS n, round(avg(f.pct_return)::numeric, 2) AS avg_return_pct,
           round(avg(f.hit::int)::numeric, 3) AS hit_rate, round(avg(f.r_multiple)::numeric, 2) AS avg_r
    FROM engine_forward_returns f JOIN engine_detector_hits h ON h.id = f.hit_id
    WHERE h.experimental = false AND f.horizon_days = 21`);
});'
```

## 4. Paper gate

- [ ] The `engine` paper account has run for 3 months.
- [ ] Its result points the same direction as the backtest (same sign; a
      materially worse result blocks promotion until explained).

## 5. Promote

- [ ] Set `ENGINE_LADDER_ENABLED=true` for production.

```bash
cd ~/code/nuwrrrld-portal && vercel env add ENGINE_LADDER_ENABLED production
```

- [ ] Verify the ladder route answers for a ticker that has structure.

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://financial.nuwrrrld.com/api/engine/AAPL
```

Expect `200`.
