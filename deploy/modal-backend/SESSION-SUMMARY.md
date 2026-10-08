# Modal backend build: session summary, features, and what is left

Date: 2026-10-07 · Branch: `feat/modal-backend` (worktree `../nuwrrrld-portal-modal`, cut from `origin/main`)
Spec: `docs/nuwrrrld-modal-architecture.md` in the main checkout (that file is still untracked there).

**Status in one line:** the Modal-side backend is written and the full suite passes: **241 passed in 38.7 s** against a real local Postgres (DynamoDB under moto). Nothing is deployed. The `test_ops.py` hang is fixed (§5.1 applied) and the file's first real run found two more bugs (§2, items 7–8). The rest of §5 is still suggestions.

---

## 1. What exists

All code is under `deploy/modal-backend/` (about 60 Python modules, 37 Modal functions).
Per the owner decision in the spec, the web stays on Vercel, so there is no Next.js-on-Modal.

### Features

| Feature | Where | State |
|---|---|---|
| Postgres schema (46 objects, copied verbatim from spec §6) + `rate_limits` table | `migrations/0001`, `0002` | Applied to a real local Postgres |
| Trading calendar (NYSE, DST-safe, holidays, early closes, manual overrides) | `nuwrrrld/calendar.py` | Tested |
| Market data: Alpaca primary (paged, ET dates, 150 symbols/request, retries, shared rate budget) | `providers/alpaca.py` | Tested with mocked HTTP |
| yfinance fallback, skipped on datacenter hosts; only missing tickers fall back | `providers/` | Tested |
| EOD ingest, fail-closed validation, polling, Parquet cache | `jobs/ingest.py` | Tested |
| Indicators (causal, no look-ahead), rule engine, signals | `core/indicators.py`, `core/signals.py` | Tested |
| Hold/Fold (global + personal), sector rotation, factor exposures | `core/holdfold.py`, `core/rotation.py`, `jobs/signals.py` | Tested |
| Watchlist alerts (signal flip, verdict change, quadrant change) | `jobs/signals.py` | Tested |
| Signal Digest: LLM explanation, numeric validator, directive filter, template fallback, publish | `jobs/digest.py`, `llm/validate.py` | Tested with mocked LLM |
| Followed Tickers: monthly freeze (immutable), 7-horizon scoring, ex-ante/ex-post grading | `jobs/followed.py`, `core/scoring.py` | Tested |
| AI Council framework: strategy interface, placeholders, blind opening, DA challenge, tally, invalidation clamp, token budget | `core/council/` | Tested |
| Paper trading: sizing, pre-trade checks, exactly-once fills, stops, halts, splits/dividends, rebuild-from-fills, stats | `core/paper/`, `jobs/paper.py` | Tested on real Postgres |
| Portfolio Intel: holdings, CSV import, watchlists, alerts, metrics, health check | `api/routers/portfolio.py`, `jobs/health.py` | Tested |
| Nu AI chat: streaming tool loop (max 6 calls), 9 user-scoped tools, SSE, idempotent resend | `llm/chat_tools.py`, `api/routers/chat.py` | Router tested; tool SQL and loop only in unrun `test_ops.py` |
| Share & Earn: attribution rules, friend month, qualification, referrer reward, cap, reversal | `billing/referrals.py` | Tested (every case in spec §15.4) |
| Stripe + Clerk webhooks (signature checks, ledger, duplicates, out-of-order events) | `api/routers/webhooks.py`, `billing/stripe_events.py` | Tested |
| Auth: Clerk JWT (RS256 pinned, iss/exp/azp, alg-none and HS256 rejected), entitlement + disclaimer gates | `api/auth.py`, `api/deps.py` | Tested |
| API: about 60 endpoints, problem+json, cursor pagination, rate limits, request IDs | `api/` | 29 HTTP tests |
| LLM client: per-user daily budget, circuit breaker, usage log, cost table, one validated retry | `llm/client.py` | Only in unrun `test_ops.py` |
| Ops: watchdog, backfill gap report, calendar refresh, maintenance, trial sweeper, billing reconcile, referral catch-up | `jobs/maintenance.py`, `jobs/billing_jobs.py` | Billing tested; maintenance and watchdog only in unrun `test_ops.py` |
| Live-price poller (Alpaca → DynamoDB → portal push) | `jobs/live_poller.py` | Only in unrun `test_ops.py` |
| **DynamoDB (your request: "have Dynamo receive all the data")** | `nuwrrrld/dynamo.py` | Tested under moto |
| Modal wiring: 37 functions, crons in ET, retries, secrets, Volume/Dict/Queue, `CRON_CONSOLIDATE` option | `modal_app.py` | Imports cleanly on Modal 1.6.1; never deployed |

### How Dynamo receives the data
Every job writes its output to Postgres, then mirrors the same rows to DynamoDB table `nwf_pipeline_data` (`pk = "<kind>#<key>"`, `sk` = date or id).
That covers 18 kinds: bars, indicators, signals, runs, hold/fold, rotation, council sessions and consensus, paper orders, fills and equity, followed calls, scores and grades, factors, health checks, and job runs.
Postgres stays the system of record. A Dynamo failure is logged and never fails a job.
Tests confirm the Dynamo item counts match Postgres for the signals, council and paper paths.
Switch it off with `DYNAMO_MIRROR=off`.
The same module holds `nwf_live_prices`, `nwf_rate_budget` (190 requests/min shared Alpaca cap), `nwf_market_cache` and `nwf_locks`.

---

## 2. Bugs found and fixed by the tests

1. A long invalidation above price was silently flipped to the right side by the ATR clamp. It is now rejected, which gives `no_consensus`.
2. A user entering their own referral code would have caused a 500, because the schema forbids a self-referral row. It is now rejected in code and logged.
3. `/signals/{ticker}` would have returned 500 from asyncpg date/text inference.
4. The Clerk webhook crashed after a valid signature because this `svix` version's `verify()` returns `None`. The handler now parses the verified body itself.
5. A same-day split and dividend gave different results depending on row order. The order is now fixed (dividend first, on pre-split shares).
6. The calendar swallowed every exception as "market closed", so a library error would have made every job skip silently. It now catches only `DateOutOfBounds`.
7. **The weekly council would never have run.** The cron fires Thu and Fri with one ISO-week key, so Thursday's "not the last session" skip was recorded as `skipped` and Friday got `not_claimed`. The check now runs before the claim, so a skip no longer consumes the week's key.
8. `followed_freeze` called `followed.freeze(conn)` without its own `today`, so the freeze decided on the real clock rather than the entrypoint's date. It now passes `today_et()`.

---

## 3. Known deviations and caveats (distrust these)

- **Pandas 3.x breaks `exchange_calendars`.** The Modal image pins `pandas~=2.2`, as the spec does, and the test env is on 2.2.3. Do not unpin it.
- **Global Hold/Fold stores one row per ETF per day.** The spec's unique index has no side column, so the row reports the side the bias supports (long unless bearish). Personal verdicts use the user's side.
- **`adj_close` equals `close` for Alpaca bars** (`adjustment=split`), so dividend-adjusted history is not provided.
- **Digest publishes at the 07:00 ET deadline even if less than 90% of explanations are LLM-validated** (templates fill the gap). The spec says to publish once 90% are validated; I chose not to let a slow LLM block the digest.
- **Dividend rate on a same-day split is assumed to be per pre-split share.** Unverified against Alpaca.
- **Notifications are only `audit_log` rows.** No email or push channel exists.
- **Nu AI glossary is an in-code dict.** The pgvector option was not built.
- **Chat streaming supports OpenAI-compatible providers only** (OpenRouter). The `anthropic` branch of `LLMClient` is non-streaming.
- **Dynamo "all the data" is a mirror, not a replacement.** At about 54 ETFs × a dozen item kinds a day it should fit the free tier. This is unmeasured, and the 25 WCU cap will throttle a large backfill.
- **Council strategies are still the spec's `placeholder.*`.** Every real session ends "consensus: flat" and creates no orders until you register real strategies.
- **Test status:** 241 passed (2026-10-07). Verified against local Postgres and moto only; see §4.2 for what has never touched a real service. Three assertions in `test_ops.py` still end in `or True` and cannot fail (§5.1).

---

## 4. What is left to do

Items are in order. Steps 1–3 are mine to finish. Steps 4 and beyond need you (accounts, secrets, decisions).

### 4.1 Finish verification

```bash
cd ~/code/nuwrrrld-portal-modal/deploy/modal-backend
PY=/opt/homebrew/Caskroom/miniforge/base/envs/nwf-modal/bin/python
$PY -m pytest -q --ignore=tests/test_ops.py
```
Expect 241 passed (including `test_ops.py`; drop the `--ignore` to run it). This needs the local Postgres started in the previous steps, or `TEST_PG_ADMIN_URL` set. Without Postgres, DB tests skip.

```bash
timeout 120 $PY -m pytest -q tests/test_ops.py -x -v 2>&1 | tail -30
```
macOS has no `timeout` binary; use `perl -e 'alarm 120; exec @ARGV' $PY -m pytest ...` for a hard limit. `test_ops.py` now runs in about 8 s.

### 4.2 Not yet tested at all
- Real Modal runtime: no `modal deploy` or `modal run` was ever executed.
- DynamoDB against real AWS (only moto).
- Alpaca against the live API (only mocked HTTP). Note that `sip` feed access was true on 2026-09-26; re-check.
- Real LLM calls, real Stripe, real Clerk.
- `CRON_CONSOLIDATE=1` dispatcher path.

### 4.3 Ship the code (nothing is committed)
No branch work has been committed or pushed. Per your rules, this is a PR-shaped unit, so `/pr-nwf` fits. Repo rules to apply:
- Stage by explicit path, never `git add -A`.
- Run the repo secret scan on the diff first.
- Ingest the PR into `docs/wiki-portal/` if it exists.
- Keep to the 3-open-PR cap.

```bash
cd ~/code/nuwrrrld-portal-modal && git status --short | head -20
```

### 4.4 Human-only setup (needed before any deploy)
Dashboard actions are marked 🖱.

1. 🖱 **Modal:** create `staging` and `prod` environments, confirm the plan allows custom domains and enough cron slots (37 functions, about 20 scheduled). If not, deploy with `CRON_CONSOLIDATE=1`.
   https://modal.com/settings
```bash
modal environment create staging
```
2. 🖱 **Postgres (Neon):** make a staging database or branch. You need the pooled URL (`DATABASE_URL`) and a direct URL (`DATABASE_URL_DIRECT`).
3. **Modal Secrets** (values from your own stores; never paste them into chat). Names to create per environment: `nuwrrrld-db`, `nuwrrrld-clerk`, `nuwrrrld-stripe`, `nuwrrrld-market`, `nuwrrrld-llm`, `nuwrrrld-observability`, `nuwrrrld-aws`. The key list is in `modal_app.py` and spec §3.2. Use the `secrets-sync` skill.
4. 🖱 **AWS:** create an IAM user limited to `dynamodb:*Item` and `Query` on `table/nwf_*`. Then:
```bash
cd ~/code/nuwrrrld-portal-modal/deploy/modal-backend
modal run modal_app.py::provision_dynamo --env staging
```
Expect the 5 `nwf_*` table names printed.
5. **Apply migrations, seed, smoke:**
```bash
modal run modal_app.py::migrate --env staging
modal run modal_app.py::seed --env staging
modal deploy modal_app.py --env staging
modal run modal_app.py::smoke --env staging
```
Expect `smoke OK`. `seed` needs the 54-ETF universe passed as `instruments_json`; that list does not exist in this repo yet.
6. 🖱 **Clerk and Stripe:** point webhooks at the staging API URL (`/v1/webhooks/clerk`, `/v1/webhooks/stripe`) and use a Clerk dev instance and Stripe test mode.

### 4.5 Product and plan decisions still open (spec §23)
- Real council strategies (currently placeholders) and their `strategy_config`.
- Whether to add `evening_dispatcher` consolidation permanently.
- Alpaca data-redistribution terms for showing prices to end users.
- LLM provider, models, daily budget, and the cost rate table (`LLM_RATE_TABLE_JSON`).
- Friend reward mode (`on_first_subscription` vs `on_signup`), referral cap, chat retention.
- Whether Dynamo should stay a mirror or become a read path for anything.

### 4.6 Migration phases not started (spec §22)
Shadow-mode run vs. the current pipelines for at least 10 sessions across a month boundary, the cutover evening, and legacy decommission. `SHADOW_MODE` exists in config but no code reads it yet.

### 4.7 Cleanup of my local scratch
These are all outside the repo and safe to remove:
- Local test Postgres: `/tmp/nwfpg` socket and the `pgdata` dir in the session scratchpad.
- Mamba env `nwf-modal`.

```bash
/opt/homebrew/Caskroom/miniforge/base/envs/nwf-modal/bin/pg_ctl -D "/private/tmp/claude-501/-Users-adamaslan-code-nuwrrrld-portal/33d1d3c1-31b8-4330-8432-826143cdbbf2/scratchpad/pgdata" stop
```

---

## 5. Making it faster (suggestions, added 2026-10-07, none applied yet)

Ranked by payoff. Line numbers refer to the files as they stand on this branch.

### 5.1 Test suite: the "stall" was a real 300 s sleep (APPLIED 2026-10-07)

`_wait_for(conn, ctx, job, run_key, sleep=time.sleep)` in `nuwrrrld/jobs/entrypoints.py:30` binds the real
`time.sleep` as a default argument when the module is imported. The `entry` fixture in `tests/test_ops.py:121`
patches `ep.time.sleep` afterwards, which never reaches that default. So every entrypoint test with a `needs=`
dependency that isn't already `succeeded` sleeps `DEPENDENCY_POLL_SECONDS` (300 s) × `DEPENDENCY_MAX_POLLS`
(patched to 2) = 10 minutes of real time. That matches "the full run did not finish within 200 s".

The same trap exists in `ingest.ingest_eod(sleep=time.sleep)` and `paper.fill_pending(sleep=time.sleep)`. Those two
are safe today only because tests pass `sleep=` explicitly.

Fix (applied in `entrypoints.py`, `ingest.py`, `paper.py`): resolve the sleep at call time.
```python
def _wait_for(conn, ctx, job, run_key, sleep: Callable[[float], None] | None = None) -> bool:
    sleep = sleep or time.sleep
```
Still open: tighten the three `... or True` assertions in `tests/test_ops.py:62-66`. As written they cannot fail.

### 5.2 Test suite: general speed

| Change | Where | Expected effect |
|---|---|---|
| ~~Insert seed bars in one `executemany`~~ **APPLIED** | `tests/conftest.py` `seed_bars` | The `bars` fixture does 5 × 330 = 1,650 round trips per test. One batch makes it about one round trip. Likely the largest share of DB-test time. |
| Build a migrated template DB once, then `CREATE DATABASE ... TEMPLATE` | `tests/conftest.py` `test_dsn` | Migrations run once per machine, not once per session. |
| `pytest-xdist` (`-n auto`), one DB per worker (the fixture already uses a uuid name) | `pytest.ini` | Roughly linear in cores for the pure tests. |
| Add `pytest-timeout` with `timeout = 60` | `pytest.ini` | A future stall fails loudly with a stack trace instead of hanging. |

### 5.3 Pipeline wall-clock: chain the evening stages instead of fixed crons

Today the evening runs on staggered cron slots: ingest 17:30 → equity 17:50 → signals 18:00 → followed 18:20 →
council 18:45. Each downstream job then polls `job_runs` every 5 min (`_wait_for`). If ingest finishes at 17:33,
signals still waits until 18:00. If ingest runs long, signals burns a container polling.

- **Chain on success.** At the end of a successful `ingest_eod_bars`, `.spawn()` `equity_snapshots` and
  `signals_pipeline`. `signals_pipeline` spawns `followed_score` and `council_daily`. Keep the existing crons as a
  late safety net. Idempotency keys already make a double run a no-op. This also cuts the cron count, which
  removes the need for `CRON_CONSOLIDATE`.
- **Start ingest earlier.** SIP daily bars are available about 15 minutes after the 16:00 close. Moving ingest to
  about 16:20 ET, with the existing 5-min poll loop as the guard, gets the whole evening out roughly an hour sooner.
  Verify SIP bar finality timing against live Alpaca before relying on it (see §4.2).

### 5.4 Pipeline compute: stop doing the same work twice

| Hotspot | Where | Suggestion |
|---|---|---|
| `_frames()` (load ~420 days of bars for every ticker + compute every indicator frame) runs in both `generate` and `generate_hold_fold`, and `compute_sector_rotation` loads the bars a third time | `jobs/signals.py` | Compute it once in `signals_pipeline` and pass `(tracked, bars, frames)` to each stage. Or read the Parquet cache that ingest already writes to the Volume, instead of Postgres. |
| One `INSERT ... RETURNING` per ticker for signals, and one `INSERT` per ticker for hold/fold | `jobs/signals.py` `generate`, `generate_hold_fold` | One multi-row `INSERT ... ON CONFLICT ... RETURNING ticker, id` per stage. |
| Watchlist alerts run 2 queries per (item × rule): N+1 | `jobs/signals.py` `evaluate_watchlist_alerts` | One query per rule kind that joins today vs. the previous session for every watched ticker, then one batched `INSERT`. |
| `paper_portfolios.rules` re-queried per order, and `spread_bps` makes one Alpaca request per ticker | `jobs/paper.py` `fill_pending` | Load rules once per portfolio. Fetch spreads with one `/v2/stocks/snapshots?symbols=...` call per batch, since the endpoint takes many symbols. This also saves shared rate budget. |

### 5.5 Backfill: batch symbols, don't fan out per ticker

- `backfill_job` starmaps `backfill_bars_for_ticker` once per ticker, so each container makes its own one-symbol
  Alpaca request. That breaks the 150-symbols-per-request batching rule and spends about 54× the rate budget.
  Fetch all symbols in 150-symbol chunks (`daily_bars` already does this), and fan out by date range instead of by
  ticker if parallelism is needed.
- `backfill_gaps.repair` spawns one function per **ticker × missing day**. For a 3-day gap that is about 160
  containers for work that is one batched request. Use a single `backfill_bars(tickers, first_gap, last_gap)` call.
- Many concurrent containers each call `market_cache.commit()` on the same Volume. Write Parquet once at the end.

### 5.6 Modal runtime

- `enable_memory_snapshot=True` on the API and the hot fan-out functions (`explain_one_signal`,
  `run_council_session`, `followed_grade`). pandas, `exchange_calendars` and boto3 imports dominate cold start.
  Move the heavy imports to module scope (or `@modal.enter(snap=True)`) so they are captured in the snapshot.
- `max_containers=10` on `explain_one_signal` caps digest fan-out at 10. The LLM provider's rate limit is the real
  cap, so raise this to match it (and the per-user budget), not a round number.
- Separate `.pip_install` layers for the heavy, stable packages (pandas, numpy, pyarrow, exchange_calendars) and
  the volatile ones, so a version bump to `stripe` or `svix` doesn't rebuild the big layer.

### 5.7 DynamoDB mirror

- The mirror writes synchronously inside every job, and at 12 WCU a large backfill will throttle. boto3's adaptive
  retries then slow the job down even though a mirror failure "never fails a job". Options: skip the mirror for
  `is_backfill` runs, or queue mirror rows (a Modal Queue) and drain them in one background function paced to the
  WCU budget.
- `json.dumps` on every item, just to check size, doubles serialisation cost. Check size only for kinds that can be
  large (council sessions, health checks).

### Suggested order
5.1 (unblocks verification, about 10 lines) → 5.2 seed batching → 5.5 (rate-budget correctness, not just speed)
→ 5.3 chaining → 5.4 → 5.6 / 5.7 once there is a real Modal deploy to measure against.

---

## 6. Not touched
- Your main checkout (`~/code/nuwrrrld-portal`) and its uncommitted files, including `.env.local`.
- Existing `deploy/aws-modal-news`, `universe-hydration`, `precompute-ai`, `free-model-refresh`.
- Any live Modal, AWS, Stripe, Clerk, or Postgres resource.
