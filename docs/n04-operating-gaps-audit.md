# N04 — nwf4 operating-gaps audit

**Written:** 2026-10-21 · **Branch:** `adamaslan/nwf-n04-audit` (worktree, based on `origin/main` `e2b7ba9`)
**Scope:** TODO item **N04** in `docs/nwf-consolidated-todo-2026-10-20.md`. The item reads: "Check a full market day's schedules, labeler and Saturday evaluator; add `live_prices` source/feed provenance through DB review; resolve old wiki lint findings. Do not re-open the deliberately disabled LLM scorer."
**Sources:** `docs/session-summary-2026-10-08-nwf4-jobs.md` and `docs/nwf4-backfill-and-confluence-roadmap.md`. Both are currently untracked files in the main checkout (`~/code/nuwrrrld-portal/docs/`), not in `origin/main`.

**What this audit did not do:** It changed no schema or database, made no deploy, triggered no job, and did not touch the LLM scorer. It did update two wiki pages to resolve the lint findings below. The original audit worktree made no commit or push and opened no PR.

---

## Evidence classes. Read this before trusting any number below.

| Label | Meaning |
|---|---|
| **[repo]** | Read from code on `origin/main` (`e2b7ba9`), or from git and `gh` metadata. You can re-check it at any time. |
| **[modal-meta]** | Read-only Modal CLI metadata (`modal app list`, `modal app history nwf4`), run once on 2026-10-21. |
| **[db-once]** | **A single read-only observation** of production Neon, taken once on 2026-10-21 before the owner stopped DB access for this tier. It was not repeated and has not been re-verified. Treat it as a snapshot, not a verification. No further queries were run. |

Midway through this session, the owner reserved direct DB access for the judgment tier. Every **[db-once]** row was captured before that instruction. Every later step uses only repository and workflow evidence.

---

## 1. Summary

| N04 sub-item | Status | One-line finding |
|---|---|---|
| Full market day of schedules | **Observed once, then the pipeline stopped** | Friday 2026-10-09 fired every expected slot **[db-once]**. No nwf4 job has logged a run since **2026-10-11 06:00 UTC** **[db-once]**. |
| Labeler (19:00 / 19:30 ET) | **Fires; fails by design** | It fired at both slots on 10-08 and 10-09, and every run failed with `no SPY SIP bars in daily_bars` **[db-once]**. It stays blocked on N01 (stage B1). |
| Saturday evaluator (10:00 / 10:30 ET) | **Fires; duplicate-write bug in the deployed build** | Both slots on 10-10 logged `"wrote": true` **[db-once]**. The guard that should stop the second write is in `main` but is **not deployed** **[repo]** + **[modal-meta]**. |
| `live_prices` source/feed provenance | **Not started; needs DB review** | The table has no `source` or `feed` column **[repo]** and **[db-once]**. None of the three write paths records provenance **[repo]**. |
| Old wiki-lint findings | **Fixed in this audit worktree** | The baseline was 97 linted pages with 7 section errors across two pages; after adding the required headings, the latest lint reports 97 pages and 0 errors. |
| LLM scorer | Left disabled | Not touched, per the item's instruction. |

**The most important new finding:** the deployed nwf4 app is out of date, and it has been silent for 10 days. Section 2.1 and section 3 cover both points.

---

## 2. Verified evidence

### 2.1 What is deployed vs what is on `main`

- **[modal-meta]** `modal app list` shows `nwf4` (`ap-DZfLW3WczfqAlQwfVJausY`) in state `deployed`, with 0 tasks at the time of the read.
- **[modal-meta]** `modal app history nwf4` shows two versions. v1 was deployed 2026-10-08 18:31 EDT and v2 at 18:33 EDT. Both were deployed from commit `eb033ca*`, where the `*` means the repo had uncommitted changes. There has been no deploy since.
- **[repo]** Commit `eb033ca` contains **none** of the `deploy/aws-modal-news/` job files (`git diff --stat eb033ca origin/main -- deploy/aws-modal-news/` adds all 2,387 lines). So the deployed source came from an uncommitted worktree (`~/code/nuwrrrld-portal-nwf4-jobs`, which no longer exists). It cannot be reproduced exactly from git.
- **[repo]** PR #241 merged 2026-10-09 22:17 UTC. Three of its commits were written **after** the v2 deploy (22:33 UTC on 10-08):
  - `f6c8530` *fix(review): guard duplicate weight decision, …* (2026-10-09 19:42Z)
  - `7865a98` *fix(review): add weekday 17:30 ET news_score_articles backlog launcher* (2026-10-09 20:04Z)
  - `c185e45` *test(review): regression cases …* (tests only)

  So production is most likely running **without** the duplicate-weight guard and **without** the 17:30 ET backlog-scoring slot. That conclusion is inferred from timestamps, not from the deployed image.

### 2.2 The schedule as written ([repo] `deploy/aws-modal-news/news_core.py:736-785`, `modal_app.py:804-822`)

There is one Modal cron, `tick` (`modal.Cron("* * * * *")`). Each minute it spawns whatever `due_jobs()` returns for that minute in America/New_York time:

| Job | Slot (ET) | Logged to `pipeline_run_log` as |
|---|---|---|
| `news_ingest` | weekdays 07:00–19:59 every 2 min; otherwise every 30 min | `news-ingest` |
| `alpaca_live_poller` | weekdays 09:30–16:00 every minute | **not logged.** It has no `log_run` call (`modal_app.py:747-801`). |
| `news_corroborate` | weekdays 09:30–16:00 at :00 and :30 | `news-corroborate` |
| `news_aggregate` (preview) | weekdays 09:20 | `news-aggregate` |
| `news_aggregate` (final) | weekdays 16:05 and 16:25. The second run skips without logging if the first succeeded (`modal_app.py:466-472`). | `news-aggregate` |
| `news_label_outcomes` | weekdays 19:00 and 19:30 | `news-label` |
| `news_score_articles` backlog | weekdays 17:30 (**only on `main`; not deployed**) | `news-score` |
| `news_accuracy_eval` | Saturday 10:00 and 10:30 | `news-accuracy-eval` |

### 2.3 One full market day. **[db-once]** single observation, 2026-10-21

Source: `pipeline_run_log` grouped by ET day for rows with `host='modal'`, captured once.

| ET day | ingest | score | corroborate | aggregate | label | eval |
|---|---|---|---|---|---|---|
| Thu 10-08 (deploy day, from about 18:26 ET) | 54 | 11 | 1 | 1 (manual/final) | 3 | 1 |
| **Fri 10-09 (the only full market day observed)** | **412** | 130 | **14** | **2** (09:20 preview and 16:05 final) | **2** (19:00, 19:30) | — |
| Sat 10-10 | 48 | 19 | — | — | — | **2** (10:00, 10:30) |
| Sun 10-11 | 5 | 1 | — | — | — | — |
| 10-12 → 10-21 | **0** | **0** | **0** | **0** | **0** | **0** |

How this compares with the schedule:

- **Friday 10-09 matches the design.** There were 14 corroborate runs, which is exactly the number of :00/:30 slots from 09:30 to 16:00. There was one preview and one final aggregate. The 16:25 final skipped silently as designed. Both label slots fired. 412 ingest runs fits a 2-minute window from 07:00 to 19:59 (390 slots) plus the 30-minute off-hours cadence.
- **Saturday 10-10 matches the design.** There were 48 ingest runs, one every 30 minutes all day, and both evaluator slots fired.
- **The last nwf4 row is 2026-10-11 06:00:25 UTC (02:00 ET Sunday).** Nothing has been logged since. That covers 8 weekday sessions (10-12 through 10-21) and the 10-17 Saturday evaluator. A full market day was verified **once**, and the scheduler has not been shown to be running now.
- The live poller cannot be checked this way because it does not log to `pipeline_run_log`.

### 2.4 Labeler. **[db-once]**

All 5 `news-label` rows (three on 10-08, at 19:00 and 19:30 on 10-09) have status `fail` and the summary `{"error": "no SPY SIP bars in daily_bars; nothing can be labeled", "labeled": 0}`. This is the intended guard (`modal_app.py:573`). The labeler cannot produce an outcome until N01 stage B1 writes `feed='sip'` daily bars, SPY included. N04 needs no code change here.

### 2.5 Saturday evaluator. **[db-once]** plus **[repo]**

- Both 10-10 runs (14:00Z and 14:30Z) have status `ok`, with `accuracy_rows: 0`, `delta_ic is NULL`, and `weight: {"wrote": true, "status": "shadow", "weight": 0.0, "gate_passed": false}`. There was also one manual run on 10-08 that wrote a row.
- On `main`, the accuracy-row guard (`modal_app.py:642-644`) cannot stop the second slot when there are no accuracy rows. The weight guard added in `f6c8530` (`modal_app.py:690-695`) can. It keys on `confluence_news_weights.effective_from`, using the ET date, for `decided_by='evaluator'`. Since the 10:30 run still wrote, the evidence fits the deployed build lacking `f6c8530`.
- **Why this matters for N4 promotion:** the §8.3 state machine promotes `shadow → active` after **two consecutive passing evaluations**. It reads only the latest row (`_decide_weight`, `modal_app.py:711-718`). If two evaluations run on the same Saturday, one week's pass would count as two. Today it is harmless, because the gate cannot pass while ΔIC is NULL. It must be fixed by redeploying `main` before N01 makes the gate passable.
- The weekly evaluator for 10-17 did not run (section 2.3).

### 2.6 `live_prices` provenance. **[repo]** plus **[db-once]**

- **Schema [repo]:** `lib/db/schema.sql:151-157` has `ticker, price, volume, traded_at, updated_at`. There is no `source` and no `feed`. The comment on `traded_at` still says "(from Finnhub)", which is now incomplete.
- **Production columns [db-once]:** `information_schema.columns` for `live_prices` showed the same five columns.
- **Contents [db-once]:** 251 rows. Max `updated_at` was 2026-10-20 23:16 UTC, max `traded_at` was 2026-10-20 20:59 UTC, and 176 rows were updated in the last 7 days. nwf4 has been silent since 10-11 (section 2.3), so these recent writes must come from another writer. **That is exactly the ambiguity the missing column causes:** the table cannot say which writer it was.
- **Every write path drops provenance [repo]:**

| Writer | Path into `live_prices` | Has source/feed at hand? | Persists it? |
|---|---|---|---|
| nwf4 `alpaca_live_poller` | direct Neon `INSERT` (`deploy/aws-modal-news/modal_app.py:787-791`) | yes: Alpaca, snapshot `latestTrade` | **no** |
| modal-backend `live_poller` | HTTP push to `/api/signals/live` (`deploy/modal-backend/nuwrrrld/jobs/live_poller.py:42-53`) | **sends** `"source": "alpaca", "feed": …` in the body | **no.** It is dropped by `parseLivePriceBatch`, because `LivePrice` (`lib/shared/live-price.ts:8-13`) has no source/feed fields. |
| `scripts/push-alpaca-live-prices.mjs` (run by `paper-portfolios.yml` "Refresh live_prices…") | HTTP push to `/api/signals/live` | yes: it logs `source=alpaca feed=$ALPACA_FEED` | **no** (same drop) |
| Finnhub WebSocket worker (external) | HTTP push to `/api/signals/live` | implicitly Finnhub | **no** |
| `/api/signals/live` → `upsertLivePrices` | `lib/live-price-db.ts:12-39` | — | the column list is fixed at 4 fields |

- **Downstream readers** that would benefit: `lib/paper-engine.ts` and `app/api/paper/[account]/route.ts` (paper fills), `lib/followed-tickers-price.ts`, and `app/api/signals/live` GET. `paper_cohort_members.price_source` (`schema.sql:534`) already records `live_prices` as a single source label, so it cannot tell Alpaca IEX ticks from Finnhub ticks either.

### 2.7 Wiki lint baseline and resolution. **[repo]**

The baseline `node ~/.claude/scripts/wiki-lint.mjs docs/wiki-portal` run reported **97 pages, 7 errors, 0 warnings**. These are the same 7 errors that the 10-08 session record lists.

| Page | Missing required section | Closest existing heading |
|---|---|---|
| `decision-exact-offset-and-fresh-price-for-followed-tickers.md` | Alternatives considered | `## Trade-offs accepted` (partially) |
| 〃 | Consequences | `## Trade-offs accepted` / `## How to apply` |
| 〃 | Validated by | none (`## Update 2026-10-09` holds the evidence) |
| 〃 | See also | `## Related` |
| `incident-2026-10-04-followed-tickers-never-produced-data.md` | Root cause | inside `## What happened` |
| 〃 | Impact on design | `## Lessons` |
| 〃 | Open items | `## Still open (human action, not code)` |

These pages were last changed by PRs #217 and #245, not by nwf4. On 2026-10-21 the required headings were added in this audit worktree without changing source facts. The latest run reports **97 pages, 0 errors, 0 warnings**.

### 2.8 CI and open PRs. **[repo]**

- `ci.yml` runs `pytest -q deploy/aws-modal-news/tests`. The last three `main` CI runs passed (latest: `39508985217`, `e2b7ba9`, 2026-10-20). Offline tests pass, but that says nothing about the deployed build.
- `modal-run.yml` (`workflow_dispatch` only) exposes `aws-modal-news::smoke`, `::news_ingest`, `::news_aggregate`, and `::news_accuracy_eval`. It has **never been dispatched** (`gh run list --workflow modal-run.yml` → `[]`).
- **Open PR #301** (*remove the AWS-backed Alpaca shared rate budget*) edits `deploy/aws-modal-news/modal_app.py`, `news_io.py`, and `docs/wiki-portal/entity-nwf4-news-pipeline.md`. nwf4 currently reserves tokens from `nwf_rate_budget` (`news_io.py:30-46`). Any nwf4 code change, including the provenance write, will conflict with #301. **Sequence after #301.**

---

## 3. Missing items

1. **nwf4 has written nothing since 2026-10-11 06:00 UTC.** The cause is unknown. Modal shows the app as `deployed`. Candidates that the evidence here cannot separate:
   - the `tick` cron is no longer firing (workspace limit, billing, or a paused schedule);
   - jobs spawn but fail before `log_run`, for example on Neon connect, AWS credentials, or the shared-budget DynamoDB table that hydration also reported "unavailable" on 10-20;
   - jobs are skipping, for example a broker-calendar call that fails closed.

   **Next evidence needed:** read-only Modal logs (step 1 below).
2. **The deployed build is behind `main`.** It is missing `f6c8530` (the duplicate-weight guard) and `7865a98` (the 17:30 backlog launcher). It was deployed from uncommitted state, so it cannot be reproduced exactly.
3. **The live poller is invisible to run monitoring.** It has no `pipeline_run_log` row, so neither nulogdash nor this audit can confirm its schedule.
4. **`live_prices` provenance.** It needs schema columns, DB review, the shared parser and upsert, and the nwf4 writer. Not started.
5. **Wiki lint.** The initial 7 section errors were resolved in the audit worktree; the latest 97-page lint run is clean.
6. **No second full market day verified.** The only observed full day is 10-09, and the system has been silent on every weekday since.
7. **The labeler stays blocked on N01 B1** (SIP bars plus SPY). That is out of N04's scope and is listed only for completeness.

---

## 4. Safe next steps

Steps are numbered, one paste per step. 🖱 marks a human/owner decision. **⚖ marks judgment-tier work.** That covers DB, schema, and deploy steps, which this tier must not run.

**Step 1: find out why nwf4 went silent. Read-only Modal logs, no DB.**

```bash
export PATH=/opt/homebrew/Caskroom/miniforge/base/bin:$PATH
modal app logs nwf4 --since 240h --tail 200 2>&1 | tail -80
```

Expect one of three things: `tick` lines that stop around 2026-10-11 06:00 UTC (the cron stopped), job tracebacks (the jobs are failing), or recent `skipped` returns. If nothing at all appears after 10-11, check the workspace in the dashboard:

🖱 **Dashboard:** https://modal.com/apps → `nwf4` → Schedules and Usage/Billing (look for a paused schedule or a spend limit).

**Step 2: confirm what `main` would deploy. Offline, no network.**

```bash
cd ~/orca/workspaces/nuwrrrld-portal/nwf-n04-audit
export PATH=/opt/homebrew/Caskroom/miniforge/base/bin:$PATH
python -m pytest -q deploy/aws-modal-news/tests -p no:cacheprovider
git log --oneline 840edd4 -1 -- deploy/aws-modal-news/
```

Expect all tests to pass and `840edd4 feat(nwf4): … (#241)` as the last change on `main`. Rebase this check after PR #301 merges, because #301 also edits these files.

**Step 3: ⚖ 🖱 redeploy nwf4 from a clean, committed `main`, after #301 is settled.** This needs an owner decision. A redeploy restarts a live production cron. Run it only from a clean tree so that Modal history shows a commit without `*`:

```bash
cd ~/orca/workspaces/nuwrrrld-portal/nwf-n04-audit
git status --short deploy/aws-modal-news/ && git fetch origin main && git log --oneline -1 origin/main
```

Expect empty `git status` output. The judgment tier then runs `modal deploy deploy/aws-modal-news/modal_app.py` from a worktree checked out at `origin/main`. Verify it with:

```bash
export PATH=/opt/homebrew/Caskroom/miniforge/base/bin:$PATH
modal app history nwf4 | head -6
```

Expect a new version whose Commit column has no `*`.

**Step 4: verify one full market day after the redeploy. Workflow evidence, no DB from this tier.** On the next weekday after step 3, use the logs:

```bash
export PATH=/opt/homebrew/Caskroom/miniforge/base/bin:$PATH
modal app logs nwf4 --since 24h --tail 1000 2>&1 | grep -oE 'news_(ingest|corroborate|aggregate|label_outcomes|score_articles)|alpaca_live_poller' | sort | uniq -c
```

For a full session, expect roughly 390 or more ingest runs, 14 corroborate runs, 3 aggregate runs (preview plus two finals, one of which skips), 2 label runs, 1 or more backlog-score runs, and about 391 poller runs. ⚖ The judgment tier can confirm the same day in `pipeline_run_log` with the counts query from section 2.3, filtered to that ET date.

**Step 5: verify the Saturday evaluator writes once.** The first Saturday after step 3:

```bash
export PATH=/opt/homebrew/Caskroom/miniforge/base/bin:$PATH
modal app logs nwf4 --since 6h --tail 300 2>&1 | grep -iE 'accuracy_eval|weight decision|wrote'
```

Expect the 10:30 ET run to report `weight decision for <date> already exists`. ⚖ Judgment-tier DB confirmation: exactly one `confluence_news_weights` row with `decided_by='evaluator'` for that ET date.

**Step 6: ⚖ 🖱 `live_prices` provenance. DB review required, so it is not done here.** Here is a proposed shape for the judgment tier to review. It is not applied anywhere.

- Schema: add `source text` and `feed text`, both nullable at first, to `live_prices` in `lib/db/schema.sql`. Regenerate the SQLite schema with the repo's existing generator and parity check. Apply it through the project's migration approval path (`scripts/db-migrate.mjs`), not ad hoc.
- Parser: add optional `source?: string` and `feed?: string` to `LivePrice` (`lib/shared/live-price.ts`), with an allow-list (`alpaca` | `finnhub`; `iex` | `sip`). Keep rows without those fields valid, so the Finnhub worker keeps working unchanged.
- Upsert: extend `upsertLivePrices` (`lib/live-price-db.ts`) to write both columns and update them in the existing `ON CONFLICT … WHERE EXCLUDED.traded_at >= …` clause.
- Writers: nwf4 poller writes `source='alpaca', feed='iex'`. modal-backend already sends the fields. `push-alpaca-live-prices.mjs` should add them to its body. The Finnhub worker is external and can be left NULL, or set later.
- `/api/signals/live` is a Bearer-auth route. Adding body fields does not change its auth, but the judgment tier owns any edit there.
- Order: after #301 merges, because both touch `modal_app.py`.

Pre-review check, repo only:

```bash
cd ~/orca/workspaces/nuwrrrld-portal/nwf-n04-audit
rg -n "INSERT INTO live_prices|upsertLivePrices\(|/api/signals/live" lib app scripts deploy
```

Expect exactly two insert sites (`lib/live-price-db.ts`, `deploy/aws-modal-news/modal_app.py`) and the push callers listed in section 2.6. If another site appears, add it to the change.

**Step 7: add a run log to the live poller.** This is small and Workhorse-tier, after #301. Give `alpaca_live_poller` a `pipeline_run_log` row, or sample one row per N minutes to avoid writing 390 rows a day, so that step 4 can be verified from nulogdash and not only from logs. This writes to an existing table with no schema change, but it is still a production write path, so it goes through review.

**Step 8: fix the 7 wiki-lint errors. Done 2026-10-21.** Added the missing required sections to the decision and incident pages per section 2.7. No source facts were changed. Then verified:

```bash
cd ~/orca/workspaces/nuwrrrld-portal/nwf-n04-audit
node ~/.claude/scripts/wiki-lint.mjs docs/wiki-portal 2>&1 | tail -3
```

Expect `0 error(s)`.

**Explicitly out of scope:** re-enabling `llm_v1` (owner decision needed), N01 backfill (Codex A), and any non-zero news weight (the N4 owner sign-off).

---

## 5. Gate status for N04

N04 stays **open**. To close it, all of the following must be true:

- nwf4 has been redeployed from a committed `main` (step 3);
- one full market day and one Saturday have been verified after that redeploy (steps 4 and 5);
- `live_prices` provenance has passed DB review and been applied (step 6);
- the wiki lint shows 0 errors (step 8).

The wiki lint gate is now satisfied. The redeploy, post-deploy schedule proof,
and provenance schema review/application remain open.

## 6. Judgment-tier recheck — 2026-10-21 17:26 UTC

The judgment tier independently rechecked the database aggregates. `pipeline_run_log`
has no Modal NWF4 rows after 2026-10-11 06:00 UTC. The full observed market-day
and label/evaluator details in §2.3–2.5 remain consistent; the news accuracy
and outcome tables are still empty, and `daily_bars` has IEX rows only. The
`live_prices` table has five columns (`ticker`, `price`, `volume`, `traded_at`,
`updated_at`) and no `source` or `feed`. These checks confirm the report's
earlier single-read observations without exposing row-level data.

At this recheck, the primary checkout contains 73 top-level wiki page files and
passes `node ~/.claude/scripts/wiki-lint.mjs docs/wiki-portal --quiet`. The
separate `origin/main`-based audit worktree contains 97 top-level wiki page
files (100 Markdown files including nested content); the linter reports 97
pages and 0 errors after the two-page fix. The earlier “101-page” description
was inaccurate and is corrected here. A central lint entry was appended to
`~/code/homebase/wiki-logs/portal/log.md`.
