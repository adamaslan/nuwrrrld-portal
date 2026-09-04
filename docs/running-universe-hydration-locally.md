# Running Universe Hydration Locally

How to card the full ticker universe from your own terminal — what to run, what
it costs, and how to confirm it worked.

**Written 2026-08-28.**

> **The universe is 933 active tickers, not 981.** The 981 figure in
> `universe-by-industry.md` was accurate when written (2026-08-18); the
> `chore/prune-unhydratable-universe` work has since removed rows no data
> source could ever card. Verify before quoting a number:
>
> ```bash
> node --env-file=.env.local -e 'import("@neondatabase/serverless").then(async ({neon}) => {
>   const sql = neon(process.env.DATABASE_URL);
>   console.log(await sql`select universe, count(*)::int as n from ticker_universe where active = true group by universe`);
> })'
> ```
>
> As of this writing: **762 stocks + 171 ETFs = 933 active.**

---

## What hydration actually does

`scripts/hydrate-local.mjs` fetches daily bars from Alpaca, computes indicators
(RSI, ADX, MACD cross, volatility percentile, confluence) in JS, and POSTs the
results to the portal's `/api/pipeline/hydrate-universe` route, which scores
them and upserts `ticker_cards`.

**No model is called anywhere in this path.** That is the point of the route —
coverage is free, so it never competes with the interactive AI budget. Spending
the model is a separate job (`/api/pipeline/precompute-ai`) that runs only over
the top of the ranking.

```
Alpaca bars → indicators (JS) → POST /api/pipeline/hydrate-universe → ticker_cards
```

The script's name says "local" for historical reasons only. `.github/workflows/hydrate-universe.yml`
runs the same file unattended — `process.env` takes precedence over `.env.local`,
and the file's absence is not an error.

---

## Prerequisites

Four values must resolve, from `process.env` or `.env.local`:

| Variable | Purpose |
|---|---|
| `ALPACA_API_KEY` | Bar data |
| `ALPACA_API_SECRET` | Bar data |
| `PORTAL_PUSH_SECRET` | `Bearer` auth on the ingest route |
| `DATABASE_URL` | Only for verification queries below; the script itself never touches Neon |

Confirm they're present without printing values:

```bash
grep -oE '^[A-Z0-9_]+' .env.local | sort | grep -E 'ALPACA|PORTAL|DATABASE'
```

A dev server must be listening on `PORTAL_URL` (default `http://localhost:3000`):

```bash
npm run dev
```

**This is required even for `--dry-run`.** The script reads the ticker list
from the portal (`getUniverse()`) before it computes anything, so a dry run
without a server dies on `ECONNREFUSED` from `scripts/hydrate-local.mjs:267`,
not on a credential error. "Dry" means *it does not POST results*, not *it
makes no requests*.

To hydrate a deployed portal instead, set `PORTAL_URL` — but note that a
production push secret in a local shell is a real credential; prefer the
scheduled workflow for anything non-local.

---

## The runs, cheapest first

Always start with a dry run. It fetches bars and computes cards but never
POSTs, so it validates your Alpaca credentials and the indicator math without
writing a row.

```bash
# 1. Dry run, 20 symbols — proves credentials + math, writes nothing
#    (still needs the dev server up: it reads the universe from the portal)
node scripts/hydrate-local.mjs --dry-run --limit=20

# 2. Spot-check specific symbols
node scripts/hydrate-local.mjs --symbols=AAPL,MSFT,NVDA

# 3. One lane only
node scripts/hydrate-local.mjs --universe=etf     # 171 ETFs
node scripts/hydrate-local.mjs --universe=stock   # 762 stocks

# 4. THE FULL UNIVERSE — both lanes, 933 tickers
node scripts/hydrate-local.mjs
```

With no `--universe`, both lanes run in sequence: every active stock, then
every active ETF, each labeled correctly on the way in. **That label is the
reason the lanes are separate** — it is what keeps a 3x inverse ETF from being
ranked as a BUY beside an equity. A chunk mixing the two would have to
mislabel one of them.

### Flags

| Flag | Effect |
|---|---|
| `--dry-run` | Fetch and compute, never POST |
| `--symbols=A,B,C` | Explicit list; treated as stocks unless `--universe=` says otherwise |
| `--limit=N` | First N per lane |
| `--universe=stock\|etf` | One lane only |

A malformed flag value aborts rather than falling through to the full-universe
default — the expensive path is never what a typo meant to ask for.

---

## What a full run looks like

Symbols move in **chunks of 10** (`CHUNK_SIZE`). Each chunk logs its range and
the portal's own written/failed counts, so progress is visible throughout:

```
[hydrate] run=<id> stock=762 etf=171 chunk=10
[stock 1–10]
[stock 11–20]
...
```

Expect roughly **94 chunks** (77 stock + 18 ETF). Wall time is dominated by
Alpaca latency, not compute.

Note that `--limit=N` applies **per lane**, not overall: `--limit=10` runs 10
stocks *and* 10 ETFs for 20 rows total.

### Reading the dry-run output

A verified `--dry-run --limit=10` (2026-08-28) ends:

```
[dry-run] would POST 10 rows (universe=etf)
  → posted: written=10 failed=0
[done] written=20 calc-errors=0 post-failures=0 total=20
```

**`posted:` and `written=` are printed on a dry run too** — they report what
*would* have been written, and no HTTP request was made. Don't read them as
proof of a database write; confirm with the verification query below, which
reads `ticker_cards` directly.

Most symbols in that sample scored `0 / neutral`, with only `BITB` and `BITO`
scoring `62.5 / bearish`. A wall of zeros is normal for a short bar window —
the indicators need enough history to say anything — so it is not by itself a
sign of a broken run.

**One bad symbol costs only itself.** Bars are fetched per-symbol within a
chunk specifically so a single delisted or unavailable ticker can't lose the
other nine — full-universe hydration is only robust if one bad symbol cannot
poison 933 good ones. Written and failed counts are reported separately; a
fully-failed chunk reads `written=0 failed=10`, never `written=10 failed=10`.

---

## Verifying the run

```bash
cat > ./verify.tmp.mjs <<'EOF'
import { neon } from "@neondatabase/serverless";
const sql = neon(process.env.DATABASE_URL);

const [{ total }] = await sql`select count(*)::int as total from ticker_universe where active = true`;
const [{ n: covered }] = await sql`
  select count(distinct ticker)::int as n from ticker_cards
  where computed_at > now() - interval '24 hours'`;
console.log(`carded in last 24h: ${covered}/${total} (${(covered/total*100).toFixed(1)}%)`);

const gaps = await sql`
  select u.ticker from ticker_universe u
  where u.active = true
    and not exists (
      select 1 from ticker_cards c
      where c.ticker = u.ticker and c.computed_at > now() - interval '24 hours')
  order by u.ticker`;
if (gaps.length) console.log("uncovered:", gaps.map(r => r.ticker).join(", "));
EOF
node --env-file=.env.local ./verify.tmp.mjs
rm -f ./verify.tmp.mjs
```

> Write scratch scripts **inside the repo root**, not `/tmp` — a file outside
> the project can't resolve `@neondatabase/serverless` from `node_modules`.
> Delete it afterward.

**Schema note:** the freshness column is `computed_at`, not `generated_at`.
Getting this wrong returns Postgres `42703` (undefined column).

`ticker_cards` columns: `ticker`, `horizon`, `universe`, `state_key`,
`taxonomy_version`, `score`, `score_version`, `action`, `tokens`, `numerics`,
`data_quality`, `missing_fields`, `source`, `source_run_id`, `bar_date`,
`computed_at`.

### Last known-good state (2026-08-28)

| Measure | Value |
|---|---|
| Active universe | 933 (762 stock + 171 etf) |
| Distinct tickers ever carded | 932 (99.9%) |
| `ticker_cards` rows | 1,864 |
| Card timestamps | 2026-08-18T19:12Z → 2026-08-19T06:56Z |
| Source | `hydrate-local` (100%) |
| Never carded | `SKHY` |

Two things worth reading off that table. **Every card in the database came from
this script** — the scheduled workflow's output is indistinguishable in
`source`, so don't infer a manual run from it. And the newest card is from
**2026-08-19**: coverage is ~99.9% but the data is over a week stale. Coverage
and freshness are different questions, and the percentage answers only the
first.

---

## Testing, and what the e2e suite does *not* cover

**No e2e test iterates the universe.** The Playwright suite is ten spec files
(preflight, ci, health, frontend) and none of them sweep tickers. The only
universe-wide test is `__tests__/universe-policy.test.ts`, which is pure by
design and runs without `DATABASE_URL` — if a test there needs a database, the
function under test is in the wrong module.

```bash
npx vitest run __tests__/universe-policy.test.ts   # policy logic, no DB, no network
npx playwright test                                 # app health; ticker-agnostic
```

So "test the whole universe" means **run hydration and check coverage** — the
verification query above — not run a test suite. There is no per-ticker
assertion harness, and the SQL is currently the closest thing to one.

---

## Related

- `scripts/hydrate-local.mjs` — the script
- `app/api/pipeline/hydrate-universe/route.ts` — ingest route and batch contract
- `deploy/universe-hydration/modal_app.py` — same indicator math in Python
- `.github/workflows/hydrate-universe.yml` — the scheduled run
- `docs/universe-by-industry.md` — per-symbol catalog (count now stale)
- `docs/wiki-portal/entity-ticker-universe-pipeline.md` — pipeline entity page
