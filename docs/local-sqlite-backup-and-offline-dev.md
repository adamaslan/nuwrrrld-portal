# Local SQLite Backup + Populating It Like GitHub Actions Would

**Goal:** (1) have a local SQLite backup of the portal's Neon database, and
(2) know how to fill it with the same shape of data the GitHub Actions
pipelines produce in production — offline, without necessarily hitting Neon
or paying for OpenRouter/Alpaca every time.

**Status:** Part 1 (backup) is built, tested against the real production
database, and ready to use today. Part 2 (a live SQLite-backed local dev
server, so the whole app runs 100% offline) is scoped but **not** built —
see [§4](#4-phase-2-not-built-a-live-sqlite-backed-dev-server) for why, and
what it would take.

---

## 0. Two different things people mean by "run it locally on SQLite"

Worth separating up front, because they have very different costs:

| | What it is | Status |
|---|---|---|
| **A. Backup** | A point-in-time copy of Neon's data in a local `.sqlite` file, for disaster recovery / offline inspection. The app never reads it. | ✅ Built (§1) |
| **B. Live local DB** | The Next.js dev server itself reads/writes SQLite instead of Neon, so `npm run dev` needs zero network/Neon access. | 📋 Scoped, not built (§4) |

This doc delivers **A** in full and documents **B** honestly as a bigger,
riskier follow-up — see §4 for exactly why it's not a weekend job.

---

## 1. The backup (built, tested)

### 1.1 What exists

- **`lib/db/schema.sqlite.sql`** — a SQLite translation of every table in
  [`lib/db/schema.sql`](../lib/db/schema.sql) (30 tables, kept in exact
  parity — verified by diffing table-name lists).
- **`scripts/backup-to-sqlite.mjs`** — reads every table from the real Neon
  database (`DATABASE_URL`) and writes a snapshot into a local SQLite file,
  using Node's **built-in** `node:sqlite` module (Node 22.5+). No new
  dependency, no native build step, no `npm install`.

```bash
# Full backup, all 30 tables, timestamped file under backups/
node --env-file=.env.local scripts/backup-to-sqlite.mjs

# Specific tables only
node --env-file=.env.local scripts/backup-to-sqlite.mjs \
  --tables=ticker_universe,ticker_cards,followed_ticker_picks

# Exclude the heaviest/lowest-value tables for a quick smoke backup
node --env-file=.env.local scripts/backup-to-sqlite.mjs \
  --exclude=corpus_chunks,grounding_pack

# Explicit output path
node --env-file=.env.local scripts/backup-to-sqlite.mjs --out=backups/manual.sqlite
```

Verified against production on 2026-09-03 (see the type-checking work below —
real run, real counts):

```
✓ ticker_cards                       1864 rows
✓ ticker_universe                     983 rows
✓ watchlist_items                      15 rows
✓ pending_signals                       9 rows
✓ backtest_hit_rates                   10 rows
... (30 tables, 2904 rows total, 1.9s)
```

Inspect the result with any SQLite client — no credentials, no network:

```bash
sqlite3 backups/nuwrrrld-<timestamp>.sqlite ".tables"
sqlite3 backups/nuwrrrld-<timestamp>.sqlite "SELECT ticker, action, score FROM ticker_cards ORDER BY score DESC LIMIT 10;"
```

### 1.2 Why it never overwrites anything

Each run either writes to a fresh timestamped path
(`backups/nuwrrrld-2026-09-03_14-22-01.sqlite`) or refuses to run if `--out`
already points at an existing file. A bad run can never destroy a previous
good backup — consistent with the repo-wide rule that destructive operations
need an explicit opt-in, not a default.

`backups/` is gitignored (`backups/.gitignore`, added alongside this doc) —
these files can contain user identifiers (Clerk user IDs, IP hashes, consent
records) and must never be committed.

### 1.3 Type translation (why this isn't a straight `pg_dump`)

SQLite doesn't have most of Postgres's types. `scripts/backup-to-sqlite.mjs`
reads each column's real type from `information_schema.columns` (not a
hand-maintained map, so it won't silently drift from `schema.sql`) and
coerces accordingly:

| Postgres type | SQLite storage | Note |
|---|---|---|
| `jsonb` / `json` | `TEXT` | `JSON.stringify()`'d; query with `json_extract(col, '$.field')` |
| `text[]` (arrays) | `TEXT` | JSON array string, e.g. `'["a","b"]'` |
| `timestamptz` / `date` | `TEXT` | ISO 8601 (`toISOString()` for `Date` objects Neon already returns) |
| `uuid` | `TEXT` | the UUID string, verbatim |
| `boolean` | `INTEGER` | `0`/`1` |
| `numeric` | `REAL` | **loses Postgres's arbitrary precision** — fine for inspection, wrong for re-deriving money math from the backup |
| `inet` | `TEXT` | |
| `tsvector` (generated column) | *(dropped)* | `corpus_chunks.tsv` and its GIN index don't exist in the mirror at all — full-text search isn't a backup goal; see §4 if that changes |

### 1.4 A real finding: the live database has 4 tables `schema.sql` doesn't know about

Running the backup for real turned up `comments`, `invoices`,
`processed_webhook_events`, and `rate_limit_counters` in the live Neon
database — **none of them declared in `lib/db/schema.sql`**, and none
referenced anywhere in this repo's current code (`grep` across `lib/`,
`app/`, `scripts/` found nothing).

`invoices`' columns (`customer_email`, `customer_name`, `address_line1/2`,
`city`, `state`, `postal_code`, `country`, `pay_currency`, `order_description`,
`item_url`) do not match this app's Stripe-based billing model at all —
`pay_currency` and `item_url` read like a **different application's**
crypto-payment schema, sharing this Neon project. 26 rows of what looks like
real customer PII currently sit in the same database as this portal's
telemetry.

**The backup script already does the safe thing by default**: it only backs
up tables present in `lib/db/schema.sqlite.sql`, so these four are skipped
with a loud `⚠ skipping "invoices" — not present in lib/db/schema.sqlite.sql
yet` warning rather than silently vacuumed into a file this repo's `.gitignore`
governs. **Do not add them to `schema.sqlite.sql` without first confirming
what they are and who owns that data** — this looks like it may need a
conversation with whoever else has a Neon connection string to this project,
not a schema migration.

---

## 2. "Populate the SQLite backup with the same data GitHub Actions would produce"

Two ways to read this, both covered:

### Method A — mirror what's already there (simplest, works today)

GitHub Actions writes into the **same production Neon database** this repo's
`DATABASE_URL` points at. So the moment a workflow runs, `sql> [table]`
already has the new data — running `scripts/backup-to-sqlite.mjs` right
after (or on a schedule) gives you a SQLite copy of exactly what GitHub
Actions produced, because it's reading the same rows.

```bash
# after a workflow runs (or on a cron of your own), refresh the backup:
node --env-file=.env.local scripts/backup-to-sqlite.mjs
```

This is the "backup," full stop — no simulation, no re-running pipelines,
just a snapshot of ground truth.

### Method B — regenerate the data yourself, without touching production

Sometimes you want the *data shape* without touching the real database at
all (e.g. testing against a dev Neon branch, or reproducing what a workflow
does step by step). Every scheduled workflow in `.github/workflows/` is a
thin wrapper around a script or an authenticated `curl` to this app's own
API — nothing GitHub-Actions-specific about the actual work. Run the same
commands locally against a running `npm run dev` (or a deployed preview) and
a **dev-safe** `DATABASE_URL` (a Neon branch, never production — see the
guard logic in `scripts/hydrate-dev.mjs`), and you get equivalent data.

**Current constraint, stated plainly:** `lib/db.ts` uses
`@neondatabase/serverless`'s `neon()` client, which speaks Neon's own
HTTP-over-fetch protocol — it cannot talk to a bare local Postgres or to
SQLite. So "locally" here means *a local dev server pointed at a real
(free) Neon dev branch*, not yet a fully offline SQLite-backed server. See
§4 for what closing that gap would take.

#### The full table — every scheduled workflow, its actual command, and what it fills

| Workflow (cron) | What it actually runs | Tables it fills | Requires |
|---|---|---|---|
| [`hydrate-universe.yml`](../.github/workflows/hydrate-universe.yml) (22:30 UTC wkdy) | `node scripts/hydrate-local.mjs` → `POST /api/pipeline/hydrate-universe` | `ticker_universe`, `ticker_cards` | `ALPACA_API_KEY/SECRET`, `PORTAL_PUSH_SECRET`, dev server up ([full guide](running-universe-hydration-locally.md)) |
| [`precompute-ai.yml`](../.github/workflows/precompute-ai.yml) (00:10 UTC daily) | `curl -X POST $PORTAL_URL/api/pipeline/precompute-ai` | `precomputed_ai` | `PORTAL_PUSH_SECRET`, `OPENROUTER_API_KEY` (server-side) |
| [`select-followed-tickers.yml`](../.github/workflows/select-followed-tickers.yml) (1st of month, 14:00 UTC) | `curl -X POST $PORTAL_URL/api/pipeline/followed-tickers-select` | `followed_ticker_picks` | `PORTAL_PUSH_SECRET` |
| [`track-followed-tickers.yml`](../.github/workflows/track-followed-tickers.yml) (20:30/19:30 UTC wkdy) | `curl -X POST $PORTAL_URL/api/pipeline/followed-tickers` | `followed_ticker_observations`, `followed_ticker_scores` | `PORTAL_PUSH_SECRET` |
| [`judge-followed-tickers.yml`](../.github/workflows/judge-followed-tickers.yml) (Sat 16:00 UTC) | `curl -X POST $PORTAL_URL/api/pipeline/followed-tickers-judge` | `followed_ticker_scores` (judge fields) | `PORTAL_PUSH_SECRET`, `OPENROUTER_API_KEY` |
| [`compile-grounding-pack.yml`](../.github/workflows/compile-grounding-pack.yml) (Mon 06:23 UTC) | `node scripts/compile_grounding_pack.mjs` — **writes to `DATABASE_URL` directly**, no HTTP hop | `corpus_chunks`, `grounding_pack` | `DATABASE_URL`, `OPENROUTER_API_KEY` (or `--dry-run`, no key needed) |
| [`refresh-free-models.yml`](../.github/workflows/refresh-free-models.yml) (Mon 06:17 UTC) | `node scripts/refresh-free-models.mjs` | *(rewrites `lib/openrouter.ts`, not a DB table)* | `OPENROUTER_API_KEY` |
| [`afternoon-pipeline.yml`](../.github/workflows/afternoon-pipeline.yml) (20:15/19:15 UTC wkdy) | 4 sequential `curl -X POST` calls: `.../signals-refresh`, `.../council-run`, `.../theses-score`, `.../council-validate-distribution` (each accepts `{"dry_run": true}`) | `signal_digest_cache`, `council_sessions/messages/verdicts`, `precomputed_ai` | `PORTAL_PUSH_SECRET` |

Every `curl` row above can be pointed at `http://localhost:3000` with the
exact same `-d`/`-H` flags shown in the workflow file — that's the entire
technique. Example, reproducing `precompute-ai.yml` locally:

```bash
npm run dev &                      # a dev server must be up
curl -sS -X POST http://localhost:3000/api/pipeline/precompute-ai \
  -H "Authorization: Bearer $PORTAL_PUSH_SECRET" \
  -H "Content-Type: application/json"
```

Then back it up:

```bash
node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=precomputed_ai
```

`compile-grounding-pack.yml`'s script is the one exception worth knowing —
it never goes through the portal's HTTP API at all, so running it locally
means literally running `node scripts/compile_grounding_pack.mjs` (add
`--dry-run` to chunk + extract without writing, per its own header docs) —
no dev server needed for that one specifically.

---

## 3. Quick-start checklist

```bash
# 1. One-time: confirm the SQLite schema matches lib/db/schema.sql
node -e "
  const {DatabaseSync} = require('node:sqlite');
  const fs = require('node:fs');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync('lib/db/schema.sqlite.sql','utf8'));
  console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().length, 'tables created');
"

# 2. Take a backup right now
node --env-file=.env.local scripts/backup-to-sqlite.mjs

# 3. (optional) Reproduce one pipeline's output locally first, then re-back-up
npm run dev &
curl -sS -X POST http://localhost:3000/api/pipeline/precompute-ai \
  -H "Authorization: Bearer $PORTAL_PUSH_SECRET"
node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=precomputed_ai

# 4. Inspect
sqlite3 backups/nuwrrrld-*.sqlite ".tables"
```

---

## 4. Phase 2 (not built): a live SQLite-backed dev server

If the actual goal is "run the whole app with zero network dependency,"
that's a materially bigger change than the backup above, and is intentionally
out of scope here. Recorded so it isn't re-discovered from scratch later.

**Why it's not a small change:**

1. **`lib/db.ts` is hardcoded to Neon's HTTP driver.** `neon(process.env.DATABASE_URL!)`
   only speaks Neon's fetch-based SQL protocol — it cannot be pointed at a bare
   local Postgres, let alone SQLite. A live mode needs a driver switch (e.g.
   `DATABASE_URL` starting with `file:` routes to a `node:sqlite`-backed
   shim implementing the same tagged-template call signature) in the one
   file **26 other files** import from (`grep -rl 'from "@/lib/db"' lib app scripts`).
2. **The shim can translate placeholders, not arbitrary SQL.** Neon's `sql`
   tag builds Postgres `$1`-style parameterized queries from a template
   literal; a SQLite shim would need to rewrite that into `?`-style params —
   mechanical. But the *SQL text itself* in those 26 files is real Postgres:
   `ON CONFLICT ... DO UPDATE`, `RETURNING`, `now()`, `gen_random_uuid()`,
   `= ANY($1)`, `->>'field'` on jsonb, `@@ plainto_tsquery(...)` full-text
   search, `::text[]` casts. SQLite supports some of this (`ON CONFLICT` since
   3.24, no native `RETURNING` before 3.35, no `gen_random_uuid()`, no GIN/tsvector
   at all) and none of it is auditable from the schema alone — it requires
   reading every query site.
3. **`corpus_chunks`'s full-text search has no SQLite equivalent as-is.**
   The Postgres side uses a `GENERATED ALWAYS AS (tsvector...) STORED` column
   with a GIN index (see `lib/db/schema.sql`'s `immutable_corpus_tsvector`
   function). The closest SQLite analog is an FTS5 virtual table — a
   different mechanism, would need `lib/grounding-*` query sites rewritten,
   not just the schema.
4. **Realistic scope, if pursued:** start with the tables Method B already
   populates via HTTP routes (`ticker_universe`, `ticker_cards`,
   `precomputed_ai`, `followed_ticker_*`) — pure upsert-shaped writes, no
   full-text search, no complex jsonb operators — and defer
   `corpus_chunks`/`grounding_pack` (the FTS-dependent ones) and the
   auth/consent/legal tables (lower value for offline dev, higher
   sensitivity) to a later pass, if ever.

Not building this now was a deliberate scope call, not an oversight: the
concrete ask was a backup, which is now real and tested; a live SQLite
runtime is a cross-cutting change to the one module every DB-backed route in
the app imports, and deserves its own planning pass rather than being
sketched in under a backup doc's afterword.

---

## 5. Files this doc introduced

- `lib/db/schema.sqlite.sql` — SQLite translation of `lib/db/schema.sql`
- `scripts/backup-to-sqlite.mjs` — Neon → SQLite snapshot exporter
- `backups/.gitignore` — keeps snapshot files out of version control
- This file
