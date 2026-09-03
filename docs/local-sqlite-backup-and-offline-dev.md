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

### 2.1 Method A — mirror what's already there (simplest, works today)

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

### 2.2 Method B — regenerate the data yourself, without touching production

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

Two secrets gate almost everything below — confirm both are set (values
never printed) before running any workflow's reproduction commands:

```bash
grep -c '^PORTAL_PUSH_SECRET=' .env.local   # gates rows 1–2
grep -c '^CRON_SECRET='         .env.local  # gates rows 3–5 and (eventually) 7
```

A `0` for either means every route it gates will 503 with a `CONFIG_ERROR`
before doing any real work — that 503 is not a bug in the route, it's the
route correctly refusing to run unauthenticated.

#### 2.2.1 At-a-glance summary of the 7 pipelines

Verified against the actual route source (`app/api/pipeline/*/route.ts`), not
just the workflow YAML — the two disagree in two places, flagged below.

| # | Workflow (cron, UTC) | Auth secret | Route exists? | Tables it fills |
|---|---|---|---|---|
| 1 | [`hydrate-universe.yml`](../.github/workflows/hydrate-universe.yml) (22:30 wkdy) | `PORTAL_PUSH_SECRET` | ✅ `app/api/pipeline/hydrate-universe` | `ticker_universe`, `ticker_cards` |
| 2 | [`precompute-ai.yml`](../.github/workflows/precompute-ai.yml) (00:10 daily) | `PORTAL_PUSH_SECRET` | ✅ `app/api/pipeline/precompute-ai` | `precomputed_ai` |
| 3 | [`select-followed-tickers.yml`](../.github/workflows/select-followed-tickers.yml) (1st @ 14:00) | **`CRON_SECRET`** | ✅ `app/api/pipeline/followed-tickers-select` | `followed_ticker_picks` |
| 4 | [`track-followed-tickers.yml`](../.github/workflows/track-followed-tickers.yml) (~15:30 ET wkdy) | **`CRON_SECRET`** | ✅ `app/api/pipeline/followed-tickers` | `followed_ticker_observations`, `followed_ticker_scores` |
| 5 | [`judge-followed-tickers.yml`](../.github/workflows/judge-followed-tickers.yml) (Sat 16:00) | **`CRON_SECRET`** | ✅ `app/api/pipeline/followed-tickers-judge` | `followed_ticker_scores` (judge columns) |
| 6 | [`compile-grounding-pack.yml`](../.github/workflows/compile-grounding-pack.yml) (Mon 06:23) | *(none — writes `DATABASE_URL` directly)* | ✅ `scripts/compile_grounding_pack.mjs` (no route at all) | `corpus_chunks`, `grounding_pack` |
| 7 | [`afternoon-pipeline.yml`](../.github/workflows/afternoon-pipeline.yml) (~15:15 ET wkdy) | `CRON_SECRET` | ❌ **none of its 4 routes exist yet** | *(none reachable — see §2.3.7)* |

**Two corrections to what the workflow files themselves say**, found by
reading the route source rather than trusting the YAML comments:

- Rows 3–5 (`select`/`track`/`judge`-followed-tickers) each carry a workflow
  comment reading `ROUTE STATUS: ... does NOT exist yet`. That was true when
  those workflows were written (shipped ahead of their endpoints, PR #85) but
  is **stale** — all three routes exist today and check `CRON_SECRET`, not
  `PORTAL_PUSH_SECRET`. The comments were never updated after the routes
  landed (PR #88). Don't trust a workflow's inline "not built yet" comment
  without checking `app/api/pipeline/` yourself.
- **`CRON_SECRET` is likely unset in your `.env.local`** — check with
  `grep -c '^CRON_SECRET=' .env.local`. It's already a documented var
  ([`.env.example`](../.env.example), originally for the retention-digest
  cron) but a fresh `.env.local` copied before that reuse won't have it.
  Every one of rows 3, 4, 5, and 7 will 503
  `"CRON_SECRET not configured"` without it — generate one with
  `openssl rand -hex 32` and add it before attempting any of them locally.

### 2.3 Every workflow, in the depth needed to actually reproduce it

#### 2.3.1 `hydrate-universe.yml` — the ticker coverage pipeline

The only one of the 7 that computes off-Neon: it fetches Alpaca bars and
computes indicators **in the GitHub runner itself**, then POSTs the finished
rows. `POST /api/pipeline/hydrate-universe` never talks to Alpaca — that's
why this is the one workflow needing `ALPACA_API_KEY`/`ALPACA_API_SECRET` in
addition to the portal secret.

- **Command chain:** `node scripts/hydrate-local.mjs [flags]` → computes
  indicators for each symbol → `POST {PORTAL_URL}/api/pipeline/hydrate-universe`
  with the computed rows.
- **Auth:** `Authorization: Bearer $PORTAL_PUSH_SECRET`.
- **Required env:** `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `PORTAL_PUSH_SECRET`.
  `PORTAL_URL` defaults to `http://localhost:3000` if unset (see
  `scripts/hydrate-local.mjs:48`) — this is the one workflow that's
  local-by-default without having to override anything.
- **CLI flags** (verified against the script's `process.argv` parsing, not
  just its `--help`): `--dry-run` (compute, never POST), `--symbols=AAPL,MSFT`
  (spot-check specific tickers), `--limit=N` (cap symbols per lane),
  `--universe=stock` or `--universe=etf` (one lane only; omit for both).
- **A dev server must be running even for `--dry-run`** — the script reads
  the ticker list from the portal (`getUniverse()`) before computing
  anything, so `ECONNREFUSED` happens before any credential is even checked.
- **Tables filled:** `ticker_universe` (upsert on `ticker`), `ticker_cards`
  (upsert on `(ticker, horizon)` — one card per ticker per horizon, so a full
  run of N tickers writes up to 2N rows).

```bash
npm run dev &
node --env-file=.env.local scripts/hydrate-local.mjs --dry-run --limit=20   # proves credentials + math, writes nothing
node --env-file=.env.local scripts/hydrate-local.mjs --symbols=AAPL,MSFT,NVDA
node --env-file=.env.local scripts/hydrate-local.mjs --universe=etf         # full ETF lane
node --env-file=.env.local scripts/hydrate-local.mjs                        # full universe, both lanes

node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=ticker_universe,ticker_cards
```

Full walkthrough, including the 933-ticker cost and how to verify row counts,
in [`running-universe-hydration-locally.md`](running-universe-hydration-locally.md)
— this doc doesn't repeat that one, it cross-references it.

#### 2.3.2 `precompute-ai.yml` — nightly AI artifact batch

- **Command chain:** one `curl -X POST` to
  `{PORTAL_URL}/api/pipeline/precompute-ai`. All compute happens inside the
  route (server-side OpenRouter calls) — the runner just triggers it.
- **Auth:** `Authorization: Bearer $PORTAL_PUSH_SECRET`.
- **Request body:** `{"maxSubjects": <int>, "source": <string>}` —
  `maxSubjects` is clamped to `[1, 25]` (`MAX_SUBJECTS_CEILING = 25` in the
  route), default `10` when omitted; `source` picks which subjects to
  precompute (`resolvePrecomputeSource`) — omit it locally unless
  reproducing a specific source's behavior.
- **Response fields worth checking:** `generated`, `attempted`,
  `quotaExhausted` — the workflow itself treats `attempted > 0 && generated
  === 0` as a hard failure (every model call failed) even though the HTTP
  status was 2xx, which a naive "did curl succeed" check would miss.
- **Tables filled:** `precomputed_ai`, upsert on `(kind, subject)`.
- **Cost:** real OpenRouter calls — `maxSubjects=10` locally is a reasonable
  smoke test; the production job budgets against the shared daily free-tier
  quota reset at UTC midnight (see [[entity-openrouter-client]] failure #3 in
  the wiki), which a local run competes against if run same-day.

```bash
npm run dev &
curl -sS -X POST http://localhost:3000/api/pipeline/precompute-ai \
  -H "Authorization: Bearer $PORTAL_PUSH_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"maxSubjects": 3}' | jq .

node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=precomputed_ai
```

#### 2.3.3 `select-followed-tickers.yml` — monthly cohort freeze

- **Command chain:** one `curl -X POST` to
  `{PORTAL_URL}/api/pipeline/followed-tickers-select`, then (production only,
  `contents: write` permission) a bot commit splicing the response's
  `renderedCohort` into `docs/tickers-followed.md` between
  `<!-- FT:COHORT:START/END -->` markers. **The doc-splice step is
  production-only tooling** (needs a `git push`-capable token) — running the
  route locally will select and persist a cohort in the database without
  touching that file; that's fine for testing the data path.
- **Auth:** `Authorization: Bearer $CRON_SECRET` — **not** `PORTAL_PUSH_SECRET`
  (see the correction above; both the workflow's own comment and an earlier
  version of this doc had this wrong).
- **Request body:** `{"universe": "all"|"stock"|"etf", "count": 10, "dry_run": bool}`
  (route reads `universe`/`count`/`dry_run`, all optional — `count` defaults
  inside `resolveUniverseScope`/the route body if omitted).
- **Gate:** production only fires on the 1st of the month (NY wall clock) —
  irrelevant locally via `workflow_dispatch`/direct `curl`, but worth knowing
  if you're trying to understand why the schedule "didn't run."
- **Tables filled:** `followed_ticker_picks` — one row per selected ticker,
  `UNIQUE (cohort_month, ticker)`. **Verified re-selection guard, not just an
  assumption:** the route checks for an existing cohort for the current
  month *before* ranking anything, and if one exists returns it verbatim
  with `alreadyFrozen: true` — a second local run in the same calendar month
  is a safe, cheap no-op (no re-ranking, no new rows), not an error and not a
  silent overwrite.

```bash
npm run dev &
curl -sS -X POST http://localhost:3000/api/pipeline/followed-tickers-select \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"universe": "all", "count": 10, "dry_run": true}' | jq .   # dry_run first

curl -sS -X POST http://localhost:3000/api/pipeline/followed-tickers-select \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"universe": "all", "count": 10, "dry_run": false}' | jq .

node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=followed_ticker_picks
```

#### 2.3.4 `track-followed-tickers.yml` — daily cohort scoring

- **Command chain:** one `curl -X POST` to
  `{PORTAL_URL}/api/pipeline/followed-tickers`. Per ticker in the current
  cohort, the route calls the backtest engine (`lib/backtest`), re-reads the
  ranked card, and runs one grounded council seat (`lib/openrouter`,
  `lib/council-grounding`) — this is the most expensive of the 7 per
  invocation (N tickers × 1 council call each).
- **Auth:** `Authorization: Bearer $CRON_SECRET`.
- **Request body:** `{"dry_run": bool, "session": "followed-daily"}` — the
  `session` string is a free-form label the route stores, not a validated
  enum; any string works locally.
- **Production gate:** NY wall-clock 15:xx, weekdays only (two cron entries
  for EST/EDT, one is always a no-op — see the workflow's own comment on why
  a fixed UTC cron can't express "3:30pm New York" year-round). Irrelevant
  when calling the route directly.
- **A response worth actually reading:** the workflow's own "Thesis-flip
  check" step treats **100% neutral council verdicts across the whole
  cohort** as a warning sign (`meta.degraded`) — a uniform-neutral response
  locally usually means the same grounding/model degradation the production
  job watches for, not a local-only artifact.
- **Tables filled:** `followed_ticker_observations` (append, one row per
  pick per trading day, `PRIMARY KEY (pick_id, observed_on)`) and
  `followed_ticker_scores` (written when a horizon resolves — d1/w1/m1/m3/
  m6/ytd/y1 — so a single local run may write **zero** score rows if no
  horizon has crossed yet for any pick).

```bash
npm run dev &
curl -sS -X POST http://localhost:3000/api/pipeline/followed-tickers \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": false, "session": "local-test"}' | jq '{scored: (.readings | length), degraded: .meta.degraded}'

node --env-file=.env.local scripts/backup-to-sqlite.mjs \
  --tables=followed_ticker_observations,followed_ticker_scores
```

Requires at least one row already in `followed_ticker_picks` (§2.3.3) — an
empty cohort means this route has nothing to score and will report 0
readings, which is a correct response, not a failure.

#### 2.3.5 `judge-followed-tickers.yml` — weekly LLM-judge grading

- **Command chain:** one `curl -X POST` to
  `{PORTAL_URL}/api/pipeline/followed-tickers-judge`. Grades that week's
  council verdicts against the five-criterion rubric in
  `docs/tickers-followed.md`, then **re-grades the checked-in gold set** as a
  self-check.
- **Auth:** `Authorization: Bearer $CRON_SECRET`.
- **Request body:** `{"dry_run": bool}` — only field the route reads.
- **The gold-gate is the one behavior worth reproducing on purpose:** if
  agreement with the gold set drops below 80%, the route sets
  `published: false` and writes nothing, specifically to stop a silently
  drifted free-tier model (the chain that `refresh-free-models.yml` rewrites
  weekly) from corrupting the judge's own scores. `response.reason` explains
  why when this happens. **A local run that reports `published: false` is
  the safety mechanism working, not a bug** — check `goldAgreement` before
  assuming something is broken.
- **Tables filled:** `followed_ticker_scores` — only the judge columns
  (`judge_score`, `judge_detail`, `judge_version`) on existing rows; this
  route does not insert new picks or observations.

```bash
npm run dev &
curl -sS -X POST http://localhost:3000/api/pipeline/followed-tickers-judge \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"dry_run": false}' | jq '{published, goldAgreement, verdictsGraded, reason}'

node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=followed_ticker_scores
```

Requires at least one scored reading already in `followed_ticker_scores` from
§2.3.4 — nothing to grade otherwise.

#### 2.3.6 `compile-grounding-pack.yml` — the one with no HTTP hop at all

The odd one out: **no dev server needed, no `PORTAL_PUSH_SECRET`/`CRON_SECRET`
either.** `scripts/compile_grounding_pack.mjs` connects to `DATABASE_URL`
directly, the same way this doc's own backup script does — it walks
`corpus/**/*.md`, chunks each file, and either upserts `corpus_chunks` or (if
`OPENROUTER_API_KEY` is set) also extracts rule tuples into `grounding_pack`
via one batched LLM call per chunk.

- **Command:** `node scripts/compile_grounding_pack.mjs [flags]`.
- **Required env:** `DATABASE_URL` (always). `OPENROUTER_API_KEY` only if
  *not* passing `--dry-run`.
- **Flags:** `--dry-run` (chunk + extract, print counts, write nothing —
  works with no OpenRouter key), `CORPUS_VERSION` env override (defaults to
  the git short SHA), `COMPILE_MODEL` env override (defaults to a free-tier
  model).
- **Idempotent by design:** `ON CONFLICT` upserts on `corpus_chunks.chunk_id`
  and `grounding_pack (state_key, chunk_id)` — safe to re-run without
  duplicating rows, including repeatedly against your dev-safe `DATABASE_URL`
  while iterating on `corpus/`.
- **Tables filled:** `corpus_chunks`, `grounding_pack`.

```bash
# No dev server, no PORTAL_PUSH_SECRET/CRON_SECRET needed for this one.
node --env-file=.env.local scripts/compile_grounding_pack.mjs --dry-run   # no OPENROUTER_API_KEY needed
node --env-file=.env.local scripts/compile_grounding_pack.mjs            # writes for real, needs OPENROUTER_API_KEY

node --env-file=.env.local scripts/backup-to-sqlite.mjs --tables=corpus_chunks,grounding_pack
```

#### 2.3.7 `afternoon-pipeline.yml` — cannot be reproduced anywhere yet, including production

Unlike rows 1–6, this one is **not currently runnable at all** — not locally,
not in production, not by GitHub Actions itself. Its four steps call
`/api/pipeline/signals-refresh`, `/api/pipeline/council-run`,
`/api/pipeline/theses-score`, and `/api/pipeline/council-validate-distribution`,
and **none of the four exist** — confirmed by listing `app/api/pipeline/`:
only `hydrate-universe`, `precompute-ai`, `followed-tickers`,
`followed-tickers-select`, and `followed-tickers-judge` are there. Every
scheduled fire of this workflow 404s on its first `curl` and fails the job;
the workflow's own comment says as much (`"None of the 4 /api/pipeline/*
routes are built yet — this workflow is orchestration shipped ahead of
them"`), and unlike the followed-tickers workflows' equivalent comment
(§2.2.1's first correction), **this one is still accurate** — it hasn't gone
stale, because the routes genuinely haven't shipped.

- **What it would fill, once built:** `signal_digest_cache` (via
  `signals-refresh`), `council_sessions`/`council_messages`/`council_verdicts`
  (via `council-run`), and whatever `theses-score` and
  `council-validate-distribution` turn out to touch — **unconfirmed**, since
  there's no route source to read yet.
- **Nothing to run locally for this one.** If you see this workflow failing
  in Actions, that's expected per its own header comment, not a local
  reproduction problem to chase.
- **Auth (once built):** `CRON_SECRET`, per the workflow's `curl` calls —
  consistent with rows 3–5, not `PORTAL_PUSH_SECRET`.

Revisit this section once `docs/wiki-portal/decision-afternoon-pipeline-cron-split.md`
(referenced throughout the workflow's own comments) shows these routes as
built — check `app/api/pipeline/` directly rather than trusting the workflow
file, per the stale-comment lesson in §2.2.1.

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

For the other 6 pipelines' exact reproduction commands (auth secret, request
body, which tables each fills, and workflow-specific caveats), see §2.3.

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
- `.github/workflows/backup-to-sqlite.yml` — runs the exporter daily in CI, uploads the result as a 14-day artifact
- [`sqlite-backup-code.md`](sqlite-backup-code.md) — code-only companion: every command from this doc plus the CI workflow, no narrative
- This file
