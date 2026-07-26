# Local Dev Data Hydration

How to fill every **financial-data** column the portal's dashboards read, using
one dev-only seeder — and how to **prove** the hydration is robust enough that
each frontend feature actually renders.

- **Script:** `scripts/hydrate-dev.mjs`
- **Command:** `npm run db:hydrate:dev`
- **Companion:** `docs/storage-structure.html` (the full DB/storage map)

> **Why this exists.** The dashboards read from Neon tables that are normally
> filled by the live gcp3 backend + the weekly/nightly jobs. On a fresh local
> checkout those tables are empty, so `/dashboard/signals`, `/dashboard/holdfold`,
> and `/dashboard/portfolio` render empty states. This seeder writes realistic,
> schema-valid rows so the whole surface lights up offline — and refuses, loudly,
> to run anywhere near production.

---

## 1 · TL;DR

```bash
# one-time: make sure the schema exists
npm run db:migrate

# seed + verify (local DATABASE_URL)
npm run db:hydrate:dev

# read-only readiness report, no writes
npm run db:hydrate:dev -- --verify

# wipe the dev rows first, then re-seed (clean slate)
npm run db:hydrate:dev -- --reset
```

If your `DATABASE_URL` is a **cloud Neon dev branch** (the common case here, not
`localhost`), the guard requires you to opt in explicitly — see
[§5 Safety guards](#5--safety-guards-cannot-run-against-prod).

---

## 2 · How to add it (already done — for reference / re-creation)

Three edits, zero new dependencies (`@neondatabase/serverless` is already a dep):

1. **`scripts/hydrate-dev.mjs`** — the seeder. It mirrors `scripts/db-migrate.mjs`
   for env loading (reads `DATABASE_URL`, falling back to parsing `.env.local`),
   then runs a prod-refusal guard, idempotent upserts, and a verifier.
2. **`package.json`** — one script:
   ```json
   "db:hydrate:dev": "node --env-file=.env.local scripts/hydrate-dev.mjs"
   ```
3. Nothing else. It is **not** wired into `prebuild`/`build`/`postinstall` — it
   must never run automatically. It is a thing you type on purpose.

### Design rules the script follows

| Rule | Why |
|------|-----|
| **Idempotent** — upsert, or delete-dev-rows-then-insert | Re-running converges to one clean state, never duplicates. |
| **One `DEV_USER_ID` constant** (`user_devlocal000000000000000`) | Per-user rows (watchlist, user digest, pending-signals, council session) are all coherent and jointly queryable. |
| **Fixed `DEV_SESSION_ID` UUID** | Council session/verdicts re-seed idempotently instead of accumulating. |
| **Sentinels for identity-PK cache tables** | `signal_digest_cache` keys on `period_label='DEV (local hydrate)'`; `holdfold_cache` rows carry `payload._source='dev-hydrate'` — so cleanup is scoped and never touches real cached rows. |
| **Payloads derived from one `TICKERS` table** | The digest, Hold/Fold, and per-ticker `signal_cache` all agree on price/RSI/MACD for a given ticker. |

---

## 3 · What gets hydrated (per-table column coverage)

Seeded tickers: **AAPL, NVDA, MSFT, TSLA, SPY** (plus AMD/GOOG/META in the
pending-signals queue to exercise its states). Every column below is written with
a **valid, render-ready** value — not a placeholder.

### `signal_digest_cache` — global signals digest
`payload` is a full `DigestPayload` (`lib/digest.ts`, `schemaVersion: 1`).

| column | seeded? | notes |
|--------|:------:|-------|
| `period_label` | ✓ | `"DEV (local hydrate)"` (the cleanup key) |
| `payload.schemaVersion` | ✓ | `1` — matches `DIGEST_SCHEMA_VERSION` |
| `payload.periodLabel` | ✓ | |
| `payload.signals[]` | ✓ | 5 `SignalPayload`s |
| `payload.signals[].{id,ticker,direction,timeframe,confidence,title,explanation,indicators,generatedAt}` | ✓ | all required fields |
| `payload.signals[].{score,reasons,signalCounts,engineVersion,dataQualityScore}` | ✓ | all **optional** fields populated too |
| `payload.signals[].isStale` | ✓ | `false` — `generatedAt` is `now()`, well inside the 26h stale threshold |
| `payload.{generatedAt,sources}` | ✓ | `sources: ["dev-hydrate"]` |
| `generated_at` | ✓ | defaults to `now()` |

### `user_digest_cache` — per-user digest
| column | seeded? | notes |
|--------|:------:|-------|
| `user_id` | ✓ | `DEV_USER_ID` |
| `payload` | ✓ | same `DigestPayload` |
| `expires_at` | ✓ | `now() + 24h` (read path requires `> now()`) |

### `holdfold_cache` — Hold/Fold verdicts
`payload` is a full `HoldFoldPayload` (`app/api/holdfold/route.ts`), 15-min TTL.

| column | seeded? | notes |
|--------|:------:|-------|
| `payload.verdicts[]` | ✓ | one per ticker |
| `payload.verdicts[].{ticker,verdict,confidence,confidenceLabel,bias,industry,price,high52w,low52w,updatedAt}` | ✓ | all required |
| `payload.verdicts[].{rsi,macd,adx}` | ✓ | numeric (never left `null` in the seed, though the type allows it) |
| `payload.verdicts[].returns` | ✓ | `{1d,1w,1mo,3mo,1y}` |
| `payload.verdicts[].signals[]` | ✓ | `{signal,strength,detail,category}` × 3 |
| `payload.verdicts[].{aiSummary,aiOutlook}` | ✓ | |
| `payload.{total,holdCount,foldCount,neutralCount,updatedAt}` | ✓ | counts computed from verdicts |
| `generated_at` | ✓ | `now()` → inside 15-min TTL |

### `signal_cache` — per-ticker L2 (raw gcp3 shape)
| column | seeded? | notes |
|--------|:------:|-------|
| `ticker` (PK) | ✓ | upsert |
| `payload` | ✓ | `{symbol,action,price,ai_confidence,ai_summary,ai_outlook,rsi,macd,adx,high_52w,low_52w,industry,bias,generated_at,top_signals[]}` |
| `generated_at` | ✓ | `now()` → `isCacheFresh` true within `CACHE_TTL_MINUTES` (15) |

### `backtest_hit_rates` — nightly hit-rate buckets
Two rows per ticker: a `category` bucket (`MA_CROSS`) and a `strength` bucket
(`STRONG BULLISH` / `STRONG BEARISH` / `NEUTRAL`).

| column | seeded? |
|--------|:------:|
| `ticker,bucket_kind,bucket_key` (PK) | ✓ |
| `hits,total,hit_rate` | ✓ (`hit_rate = hits/total`) |
| `computed_at` | ✓ |

### `watchlist_items` — primary user data
| column | seeded? | notes |
|--------|:------:|-------|
| `user_id,ticker` (PK) | ✓ | every seeded ticker on the dev watchlist |
| `added_at` | ✓ | `now()` |

### `pending_signals` — the watchlist→signals queue
Seeds all three states so the drain loop and any status UI can be exercised:

| ticker | status | attempts | error |
|--------|--------|:-------:|-------|
| AMD | `pending` | 0 | — (respects the one-pending-per-ticker unique index) |
| GOOG | `done` | 0 | — |
| META | `error` | 3 | `"gcp3 timeout (seeded)"` |

### `council_sessions` + `council_verdicts`
Session seeded first (FK parent), then two verdicts (NVDA bullish/high,
TSLA bearish/medium) with `{direction,confidence,horizon,invalidation}`.

### Deliberately **not** seeded
- `corpus_chunks`, `grounding_pack`, `grounding_misses` — compile-time grounding
  is produced by `scripts/compile_grounding_pack.mjs` from `corpus/`; seeding fake
  rules would poison citations. Use the real compile job.
- `council_messages`, `council_usage`, `nuai_usage` — not financial data / not
  needed to render the target dashboards. Add later if a feature needs them.
- `PortfolioHealth` — **computed**, not stored (see the feature matrix note).

---

## 4 · Verifying robustness

Run the built-in verifier — it does **not** just count rows, it answers the
question each dashboard actually asks: *"is there enough data for me to render?"*

```bash
npm run db:hydrate:dev -- --verify
```

### 4a · Per-table check
Each table is compared against an **expected minimum** row count for the dev
fixture (e.g. `signal_cache` must have ≥ 5, `backtest_hit_rates` ≥ 10). Output:

```
── Per-table hydration ──────────────────────────────
  ✓ signal_digest_cache   1/1
  ✓ user_digest_cache     1/1
  ✓ holdfold_cache        1/1
  ✓ signal_cache          5/5
  ✓ backtest_hit_rates    10/10
  ✓ watchlist_items       5/5
  ✓ pending_signals       3/3
  ✓ council_verdicts      2/2
```

Crucially, the checks are **freshness-aware**, matching the real read paths:
- `holdfold_cache` is only counted if `generated_at > now() - 15 min` (the TTL the route enforces).
- `user_digest_cache` is only counted if `expires_at > now()`.

So a "green" verify means the data is not just present but **within the TTL
window the app requires** — the exact failure that a naive `SELECT count(*)`
would miss.

### 4b · Per-frontend-feature readiness matrix
A feature is `READY` only if **every** table it reads is populated:

```
── Per-frontend-feature readiness ───────────────────
  ✓ READY  Signals dashboard (/dashboard/signals)
  ✓ READY  Hold/Fold (/dashboard/holdfold)
  ✓ READY  Portfolio (/dashboard/portfolio)
  ✓ READY  Watchlist → pending-signals loop
  ✓ READY  Council verdicts
  ✓ READY  Per-ticker signal lookup (Nu AI / grounding)
```

| Feature | Reads | Is the data enough to render? |
|---------|-------|-------------------------------|
| **Signals dashboard** | `signal_digest_cache`, `user_digest_cache` | Yes — 5 signals, all optional fields set, `isStale:false`. Filter state persists to `localStorage` (`signals-filter`), not the DB. |
| **Hold/Fold** | `holdfold_cache` | Yes — 5 verdicts across HOLD/FOLD/NEUTRAL, counts consistent, inside 15-min TTL. |
| **Portfolio** | `watchlist_items` (+ `signal_cache`, `backtest_hit_rates` for enrichment) | Yes for the watchlist + health inputs. **Note:** `PortfolioHealth` is *computed* from these, not stored — a green here means the inputs exist; the score is derived at request time. |
| **Watchlist → pending-signals** | `watchlist_items`, `pending_signals` | Yes — watchlist populated and all three queue states present. |
| **Council verdicts** | `council_verdicts` (FK `council_sessions`) | Yes — session + 2 verdicts. |
| **Per-ticker lookup (Nu AI / grounding)** | `signal_cache` | Yes — 5 fresh entries; `isCacheFresh` true so lookups short-circuit the backend. |

### 4c · Manual end-to-end verification
After seeding, confirm the data reaches the pixels:

```bash
npm run dev
```
Then visit — signed in as any user for shared/global caches, or set your local
session to `DEV_USER_ID` for the per-user rows:
- `http://localhost:3000/dashboard/signals` → 5 signal cards, no empty state
- `http://localhost:3000/dashboard/holdfold` → verdict table with HOLD/FOLD/NEUTRAL
- `http://localhost:3000/dashboard/portfolio` → 5-ticker watchlist + health score

> **Per-user caveat.** `user_digest_cache`, `watchlist_items`, `pending_signals`,
> and the council session are keyed to `DEV_USER_ID`. If your local Clerk session
> is a *different* user, you'll see the **global** digest/holdfold caches (which
> are user-agnostic) but not the seeded watchlist. Either sign in as a user whose
> id you set to `DEV_USER_ID`, or change the constant at the top of the script to
> your real local Clerk userId and re-run.

---

## 5 · Safety guards (cannot run against prod)

The seeder refuses to run unless it is certain it's a dev target. Order of checks:

1. **`NODE_ENV=production`** → hard refuse.
2. **`VERCEL` or `CI` env present** → hard refuse (you're not on a dev box).
3. **Prod marker in host or db name** (`prod`, `production`, `-main`, `/main`) →
   hard refuse, *even with `--force`*.
4. **Local host** (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`) →
   allowed freely.
5. **Any other (cloud) host** → refused **unless** you pass `--force` **and** set
   `DEV_HYDRATE_CONFIRM` to the exact host string. This is the intended path for a
   throwaway **Neon dev branch**:

```bash
# for a cloud Neon dev branch (NOT prod):
DEV_HYDRATE_CONFIRM=ep-your-dev-branch-123.neon.tech \
  npm run db:hydrate:dev -- --force
```

Observed guard behavior (verified):

| DATABASE_URL host | flags | result |
|-------------------|-------|--------|
| `ep-prod-db.neon.tech/neondb` | any | ✖ refused (prod marker) |
| `ep-cool-forest-123.neon.tech` | none | ✖ refused (non-local, no confirm) |
| `localhost:5432/dev`, `NODE_ENV=production` | any | ✖ refused (NODE_ENV) |
| `localhost:5432/dev` | none | ✓ allowed |
| `ep-cool-forest-123.neon.tech` | `--force` + matching `DEV_HYDRATE_CONFIRM` | ✓ allowed |

> There is no `--yes-really-prod` escape hatch by design. If you genuinely need
> prod-like data, take a Neon branch of prod and point `DATABASE_URL` at the
> *branch* (whose host differs), never at prod itself.

---

## 6 · Failure & edge cases

| Case | Behavior |
|------|----------|
| Schema not migrated (`relation ... does not exist`) | Script throws and exits non-zero. Fix: `npm run db:migrate` first. |
| Run twice | Idempotent — upserts/sentinel-deletes converge; no duplicate rows. |
| Real cached rows already present | Untouched. Cleanup is scoped by `period_label` / `payload._source` sentinels, so your real `holdfold_cache`/`signal_digest_cache` rows survive. |
| `holdfold_cache` age > 15 min after seeding | The route treats it as stale and re-fetches live. `--verify` reflects this (freshness-gated count). Re-run to refresh `generated_at`. |
| `pending_signals` already has a live `pending` row for AMD | The `WHERE NOT EXISTS` guard skips the insert — respects the one-pending-per-ticker unique index instead of erroring. |
| Local Clerk session ≠ `DEV_USER_ID` | Per-user features look empty; global caches still render. See §4c caveat. |
| Neon connection error to `localhost` | `@neondatabase/serverless` speaks HTTP; a bare Postgres on `localhost:5432` isn't a Neon HTTP endpoint. Use a Neon dev branch (with the `--force` opt-in) or the Neon local proxy. |

---

## 7 · Troubleshooting

- **"DATABASE_URL is not set"** — it's not in `.env.local` and not exported. Add it
  to `.env.local` (the npm script passes `--env-file=.env.local`).
- **Guard refuses my dev branch** — that's intended for cloud hosts. Re-run with
  `--force` and `DEV_HYDRATE_CONFIRM=<exact-host>` (copy the host from the refusal
  message).
- **Dashboards still empty after a green verify** — you're likely signed in as a
  non-dev user (per-user rows are keyed to `DEV_USER_ID`), or an L1 in-memory
  route cache is serving a pre-seed miss; hard-reload / restart `next dev`.
- **`--verify` shows a GAP right after seeding** — almost always a freshness
  window: the `holdfold_cache`/`user_digest_cache` row aged out. Re-run the seed
  (no `--verify`) to refresh timestamps.
- **Want a clean slate** — `npm run db:hydrate:dev -- --reset` removes all dev
  rows (scoped to `DEV_USER_ID` / dev sentinels) before seeding.

---

## 8 · Extending the seeder

- **More tickers:** add to the `TICKERS` array — every payload is derived from it,
  so all surfaces stay consistent automatically.
- **A new financial table:** add a builder + an idempotent upsert in `seed()`, add
  a `checks`/`expect` entry in `verify()`, and map it into the feature matrix in
  `verify()`'s `features` object so readiness stays honest.
- **Your real local userId:** change `DEV_USER_ID` at the top of the script.

---

_Sources: `scripts/hydrate-dev.mjs`, `scripts/db-migrate.mjs`, `lib/db/schema.sql`,
`lib/digest.ts`, `app/api/holdfold/route.ts`, `lib/shared/signal-policy.ts`,
`lib/portfolio.ts`, `package.json`. Generated 2026-07-24._
