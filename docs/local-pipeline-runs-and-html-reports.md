# Running nulogdash + the three pipelines locally, on demand, with an HTML report per run

**Question asked:** can I run the admin dashboard (`nulogdash`) locally, fire the
three pipelines manually at any point, and get a very descriptive HTML report out
of each run?

**Answer: yes, from the terminal, as of the fixes below.** The dashboard already
ran locally read-only. The manual-trigger path had two auth-wiring defects that
made it fail before reaching a route, `precompute-ai` had no safe rehearsal mode,
and no HTML report generator for a pipeline run existed anywhere in the repo.
All four are fixed. Dashboard-level surfacing (a UI tab, trigger buttons) is
still a separate, larger build — see §3.

Written: 2026-09-08. Updated: 2026-09-08 (fixes applied).
Branch: `feat/pipeline-local-runs-fixes` (cut from `origin/main` — the original
investigation branch, `feat/pipeline-full-runs-nulogdash`, already had an open
PR #116, so this unrelated work went on its own branch per the repo's
no-conflicts rule).

---

## 0. What "the three pipelines" means here

`lib/pipeline-run-log-db.ts` defines the closed set — the three model-spending
pipelines that write an append-only audit row to `pipeline_run_log`:

| Pipeline | Route | Auth secret | Dry-run |
|---|---|---|---|
| `followed-tickers` | `app/api/pipeline/followed-tickers/route.ts` | `CRON_SECRET` | yes (`{dry_run:true}`) |
| `followed-tickers-judge` | `app/api/pipeline/followed-tickers-judge/route.ts` | `CRON_SECRET` | yes (`{dry_run:true}`) |
| `precompute-ai` | `app/api/pipeline/precompute-ai/route.ts` | `PORTAL_PUSH_SECRET` | **yes, as of this fix** (`{dry_run:true}`) |

Two adjacent routes exist (`followed-tickers-select`, `hydrate-universe`) but are
not in the `PipelineName` union and do not write run-log rows, so they're out of
scope for "the three".

---

## 1. What works now

### 1.1 The dashboard runs locally — read-only

```bash
npm run dev                 # http://localhost:3000
open http://localhost:3000/dashboard/nulogdash
```

Requirements, all already satisfied in `.env.local`:

- `NULOGDASH_ADMIN_EMAILS` must contain your Clerk primary email, **verified**
  (`lib/nulogdash.ts:66-80`). Not on the list → `notFound()`, not a 403.
- Mutating actions additionally require MFA enrolment
  (`canPerformAdminAction`, `lib/nulogdash.ts:97`) — currently nothing on the
  page mutates, so this only shows an `MfaNotice` banner.
- The page is `dynamic = "force-dynamic"`, so a re-run + refresh is enough; no
  cache busting needed.

### 1.2 All three pipelines can be fired manually — via the CLI

`scripts/local-trigger.mjs` Path C = "POST the route the GitHub workflow would
POST". All three now work from one command each, dry-run by default:

```bash
node scripts/local-trigger.mjs list
node scripts/local-trigger.mjs C track-followed-tickers --local           # dry run
node scripts/local-trigger.mjs C judge-followed-tickers --local           # dry run
node scripts/local-trigger.mjs C precompute-ai --local                    # dry run — rehearses selection only
node scripts/local-trigger.mjs C precompute-ai --local --no-dry-run --yes # real run — spends OpenRouter quota, writes
node scripts/local-trigger.mjs C track-followed-tickers --local --print   # show curl, send nothing (secret NAME only, never the value)
```

It defaults to `dry_run: true` and refuses `--no-dry-run` without `--yes`. It
prints the HTTP status, elapsed ms, and the pretty-printed JSON response body
(truncated at 4000 chars) to the terminal — then, on a successful call to one of
the three pipelines, automatically generates the HTML report described below
(pass `--no-report` to skip, `--open` to open the report immediately).

### 1.3 A descriptive HTML report per run

```bash
node scripts/pipeline-run-report.mjs                              # latest run, any pipeline
node scripts/pipeline-run-report.mjs --pipeline precompute-ai      # latest run of one pipeline
node scripts/pipeline-run-report.mjs --id <uuid>                   # one specific run
node scripts/pipeline-run-report.mjs --open                        # open the HTML when done
```

Reads one `pipeline_run_log` row and renders `docs/pipeline-runs/<ts>-<pipeline>.html`
+ a companion `.json` — self-contained (no external assets except Google Fonts),
themed light/dark, opens over `file://`. Shows: run metadata (id, timestamp,
dry-run flag, session), summary cards (items total/AI/ok/empty/failed/skipped),
the per-model rollup table, every item's subject/seat/model/outcome/latency/
fallback, and the run's raw `summary` blob. Nothing is written to the database
and no model is called — it only reads.

Chained automatically by `local-trigger.mjs` after a successful pipeline call
(§1.2), or run it standalone against any past run by id.

### 1.4 Runs are durably recorded — as DB rows and periodic markdown

Every run inserts one `pipeline_run_log` row. Roll many runs up with:

```bash
npm run model-usage                      # this week → docs/model-usage/<start>-week.md
npm run model-usage -- --period day --date 2026-09-08
npm run model-usage -- --stdout --dry-run
```

`model-usage` is the multi-run *rollup* (markdown); `pipeline-run-report` is the
single-run *detail view* (HTML). Use the first for a week's trend, the second
for "what exactly happened in the run I just fired."

---

## 2. What was fixed

### Fix 1 — `CRON_SECRET` added to `.env.local`

`scripts/local-trigger.mjs` hard-exits when `CRON_SECRET` is missing. A value
was generated locally (`openssl rand -hex 32`) and appended directly to
`.env.local` — never printed to a terminal, chat, or log. For purely local runs
it only has to match itself: the route compares the bearer token against
`process.env.CRON_SECRET` in the same process, so this value does **not** need
to match production's, and should not, if the local run can reach a shared DB
(see §2.5 below).

### Fix 2 — per-call secret resolution in `local-trigger.mjs`

`pathC` (`scripts/local-trigger.mjs`) previously sent `CRON_SECRET` to every
call unconditionally, which meant `precompute-ai` — the one route that checks
`PORTAL_PUSH_SECRET` — got a silent 401 every time. The `calls` registry now
supports a `secret` field (`WORKFLOWS["precompute-ai"].calls[0].secret =
"PORTAL_PUSH_SECRET"`), and `pathC` resolves and checks it per call, naming the
missing variable (never its value) if absent. `--print` output now shows the
correct placeholder (`Bearer $PORTAL_PUSH_SECRET` vs `Bearer $CRON_SECRET`).

### Fix 3 — `dry_run` support added to `precompute-ai`

`app/api/pipeline/precompute-ai/route.ts` now accepts `{ dry_run: true }`. A
dry run resolves the subject selection (explicit / ranking / watchlist, same
precedence as a live run) and logs a `pipeline_run_log` row with
`dry_run: true` and every item marked `outcome: "skip"`, but makes **no model
call and no `savePrecomputed` write** — the loop that spends OpenRouter quota
and writes to `precomputed_ai` only runs when `dry_run` is falsy. The response
reports `wouldAttempt` and the resolved `subjects` list so a rehearsal is still
informative. `local-trigger.mjs`'s `requiresConfirm` gate on this call now only
blocks the *real* write path (`--no-dry-run` without `--yes`); a dry run no
longer needs `--yes` at all, matching the other two pipelines.

### Fix 4 — `scripts/pipeline-run-report.mjs` created

New script, described in §1.3. Modeled on the existing local precedents:
`scripts/model-usage-report.mjs`'s DB-connection and `.env.local`-fallback
pattern, and `scripts/local-signal-report.mjs`'s self-contained themed-HTML
structure. Wired into `local-trigger.mjs` Path C via each pipeline call's new
`pipeline` field, so a manual trigger produces its report automatically.

### Not fixed — still real, still open

- **§2.5 shared-DB risk** (was Issue 7): `.env.local`'s `DATABASE_URL` is a
  single Neon connection string. A `--no-dry-run` local run still writes real
  rows through whatever branch that string points at. Verify it's a **dev**
  branch, not production, before running any pipeline with `--no-dry-run`
  locally — this fix set did not touch that string and doesn't need to.
- **Dashboard surfacing** (was Issue 5): `/dashboard/nulogdash` still renders
  `.nulogdash/latest.json` (the feature sweep), with no knowledge of
  `pipeline_run_log` or the new report files. A `/dashboard/nulogdash/pipelines`
  tab reading `pipeline_run_log` and linking generated reports is unbuilt.
- **In-dashboard trigger buttons** (was Issue 6): `app/dashboard/nulogdash/page.tsx`
  is still a pure server component — no `"use client"`, no `onClick`, no
  `fetch`. `canPerformAdminAction` (`lib/nulogdash.ts:97`) exists precisely to
  gate a mutating action like this and is currently called by nothing. Building
  this means a client component + server actions with the same
  `--no-dry-run`-style confirmation the CLI now enforces, and is the only
  remaining piece that would let a browser session spend money / write to prod
  — deliberately left for a separate, explicitly-scoped task rather than bundled
  into this fix.

---

## 3. If dashboard-level triggers are wanted next

Not done here — flagging the shape for later:

1. A `/dashboard/nulogdash/pipelines` server-rendered tab: query
   `pipeline_run_log` (latest N per pipeline), link each row to its
   `docs/pipeline-runs/*.html` report if one exists locally, or regenerate it
   server-side on click.
2. A "run" button per pipeline as a `"use client"` island + Next.js Server
   Action, gated by `canPerformAdminAction` (MFA-required — already exists,
   currently unused for exactly this reason).
3. The action POSTs the same route `local-trigger.mjs` does, defaulting to
   `dry_run: true` with an explicit second confirmation step before a real run
   — mirroring the CLI's `--no-dry-run --yes` pair so the safety property isn't
   weaker in the browser than the terminal.

---

## 4. Quick reference

```bash
# dashboard
npm run dev && open http://localhost:3000/dashboard/nulogdash

# feature sweep that feeds the dashboard
npm run nulogdash

# fire a pipeline (dry run, default) + auto-generate its HTML report
node scripts/local-trigger.mjs C track-followed-tickers --local --open
node scripts/local-trigger.mjs C judge-followed-tickers --local --open
node scripts/local-trigger.mjs C precompute-ai --local --open

# a real (spending/writing) precompute-ai run — confirm DATABASE_URL is a dev branch first
node scripts/local-trigger.mjs C precompute-ai --local --no-dry-run --yes --open

# report for a specific past run, or the latest of one pipeline
node scripts/pipeline-run-report.mjs --id <uuid>
node scripts/pipeline-run-report.mjs --pipeline precompute-ai --open

# weekly/monthly rollup across runs (markdown, not per-run HTML)
npm run model-usage -- --stdout --dry-run

# unrelated: indicator-only HTML report, no pipeline/model/DB involved
node scripts/local-signal-report.mjs --symbols=AAPL,MSFT,NVDA
```
