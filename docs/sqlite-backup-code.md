# SQLite Backup — The Code, Local + GitHub Actions

Code-only companion to
[`local-sqlite-backup-and-offline-dev.md`](local-sqlite-backup-and-offline-dev.md)
(read that one for the *why* — schema translation rationale, the undeclared
live-tables finding, the scoped-but-not-built live-SQLite-dev-server plan).
This doc is just the runnable pieces: run it on your own machine, and run it
on a schedule in GitHub Actions.

Everything here backs onto three files already in the repo:

| File | Role |
|---|---|
| [`lib/db/schema.sqlite.sql`](../lib/db/schema.sqlite.sql) | SQLite translation of [`lib/db/schema.sql`](../lib/db/schema.sql)'s 30 tables |
| [`scripts/backup-to-sqlite.mjs`](../scripts/backup-to-sqlite.mjs) | The exporter — Neon → local `.sqlite` file, via Node's built-in `node:sqlite` |
| [`.github/workflows/backup-to-sqlite.yml`](../.github/workflows/backup-to-sqlite.yml) | Runs the exporter daily in CI, uploads the result as an artifact |

**Requires Node 22.5+** for `node:sqlite` (still flagged experimental by
Node itself — the `ExperimentalWarning` on every run is expected, not a
bug). No `npm install` needed for any of this — zero new dependencies.

---

## 1. Local

### 1.1 One-time sanity check

Confirms the SQLite schema file actually parses and creates all 30 tables,
without touching Neon or writing any file to disk (`:memory:`):

```bash
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync('lib/db/schema.sqlite.sql', 'utf8'));
  const n = db.prepare(\"SELECT count(*) AS n FROM sqlite_master WHERE type='table'\").get().n;
  console.log(n, 'tables created (30 + sqlite_sequence = 31 is correct)');
"
```

### 1.2 Take a backup

```bash
# Full backup — all 30 tables, written to a fresh timestamped file under backups/
node --env-file=.env.local scripts/backup-to-sqlite.mjs

# Only specific tables
node --env-file=.env.local scripts/backup-to-sqlite.mjs \
  --tables=ticker_universe,ticker_cards,followed_ticker_picks

# Everything except the heaviest tables (quick smoke backup)
node --env-file=.env.local scripts/backup-to-sqlite.mjs \
  --exclude=corpus_chunks,grounding_pack

# Explicit output path (refuses to run if the path already exists)
node --env-file=.env.local scripts/backup-to-sqlite.mjs --out=backups/manual.sqlite
```

Real output, from a production run:

```
Backing up postgresql://***@ep-....neon.tech/neondb?... -> backups/nuwrrrld-2026-09-03_14-22-01.sqlite

  ✓ ticker_cards                       1864 rows
  ✓ ticker_universe                     983 rows
  ✓ watchlist_items                      15 rows
  ...
Done in 1.9s — 30 tables, 2904 rows -> backups/nuwrrrld-2026-09-03_14-22-01.sqlite
Inspect it with: sqlite3 backups/nuwrrrld-2026-09-03_14-22-01.sqlite ".tables"
```

A table declared in `lib/db/schema.sql` but not yet ported to
`lib/db/schema.sqlite.sql` (or a table that exists in Neon but was never
declared anywhere — see the other doc's §1.4 finding) is skipped with a
loud warning, never silently dropped or silently included:

```
  ⚠ skipping "invoices" — not present in lib/db/schema.sqlite.sql yet
```

### 1.3 Inspect the result

No credentials, no network — any SQLite client works:

```bash
sqlite3 backups/nuwrrrld-<timestamp>.sqlite ".tables"

sqlite3 backups/nuwrrrld-<timestamp>.sqlite \
  "SELECT ticker, action, score FROM ticker_cards ORDER BY score DESC LIMIT 10;"

# jsonb columns are stored as JSON text — use json_extract to query into them
sqlite3 backups/nuwrrrld-<timestamp>.sqlite \
  "SELECT ticker, json_extract(tokens, '$.direction') AS direction FROM ticker_cards LIMIT 5;"
```

Or from Node, same driver the backup script uses:

```bash
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync('backups/nuwrrrld-<timestamp>.sqlite');
  console.log(db.prepare('SELECT * FROM ticker_universe LIMIT 3').all());
"
```

### 1.4 Restore into a fresh Neon dev branch (manual — no script for this yet)

There's no automated restore path (see the companion doc's entity page, open
question). To pull a table back out for manual re-insertion:

```bash
sqlite3 backups/nuwrrrld-<timestamp>.sqlite \
  ".mode insert ticker_universe" \
  "SELECT * FROM ticker_universe;" > restore-ticker_universe.sql
# then hand-adapt the generated INSERT statements' types back to Postgres
# (booleans 0/1 -> true/false, JSON text -> ::jsonb, ISO text -> ::timestamptz)
# before running them against a **dev**, never production, DATABASE_URL.
```

---

## 2. GitHub Actions

### 2.1 The workflow

[`.github/workflows/backup-to-sqlite.yml`](../.github/workflows/backup-to-sqlite.yml) —
runs daily at 03:00 UTC (after `hydrate-universe`'s 22:30 UTC weekday run and
`precompute-ai`'s 00:10 UTC daily run, so the snapshot captures both), and on
manual `workflow_dispatch`.

```yaml
name: Backup Neon to SQLite

on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
    inputs:
      tables:
        description: 'Comma-separated table allowlist (blank = all 30 tables)'
        required: false
        default: ''
      exclude:
        description: 'Comma-separated tables to skip (e.g. corpus_chunks,grounding_pack)'
        required: false
        default: ''

permissions:
  contents: read

concurrency:
  group: backup-to-sqlite
  cancel-in-progress: false

jobs:
  backup:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'   # node:sqlite requires 22.5+ — do not lower
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Run the backup
        id: backup
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          IN_TABLES: ${{ github.event.inputs.tables }}
          IN_EXCLUDE: ${{ github.event.inputs.exclude }}
        run: |
          set -euo pipefail
          if [ -z "${DATABASE_URL}" ]; then
            echo "::error::DATABASE_URL is not set — cannot back up."
            exit 1
          fi
          args=()
          [ -n "${IN_TABLES}" ]  && args+=("--tables=${IN_TABLES}")
          [ -n "${IN_EXCLUDE}" ] && args+=("--exclude=${IN_EXCLUDE}")
          node scripts/backup-to-sqlite.mjs "${args[@]}" 2>&1 | tee backup.log
          out_path=$(grep -oE 'backups/[^ ]+\.sqlite' backup.log | tail -n1 || true)
          if [ -z "${out_path}" ]; then
            echo "::error::backup script produced no output path — see backup.log"
            exit 1
          fi
          echo "out_path=${out_path}" >> "$GITHUB_OUTPUT"

      - name: Upload backup artifact
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: nuwrrrld-sqlite-backup-${{ github.run_id }}
          path: backups/*.sqlite
          retention-days: 14
          if-no-files-found: error
```

(The real file also writes a `$GITHUB_STEP_SUMMARY` block echoing
`backup.log` — omitted here for brevity; see the actual workflow file for
the complete version.)

### 2.2 What it needs

- **`DATABASE_URL` repo secret** — already exists (used by
  `compile-grounding-pack.yml` and `integration-tests.yml`); no new secret
  to create.
- **Node 22+** in `setup-node` — the one hard requirement `node:sqlite`
  imposes. Every other workflow in this repo uses `'20'` or `'22'`
  interchangeably; this is the one that can't drop to 20.

### 2.3 Trigger it manually

```bash
# Full backup, right now, via the CLI
gh workflow run backup-to-sqlite.yml

# Only specific tables
gh workflow run backup-to-sqlite.yml -f tables=ticker_universe,ticker_cards

# Watch it run
gh run watch --exit-status
```

### 2.4 Download the result

Artifacts aren't committed anywhere — they live on the run for 14 days
(`retention-days: 14`), matching the "rolling convenience copy, not durable
archival" framing in the other doc.

```bash
# Find the most recent run
gh run list --workflow=backup-to-sqlite.yml --limit=1

# Download its artifact into ./backups/
gh run download <run-id> -n nuwrrrld-sqlite-backup-<run-id> -D backups/

sqlite3 backups/nuwrrrld-*.sqlite ".tables"
```

Or via the UI: **Actions → Backup Neon to SQLite → (a run) → Artifacts**.

### 2.5 Verifying it actually ran correctly

The step summary (**Actions → the run → Summary**) echoes the full
`backup.log` — same per-table row-count output shown in §1.2. A run that
"succeeded" (green check) but shows `0 tables` in the log means
`DATABASE_URL` was set but pointed somewhere with no matching schema (a
wrong/empty database), not that nothing needed backing up — the script
always lists at least the tables it skipped, so a genuinely empty summary
means something is misconfigured, not that the backup is trivially "done."

---

## 3. Both paths, side by side

| | Local | GitHub Actions |
|---|---|---|
| Trigger | manual, whenever | daily 03:00 UTC + manual `workflow_dispatch` |
| Credential source | `.env.local` (`DATABASE_URL`) | `secrets.DATABASE_URL` |
| Output location | `backups/<timestamp>.sqlite` on your machine | workflow artifact, 14-day retention |
| Table filters | `--tables=`/`--exclude=` flags | `tables`/`exclude` `workflow_dispatch` inputs (same underlying flags) |
| Node requirement | 22.5+ on your machine | pinned via `setup-node` `node-version: '22'` |
| Never overwrites | ✅ (refuses if `--out` exists) | ✅ (fresh runner, fresh timestamp every time) |
