  # Modal pipeline status

**Verified live** 2026-09-21 via `mamba activate modal1 && modal app list --json`
/ `modal secret list` against the `chillcoders` workspace. This is a snapshot,
not a monitor — re-run those two commands before trusting any row below if
this file is more than a few days old.

## The one-line summary

Of the six Modal apps that exist as source across `nuwrrrld-portal` and
`homebase`, **exactly one is deployed**: `free-model-refresh`. Everything else
— `nuwrrrld-universe-hydration`, `nuwrrrld-precompute-ai`, and the three
`homebase` signal apps — is source-only. `modal run` works on all six (it
ships the code to Modal's cloud and runs it once, using real secrets and
hitting the real portal); `modal deploy` has only ever been run on one. A
`schedule=modal.Cron(...)` in a file does not mean a cron is firing — the
schedule only exists after `modal deploy`. This has been true since at least
2026-08-18 and is unchanged as of this verification.

**Direction (2026-09-22):** all three pipelines (GHA, Modal, GCP) are being
re-cut to run entirely on free tiers, with the financial data science doubled
in both Neon and Firestore. See §"Free-tier maximization plan" near the end.
Every run will also report what it filled and which model served it; see
§"Success and failure reporting" and the interactive diagram in
`docs/pipeline-atlas.html`. For where OpenRouter is under-used (paper
portfolios have never executed a run), and for the strongest-signal articles
design, see §"Core features and AI across the three pipelines".

## Live state (2026-09-21)

```
$ modal app list --json
[{"app_id":"ap-085dpOUqulcu4W3gbHxDcb","description":"free-model-refresh",
  "state":"deployed","tasks":"0","created_at":"2026-07-14 18:11:05-04:00",
  "stopped_at":null}]

$ modal secret list
nuwrrrld-secrets      created 2026-07-14 20:22 EDT   last used 2026-08-12 17:18 EDT
free-model-refresh    created 2026-07-14 18:11 EDT   last used 2026-09-21 05:00 EDT
```

`free-model-refresh`'s secret was read at **2026-09-21 05:00 EDT = 09:00
UTC** — exactly its `modal.Cron("0 9 * * 1")` — so its weekly cron is
confirmed live and firing on schedule. `nuwrrrld-secrets` hasn't been read
since 2026-08-12, consistent with the `homebase` apps still being undeployed.
No `nuwrrrld-hydration` or `nuwrrrld-precompute` secret exists in the
workspace at all — deploying `universe-hydration` or `precompute-ai` as
written would fail at `modal deploy` time (secret resolution happens at app
construction), not silently at run time.

## Inventory

| App | File | Cron in source | Deployed? | Secret | Purpose |
|---|---|---|---|---|---|
| `free-model-refresh` | `nuwrrrld-portal/deploy/free-model-refresh/modal_app.py` | `0 9 * * 1` (Mon 09:00 UTC) | ✅ yes | `free-model-refresh` | weekly probe of `FREE_MODEL_CHAIN`; opens a PR if the chain changed |
| `nuwrrrld-universe-hydration` | `nuwrrrld-portal/deploy/universe-hydration/modal_app.py` | `5 0 * * *` (00:05 UTC daily) | ❌ no | `nuwrrrld-hydration` *(doesn't exist)* | zero-AI-cost per-stock indicator cards, posted to the portal |
| `nuwrrrld-precompute-ai` | `nuwrrrld-portal/deploy/precompute-ai/modal_app.py` | none — deliberately removed | ❌ no | `nuwrrrld-precompute` *(doesn't exist)* | manual/failover runner only; GHA owns the live schedule (see below) |
| `nuwrrrld-signals` | `homebase/modal_locrun.py` | `15 18 * * 1-5` (14:15 ET weekdays) | ❌ no | `nuwrrrld-secrets` | signal scan → Firestore |
| `nuwrrrld-drain` | `homebase/modal_drain.py` | `*/5 13-20 * * 1-5` (market hours) | ❌ no | `nuwrrrld-secrets` | live-price drain |
| `nuwrrrld-finnhub-ws` | `homebase/modal_finnhub_ws.py` | none (manual/long-running) | ❌ no | `nuwrrrld-secrets` | Finnhub websocket stream |

## What's actually running each job today

| Job | Live scheduler | Why |
|---|---|---|
| Weekly `FREE_MODEL_CHAIN` refresh | **Modal**, `free-model-refresh` (confirmed firing above) | only deployed app; GHA has its own independent copy at a different time (`refresh-free-models.yml`, Mon 06:17 UTC) — intentional four-way redundancy per `docs/deploy-runner-decision.md` Finding 3, not a conflict |
| `precompute-ai` batch (AI narratives, top-of-ranking) | **GitHub Actions**, `.github/workflows/precompute-ai.yml` (`10 0 * * *`) | Modal's copy was deliberately stripped of its `schedule=` on `feat/pipeline-full-runs-nulogdash` to end a real double-fire (`incident-2026-09-04-precompute-ai-double-schedule`); it survives only as a manual/failover `modal run` target |
| Per-stock universe hydration (free indicator cards) | **Neither, live** — `hydrate-universe.yml` (GHA, weekdays 22:30 UTC) covers this today; the Modal job (`5 0 * * *`) is unscheduled since it's never been deployed | `docs/deploy-runner-decision.md` Finding 2 found these two overlap on the stock lane and is unresolved — deploying the Modal app without addressing that would double-fire, same class of bug as Finding 1 |
| Signal scan / live-price drain / Finnhub stream | **`homebase`'s own mechanism** (not verified here — out of this doc's scope) | all three Modal apps are undeployed; whatever currently produces homebase's signals is not one of these |

## Open items blocking the undeployed apps

- **`nuwrrrld-hydration` and `nuwrrrld-precompute` secrets don't exist.** Both
  `universe-hydration` and `precompute-ai` fail at `modal deploy` until
  someone runs the `modal secret create` command documented in each file's
  own module docstring.
- **`docs/manual-setup-todo.md` §5e is still open**: confirm via `modal app
  list` (now done — this file *is* that confirmation: `nuwrrrld-precompute-ai`
  has no row, so §5e is moot) and update that TODO to reflect it.
- **Finding 2 (`hydrate-universe.yml` vs. `universe-hydration` Modal app)
  remains unresolved** in `docs/deploy-runner-decision.md` — pick one
  scheduler for the stock lane before deploying the Modal job.
- **JSON-twin drift**: `docs/manual-setup-todo.md` (~line 593) notes
  `universe-hydration`'s confluence math isn't drift-pinned against
  `lib/shared/card-policy.ts` by a test yet — relevant before this job goes
  live, not after.

## Verifying this yourself

```bash
mamba activate modal1
modal app list --json
modal secret list
```

Expect one row in `app list` (`free-model-refresh`, `state: deployed`) unless
someone has since run `modal deploy` on another app in the inventory table —
if so, this file is stale and should be updated, not trusted.

## Core features across GCP, Modal, and GitHub Actions — and the Firestore write path

The three compute hosts are not interchangeable — each owns a different shape
of work, and today only **one of the three has Firestore as its native
target.** This section compares their core functions and end goals, then
states where each one's output does (or doesn't) reach Firestore, since the
goal is for every pipeline whose output has a mobile/read audience to land
there.

### Functions and end goals

| | **GCP (gcp3 / Cloud Run)** | **Modal** | **GitHub Actions** |
|---|---|---|---|
| Core function | Always-on serving layer: vendor fallback chain (Finnhub → Alpha Vantage → yfinance) + feature modules, refreshed daily | Burst compute lane: fan-out (`pandas`/`numpy`), long timeouts, scale-to-zero containers, cron-scheduled or manual-run | Cron scheduler + CI runner living next to the portal's own secrets; calls authenticated portal API routes rather than computing itself |
| What it computes today | 54 ETFs' signals (RSI/MACD/etc.), cached | Per-stock indicator cards (`universe-hydration`, undeployed); nothing else computes anything — `precompute-ai` and `free-model-refresh` call an endpoint, they don't compute | Nothing itself — every workflow's real work happens inside the portal route it POSTs to (Neon reads/writes, OpenRouter calls) or, for `backup-to-sqlite.yml`, a local script reading Neon directly |
| End goal | Fast, correct, low-latency reads for a small curated universe it fully owns | New coverage that doesn't fit gcp3's shape: ~4,300-stock nightly fan-out, zero-AI-cost indicator cards, occasional heavy/long jobs | The default scheduler for anything that's mostly "call one portal route on a timer" — cheapest to operate, no separate account/token to manage |
| Failure mode | Quiet — `HTTP 200 {"error":"not found"}` for an unsupported symbol (the trap `docs/modal-vs-gcp-signal-coverage.md` documents) | Loud — an uncaught exception, a red Modal run | Loud — a red Action run, routed to a `pipeline-failure` GitHub issue by each workflow's `notify` job |
| Owns identity for | Firestore + Cloud Run via `GCP_PROJECT_ID`/WIF | A separate `chillcoders` Modal account/token (`~/.modal.toml`) | Whatever's in the repo's `Secrets` (shared with Vercel's own env in most cases) |

### Where each one's output lands today

| Host / job | Writes to | Firestore leg? |
|---|---|---|
| **gcp3** (Cloud Run backend) | **Firestore is its native store** — `gcp3/backend/firestore.py` is both the cache and the feature store; there is no other database in front of it | ✅ yes — always has been, it's not a mirror, it's the primary store |
| **Modal** `nuwrrrld-universe-hydration` | POSTs to the portal's push endpoint → **Neon** (`ticker_cards`), never Firestore directly, by design (the module docstring: validation/idempotency/replacement-rule logic "all stay in one place" in the portal route) | ❌ no — the per-stock cards this job produces have no Firestore leg at all today |
| **Modal** `nuwrrrld-precompute-ai` | POSTs to `/api/pipeline/precompute-ai` → **Neon** (cached AI narratives) | ❌ no |
| **Modal** `free-model-refresh` | Opens a GitHub PR; no data store involved | n/a |
| **homebase Modal** `nuwrrrld-signals` (`modal_locrun.py`) | **Firestore directly** — the only Modal app with a `google-cloud-firestore` dependency; matches `scans`/`summaries` pattern noted in `docs/nulogdash-dashboard-plan.md` | ✅ yes |
| **homebase Modal** `nuwrrrld-drain` / `nuwrrrld-finnhub-ws` | POST to the portal (`EXPO_PUBLIC_PORTAL_URL`) — same portal-API-first pattern as the two portal Modal apps | ❌ no, not directly — whatever the portal route they hit does with it |
| **GHA** `precompute-ai.yml` / `hydrate-universe.yml` | Same portal routes as their Modal counterparts → **Neon** | ❌ no |
| **GHA** `backup-to-sqlite.yml` | **Neon → SQLite** file artifact | ❌ no — a third store, not Firestore |
| **GHA** `paper-portfolios.yml` (the run route it triggers) | **Neon (source of truth) → SQLite snapshot → Firestore mirror**, per `docs/council-paper-portfolios.md` | ✅ yes — this is the one existing example of the pattern the rest of the system is missing |
| **GHA** `refresh-free-models.yml`, `compile-grounding-pack.yml`, `model-usage-report.yml`, `signal-freshness-check.yml`, `select/track/judge-followed-tickers.yml`, `e2e-resiliency.yml`, `ci.yml`, `integration-tests.yml`, `afternoon-pipeline.yml` | Repo files, Neon, or nothing persistent (CI checks) | ❌ no |

### The one working precedent: paper-portfolios' mirror

`lib/paper-firestore-mirror.ts` is the only place in this codebase that already
does what's being asked for everywhere else. Its shape, from
`docs/council-paper-portfolios.md`:

- **Neon stays the source of truth.** Firestore is written *after* the Neon
  transaction commits, **non-fatal on failure** — a mirror write failing must
  never fail the run that produced the data.
- **Firestore is shaped for reads**, not a copy of the Neon schema: e.g.
  `paper/{account}/orders/{order_id}` keyed by the Neon `uuid` so a replayed
  mirror is idempotent, and a 400-day retention prune that only touches
  Firestore (Neon and SQLite keep everything — Firestore is a mirror, not an
  archive).
- **Mirrors only what changes meaningfully**, not every run — watchlists mirror
  on seed/version-bump, not on every 4x-daily run, "or re-writing 501 docs four
  times a day to say nothing would be the single largest write cost in the
  design."

### What "send to Firestore wherever related" means concretely

Given the table above, three gaps are real candidates for the same mirror
pattern — each is a **new, scoped mirror writer added to the portal route the
job already POSTs to**, not a change to what Modal/GHA does directly (the
"only the portal route touches the database" invariant in the Modal module
docstrings is worth keeping — see the "Why it posts to the portal" reasoning
in `deploy/universe-hydration/modal_app.py`):

1. **`universe-hydration`'s per-stock `ticker_cards`** — no Firestore leg today.
   If the mobile app is meant to read individual stock cards (not just the
   paper-portfolio book), this is the first gap to close: mirror
   `ticker_cards` into a `tickers/{symbol}` collection the same non-fatal way
   `mirrorPaperAccount()` does, inside the portal's push-endpoint handler.
2. **`precompute-ai`'s cached AI narratives** — same shape of gap. A mobile
   read of "why does this ticker rank where it does" currently has nowhere to
   come from but a direct Neon read through the portal's own API; mirroring
   the generated narrative alongside its `ticker_cards` write would close that
   in the same commit.
3. **gcp3's ETF rows and the Modal stock rows never merge into one Firestore
   shape.** `gcp3/backend/firestore.py` already owns ETF documents; a
   `tickers/{symbol}` collection fed by universe-hydration would need a
   layout that doesn't collide with gcp3's existing ETF documents — same
   "gcp3 owns ETF rows, Modal owns stock rows" boundary that already governs
   Neon (`ticker_cards.source`), just extended into Firestore's document
   namespace. Building the mirror without deciding this first risks the exact
   "two writers, numbers flicker" failure `docs/modal-vs-gcp-signal-coverage.md`
   already warned about for Neon.

None of this is built yet — `universe-hydration` and `precompute-ai` are still
undeployed (see the inventory above), so there's no live traffic to mirror
until deployment happens regardless. This section is the design note for when
that changes, not a claim that the mirror exists.

## Neon vs. Firestore: what each is doing today, and the functional-parity goal

The two databases are not currently peers — they hold structurally different
kinds of data for different reasons. Getting them to "the same core
functionality" means picking, per feature domain, whether Firestore should
gain a **mirror** of something Neon already owns (the paper-portfolios
pattern), or whether the domain doesn't belong on mobile at all and the gap is
correct as-is. This section lays out what's actually in each database today so
that decision can be made domain-by-domain instead of all-or-nothing.

### Neon — the system of record (35 tables, `lib/db/schema.sql`)

Everything the portal writes lands here first, inside a transaction, with full
relational structure (foreign-key-shaped IDs, `jsonb` payloads, Clerk
`user_id` scoping). Grouped by what each cluster of tables actually does:

| Domain | Tables | What it's for |
|---|---|---|
| Signal serving cache | `signal_digest_cache`, `user_digest_cache`, `signal_cache`, `live_prices`, `pending_signals` | Replaced the in-memory `Map`s that used to die on every serverless cold start — durable request/response caching for the signals surface |
| Ticker pipeline output | `ticker_universe`, `ticker_cards`, `analyze_cache`, `precomputed_ai` | **This is the output of Modal/GHA's hydration and precompute jobs** — per-ticker indicator cards and cached AI narratives, the thing §"Core features" above found has no Firestore leg yet |
| AI Council | `council_sessions`, `council_messages`, `council_verdicts`, `council_usage` | Multi-model deliberation transcripts, verdicts, and a daily cost-control quota per user |
| Hold/Fold | `holdfold_cache` | Cached buy/hold/sell verdicts per ticker |
| Followed-tickers eval harness | `followed_ticker_picks`, `followed_ticker_observations`, `followed_ticker_scores` | Internal benchmark — did the AI's picks actually perform? Not a user-facing feature |
| Backtesting | `backtest_hit_rates` | Nightly push target from the separate `signals-app` repo |
| Watchlists | `watchlist_items` | A signed-in user's tracked tickers |
| Paper portfolios | `paper_accounts`, `paper_runs`, `paper_watchlists`, `paper_positions`, `paper_orders`, `paper_nav` | The council's simulated trading book — **already fully mirrored to Firestore**, see below |
| Nu AI budget | `nuai_usage` | Daily per-user token/quota budget for the Nu AI chat surface |
| Grounding / RAG | `corpus_chunks`, `grounding_pack`, `grounding_misses` | Compile-time retrieval corpus the AI Council grounds its answers in |
| Public demo | `public_demo_usage`, `public_demo_cache` | The unauthenticated landing-page "ask the council" surface — no signed-in user, no mobile equivalent |
| Compliance / legal | `consent_records`, `legal_consent_events`, `privacy_requests`, `disclaimer_acks` | Cookie consent, ToS/Privacy Policy acceptance at signup, the GDPR data-subject-request statutory clock |
| Attribution | `user_attribution` | First-party acquisition tracking — marketing analytics, not a product feature |
| Ops / audit | `pipeline_run_log` | Every model-calling pipeline run, for `docs/model-usage/` reporting |

Neon is where **every write starts**, full stop — including the ones that
later get mirrored elsewhere. Nothing in this codebase writes Firestore first
and Neon second; that ordering is deliberate (see the "non-fatal mirror"
pattern below) and should stay deliberate if the domains below get their own
mirrors.

### Firestore — three different jobs under one product, today

Unlike Neon, "Firestore" isn't one schema with one owner. It's three
unrelated systems that happen to share a database technology:

1. **gcp3's `gcp3_cache` collection** — a single flat collection, one document
   per cache key, TTL-based (`set_cache(key, value, ttl_hours=…)` in
   `gcp3/backend/firestore.py`). **~15 backend modules** write into it
   (`morning.py`, `market_summary.py`, `macro_pulse.py`, `sector_rotation.py`,
   `news_sentiment.py`, `portfolio_analyzer.py`, `earnings_radar.py`,
   `industry.py`, `correlation_article.py`, `screener.py`, `ai_summary.py`,
   `technical_signals.py`, `feature_store.py`, `story_picker.py`,
   `write_content_local.py`) plus a generic `write_agent_document()` /
   `read_agent_document()` pair for anything else, and `refresh_state:{phase}`
   checkpoint docs for the nightly refresh pipeline. **This is a serving-side
   result cache, not a system of record** — there is no schema, no
   relationships, no audit trail, and every entry expires. It's how gcp3
   answers `/signals?symbol=XLK` in under a second: the 54-ETF computation
   already happened and Firestore is just holding the answer.
2. **The portal's own mirror — `paper/{account}/...` only.** `lib/paper-firestore-mirror.ts`
   writes here, and only here — six sub-collections (account, positions,
   watchlist, orders, nav, runs), all shaped for a mobile read, all written
   non-fatally after the Neon transaction that produced them commits. See
   `docs/council-paper-portfolios.md` for the full layout. Nothing else the
   portal owns is mirrored — not signals, not the AI Council, not Hold/Fold,
   not personal watchlists.
3. **`homebase`'s scan history** — `modal_locrun.py` (the one Modal app with a
   `google-cloud-firestore` dependency) writes a `scans`/`summaries` pattern
   directly to Firestore, independent of both of the above.

**None of these three overlap in collection namespace today** — `gcp3_cache`,
`paper/*`, and homebase's `scans`/`summaries` never write the same document.
That's an accident of nobody having built the overlapping feature yet, not a
guarantee; §"What 'send to Firestore wherever related' means" above already
flags the collision risk for a future `tickers/{symbol}` collection.

### The parity goal: same functionality, not the same storage model

"Same core functionality" should mean **Neon stays the only system of
record**, and Firestore becomes the complete answer to "can the mobile app do
everything the web app can do" — via the mirror pattern already proven on
paper portfolios, extended domain by domain rather than adopted everywhere at
once. Two databases holding independently-writable copies of the same fact is
the "numbers flicker" failure this codebase has already hit once (Neon vs.
gcp3 on ETF signals) and worked hard to design around; a one-directional,
non-fatal, after-commit mirror avoids repeating it.

Domain-by-domain status, ranked by whether a mobile user would actually
notice the gap:

| Domain | Neon has it | Firestore has it | Gap / recommendation |
|---|---|---|---|
| Paper portfolios | ✅ full | ✅ full mirror | **Done — this is the reference implementation.** |
| Ticker cards + AI narratives (`ticker_cards`, `precomputed_ai`) | ✅ full | ⚠️ partial — gcp3's `gcp3_cache` holds ETF results only, TTL-expiring, not durable; the Modal stock lane has no Firestore leg at all | **Highest-priority gap.** This is the data a mobile "what's this ticker doing" screen needs most. Needs the `tickers/{symbol}` collection + namespace decision already flagged above. |
| Personal watchlists (`watchlist_items`) | ✅ full | ❌ none (only paper-account watchlists are mirrored, which is a different table) | Second-priority gap — small, well-understood shape, same mirror pattern as paper's own `watchlist` sub-collection. |
| Hold/Fold verdicts (`holdfold_cache`) | ✅ full | ❌ none | Gap, moderate priority — mobile likely wants this alongside ticker cards. |
| AI Council (`council_sessions/messages/verdicts`) | ✅ full | ❌ none | Gap, but bigger lift — a chat-shaped transcript mirror is a different write pattern than the flat card mirrors above; worth its own design pass rather than folding into the ticker-cards work. |
| Live prices / signal cache (`live_prices`, `signal_cache`, `pending_signals`) | ✅ full | ❌ none | **Different kind of gap** — this is arguably a case where Firestore's real-time listeners are the *better* primary for a mobile ticking-price UI, not just a mirror target. Worth a deliberate "which one leads" decision rather than defaulting to "Neon leads, Firestore mirrors" here. |
| Nu AI / council usage quotas (`nuai_usage`, `council_usage`) | ✅ full | ❌ none | Low priority — mobile mainly needs "remaining today," a single small document, not the full row. |
| Compliance (`consent_records`, `legal_consent_events`, `privacy_requests`, `disclaimer_acks`) | ✅ full | ❌ none | Neon must stay sole source of truth here (statutory record) — if mobile needs anything, it's a read of *current status only*, never a mirror of the event history. |
| Public demo, attribution, backtest hit-rates, pipeline run log, followed-tickers eval | ✅ full | ❌ none | **Not gaps** — none of these have a mobile-facing use case (unauthenticated landing page, marketing analytics, internal eval harness, ops audit). Parity here would be mirroring for its own sake. |

### The pattern to reuse (not reinvent)

Every future mirror should follow what `lib/paper-firestore-mirror.ts`
already does, not a new design:

1. Neon transaction commits first. The mirror write happens after, and its
   failure is **logged, never fatal** to the request that produced the data.
2. The Firestore shape is **read-optimized**, not a copy of the Postgres
   columns — pick the document layout mobile screens actually query by.
3. Only mirror what a mobile screen will read. Compliance ledgers, internal
   eval harnesses, and ops logs are correctly Neon-only; extending the mirror
   to them would be scope creep, not parity.
4. Decide the collection-namespace boundary **before** writing the mirror, the
   same way `ticker_cards.source` already separates gcp3's ETF rows from
   Modal's stock rows in Neon — Firestore needs the equivalent boundary so a
   new `tickers/{symbol}` mirror and gcp3's existing `gcp3_cache` entries
   don't silently disagree about the same ticker.

## Free-tier maximization plan (added 2026-09-22)

**Goal:** run all three compute pipelines (GHA, Modal, GCP) at **$0**. Use
each free tier for the work it covers best. Then spend the spare room on
**twice the financial data science** in *each* database. None of the new
features calls an LLM. They are all deterministic pandas/SQL computed from
bars we already fetch.

### Free-tier ledger

Rows marked **live** were read on 2026-09-22 (Neon via its API; repo
visibility via `gh repo view`). The other rows are the last-known published
limits. Check them against each pricing page before relying on an exact
number, because vendors change them.

| Service | Free allowance | Our usage / headroom | Binding constraint? |
|---|---|---|---|
| **Neon** (`neon1`, Free plan) | **512 MB per branch** (live: `branch_logical_size_limit: 512`); ~100 CU-hours/month per project; scale-to-zero; 6h history retention (live) | **live:** 37 MB synthetic storage (~7%); ~29 h active at 0.25 CU ≈ **7 CU-h used** Sep 1–22; quota resets 2026-10-01. Largest table `ticker_cards` = 1.7 MB / 1,866 rows (~0.9 KB/row) | **Storage is the tightest limit in the whole stack.** Compute has about 10× headroom. |
| **GitHub Actions** | **Repo is PUBLIC (live)**, so standard-runner minutes are **unlimited and free**; 6h max per job; ~20 concurrent jobs | Scheduler for every portal route today | No. This is the cheapest compute we have. |
| **Modal** (Starter) | ~$30/month of free credits; scale-to-zero; `.map()` fan-out across containers | Only `free-model-refresh` (weekly, seconds) spends credit | No. Almost all of the credit goes unused. |
| **GCP** (always-free) | Cloud Run: 2M req, 180k vCPU-s, 360k GiB-s per month; Cloud Scheduler: 3 jobs; **BigQuery sandbox: 10 GB storage + 1 TB queries/month**; Cloud Storage: 5 GB (US regions) | gcp3 serves 54 ETFs from Cloud Run. BigQuery and GCS are unused | No. BigQuery is the unused lever. |
| **Firestore** (Spark / no-cost quota) | 1 GiB stored; **50k reads, 20k writes, 20k deletes per day**; 10 GiB egress/month | `gcp3_cache` TTL docs, the `paper/*` mirror, and homebase `scans` | **Writes/day** is the limit to design around (see budget below). |
| **OpenRouter** | `:free` models: ~20 req/min; **~50 req/day without purchased credits, ~1,000/day after a one-time ≥$10 credit purchase** | `FREE_MODEL_CHAIN` in `lib/openrouter.ts`; the precompute batch spends it on top-of-ranking narratives only | Yes, for narratives. **That is why none of the doubled features below uses a model.** |

### Pipeline roles, re-cut for $0

The rule is to put each kind of work on the host whose free tier covers it.

| Pipeline | Owns (free-maximized) | Stops doing / never does |
|---|---|---|
| **GitHub Actions** (unlimited minutes, public repo) | **Primary scheduler for everything**, plus the **daily feature compute**. A ~4,300-symbol pandas pass fits in one 16 GB runner job well under the 6h cap. It POSTs results to the portal's push routes, as `hydrate-universe.yml` already does | Never holds data. Never calls OpenRouter directly; model calls stay inside the portal route |
| **Modal** (~$30 credit) | **Burst and backfill only.** Runs the jobs that benefit from `.map()` across many containers: the one-time multi-year forward-return label backfill, the weekly correlation matrix, and failover when a GHA run fails. Keep `free-model-refresh` as it is | No daily cron that duplicates a GHA job. This resolves Finding 2 by making GHA the owner of the stock lane |
| **GCP** (always-free) | Cloud Run keeps serving gcp3's 54 ETFs. **New role: BigQuery sandbox as the cold archive** for full daily card and feature history, so Neon never holds more than a rolling window. Cloud Storage holds the SQLite backup artifact if we want it off GHA artifacts | No second writer for stock rows. The gcp3 = ETF, Modal/GHA = stock boundary stays |

The three stores then split by temperature:
- **Neon**: hot relational data, the system of record, holding a rolling window.
- **Firestore**: read-shaped mobile documents.
- **BigQuery/SQLite**: cold, complete history.

This split is what makes it safe to double the data science without hitting
Neon's 512 MB cap.

### Double portions of fin data science, per database

**Today's data-science portion** (the baseline being doubled): per-stock RSI,
MACD cross, ADX, volatility percentile, Bollinger, Stochastic, OBV/CMF and MA
cross, rolled into one confluence score and direction per horizon. Add the
paper-portfolio §7 metrics (`lib/paper-metrics.ts`) and the externally pushed
`backtest_hit_rates`. That is roughly **six feature families**. "Double"
means **six new families in each database**, each matched to what that
database is good at.

#### Neon: six new analytical families (relational, joinable, source of truth)

| # | New family | Table (proposed) | Computed by | Size budget |
|---|---|---|---|---|
| N1 | **Card history**: daily score/action/state per ticker, horizon and date | `ticker_card_history` (slim: no `tokens` jsonb, just ids, score, action, state_key and a few numerics) | GHA daily job, appended by the existing push route | ~120 B/row × 8,600/day. **Keep 180 days in Neon (~190 MB)**; BigQuery keeps everything |
| N2 | **Forward-return labels**: 1d/5d/20d realized return after each card | `card_outcomes` | GHA daily (labels mature); Modal one-time backfill | ~same row count as N1; pruned on the same 180-day window |
| N3 | **Self-computed calibration**: hit-rate and mean forward return per `state_key` × horizon (our own backtest, not dependent on `signals-app`) | `state_calibration` (small: one row per state) | SQL `GROUP BY` over N1 ⋈ N2, nightly | < 1 MB |
| N4 | **Risk stats**: 20d/60d realized vol, beta vs SPY, 1y max drawdown, downside deviation | columns in `ticker_cards.numerics` (no new table) | GHA daily, same bars pass | ~+200 B/row × 8,600 ≈ 2 MB |
| N5 | **Cross-sectional ranks**: sector-relative z-score and percentile of score, momentum and vol | SQL view over `ticker_cards` + `ticker_universe` (window functions) | Postgres at read time | 0 MB (view) |
| N6 | **Market regime**: breadth (% above 50/200 DMA), advance/decline, universe median vol, and a regime tag | `market_regime` (one row per day) | GHA daily | negligible |

Projected Neon footprint: about 37 MB today, plus about 400 MB for N1 and N2
at the 180-day window. That lands around 440 MB, which is **tight but under
512 MB**. If it gets too close, shrink the window to 120 days before dropping
any feature. The prune job belongs in the same GHA workflow, and BigQuery must
already hold the rows before they are pruned from Neon.

#### Firestore: six new read-shaped families (mobile screens, one doc per screen)

Design rule: **one document per thing a screen shows.** Precompute the
aggregate so mobile never fans out reads.

| # | New family | Document path (proposed) | Source | Writes/day |
|---|---|---|---|---|
| F1 | **Ticker detail**: current card for both horizons, N4 risk stats, N5 ranks, and a 30-point score sparkline array | `tickers/{symbol}` (stock lane only; ETF docs stay in gcp3's namespace, per the boundary above) | portal push route, non-fatal mirror after the Neon commit | ≤ 4,300. **Skip the write when the card is unchanged.** Expect ~1–2k |
| F2 | **Leaderboards**: top 50 / bottom 50 per horizon | `leaderboards/{horizon}` (overwrite daily) | same route, after the batch completes | 2 |
| F3 | **Movers**: upgrades/downgrades (state transitions since yesterday, from N1) | `movers/today` | same | 1 |
| F4 | **Sector heatmap**: median score, breadth and count per sector | `sectors/{sector}` | same | ~11 |
| F5 | **Market regime card**: N6 as one doc | `market/regime` | same | 1 |
| F6 | **Calibration**: "how often has this state worked" for each state_key (N3), shown on the ticker screen | `calibration/{state_key}` | nightly, only states whose stats changed | ≤ a few hundred |

**Write budget**: the new families add about 2–5k writes/day out of the 20k
free writes. The existing paper mirror and homebase scans sit on top of that,
and both are small. Deletes are bounded by an explicit prune: `tickers/*` docs
for delisted symbols only, and no history is kept in Firestore because
BigQuery holds it. Reads stay cheap because each screen is one document.

#### What stays the same (the invariants this plan keeps)

- **Neon first, Firestore after, non-fatal**: the same pattern as
  `lib/paper-firestore-mirror.ts`. GHA and Modal still POST only to portal
  routes. Neither writes a database directly.
- **Zero model cost for all 12 new families.** OpenRouter's free quota stays
  reserved for narratives. Narratives can *cite* N3/N4/N6 as grounding
  without making more calls.
- **gcp3 keeps ETFs.** F1 is stock-lane only until the `tickers/{symbol}`
  vs `gcp3_cache` namespace decision is made (see §"What 'send to Firestore
  wherever related' means").

### Order of work

1. **Resolve Finding 2 in favor of GHA** (`hydrate-universe.yml` owns the
   stock lane) and extend that job with N4 and N6. This uses bars already
   fetched, so it adds no new vendor calls.
2. **Add N1 + N2 + the BigQuery archive + the 180-day prune** as one unit.
   Neon's cap makes the archive a precondition, not a follow-up.
3. **Modal backfill** of N2 labels (one-off `modal run`, using the unused
   credit), then **N3 calibration** once enough labels exist.
4. **Firestore F1–F6** mirror writer in the push route, with the
   skip-if-unchanged check on F1.
5. N5 is a SQL view and can ship at any point.

### Check headroom yourself

Neon storage and compute (read-only):

```bash
curl -s -H "Authorization: Bearer $NEON_API_KEY" \
  https://console.neon.tech/api/v2/projects/lingering-rain-31058530 \
  | jq '.project | {synthetic_storage_size, branch_logical_size_limit, active_time, cpu_used_sec, quota_reset_at}'
```

Expect `synthetic_storage_size` well under 536870912 (512 MB).
`active_time` is in seconds; at 0.25 CU, divide by 14,400 to get CU-hours.

Confirm the repo is still public (this is what makes GHA minutes unlimited):

```bash
gh repo view --json visibility -q .visibility
```

Expect `PUBLIC`. If it ever flips to private, the free allowance drops to
2,000 minutes/month and this whole plan needs re-costing.

Modal spend this month (compare against the ~$30 free credit):

```bash
mamba activate modal1 && modal billing report --for "this month" --show-resources
```

🖱 **Dashboard:** Firestore daily read/write usage against the free quota:
https://console.firebase.google.com/ → project → Firestore → Usage

🖱 **Dashboard:** OpenRouter credits and daily free-model limit:
https://openrouter.ai/settings/credits

## Success and failure reporting: every run says what it filled and who served it (added 2026-09-22)

Right now a pipeline run reports only whether it crashed. It does not report
whether it **finished the job**. A hydration run that cards 700 of 762 stocks
exits green. A narrative run whose seat model returned a 404, so a smaller
fallback model wrote the text, looks the same as a clean run unless someone
reads `pipeline_run_log.models`. This section designs two things: a result
every run must report, and a fixed litmus test that all three pipelines are
checked against.

### What the live data shows (Neon, read 2026-09-22)

| Check | Result |
|---|---|
| `ticker_cards` by source | **100% `hydrate-local`**: 762 stock tickers and 171 ETF tickers, both horizons, all `bar_date = 2026-09-22`. **Zero rows** from `gcp3`, `modal-eod` or any GHA run id |
| Registered but never carded | 43 stocks + 7 ETFs, all `active = false` (crypto pairs, OTC ADRs, `VTSAX`, preferreds). That is correct pruning, not a gap |
| **gcp3's 54 industry ETFs in Neon** | **Only 9 of 54 are present** (BOTZ, HACK, KRE, ROBO, URA, VOX, XLB, XLE, XLU). **The other 45 are not in `ticker_universe` at all**, so no hydration run will ever try to card them |
| `pipeline_run_log` coverage | Only 3 pipelines log to it (`precompute-ai` ×12, `followed-tickers` ×2, `followed-tickers-judge` ×2). **Hydration, paper-portfolios, gcp3 and homebase signals write no run record at all** |

### Why Neon doesn't have the 54-ETF set

Nothing is blocking it. **The list was just never registered.**

- Neon's 171 ETFs come from `scripts/seed-signals-universe.mjs`, which reads a
  CSV's `asset_type` column. That CSV is a broad fund list. It is not gcp3's
  `INDUSTRIES` map, and the two overlap on only 9 symbols.
- `scripts/seed-etf-cards.mjs` was written to copy gcp3's 54 into Neon (one GET
  of `/signals`, one POST, `source = 'gcp3'`). It is a **one-off manual
  script**. No workflow or Modal app schedules it, and Neon holds **no**
  `source = 'gcp3'` rows today. `prune-universe.mjs` only sets
  `active = false` and never deletes rows, so it did not remove them. The
  script was either never run against production, or its rows were
  overwritten. Either way, the 45 are missing from the universe table.
- So the "gcp3 owns ETF rows, Modal/GHA own stock rows" boundary (§"Core
  features") **is not what Neon actually holds**. Every ETF card in Neon today
  comes from the indicator-based hydrate lane, not gcp3's return- and rank-based
  engine.

That makes the 54 a good litmus test, as suggested. It is a fixed, named,
small set that gcp3 already computes. Each pipeline either fills all 54 or it
doesn't, and a miss points to a cause: a symbol isn't registered, a vendor
returned no bars, a write failed, or a mirror was skipped.

### Design 1: every run writes one result row (extend `pipeline_run_log`)

Use the one audit table we already have instead of creating another. Add three
columns. The first two are small text values, and the third is small jsonb, so
the storage cost is negligible against Neon's 512 MB cap:

```sql
ALTER TABLE pipeline_run_log
  ADD COLUMN IF NOT EXISTS host     text,   -- 'gha' | 'modal' | 'gcp' | 'local'
  ADD COLUMN IF NOT EXISTS status   text,   -- 'ok' | 'degraded' | 'partial' | 'fail'
  ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}'::jsonb;
  -- coverage: { expected, filled, missing: [..≤50 symbols], missing_count, stale_count }
```

Also widen `PipelineName` in `lib/pipeline-run-log-db.ts` to include
`hydrate-universe`, `paper-portfolios`, `gcp3-signals` and `homebase-signals`.
Each pipeline then logs from the place it already finishes:

| Pipeline | Where it logs | `expected` means |
|---|---|---|
| `hydrate-universe` (GHA / Modal / local) | end of the POST handler, once per chunk. The report sums chunks by `session` = the caller's `runId` | active `ticker_universe` rows for that universe |
| `precompute-ai`, `followed-tickers*` | already log; add `host`/`status` | subjects the batch selected |
| `paper-portfolios` | end of the run route, after the Firestore mirror attempt | 8 accounts, plus `mirror_ok: bool` |
| gcp3 `/signals` refresh | a POST to a new portal route, `/api/pipeline/run-ingest`, at the end of gcp3's refresh. gcp3 must not get Neon credentials | the 54 in `INDUSTRIES` |
| homebase `nuwrrrld-signals` | same `run-ingest` route, from `modal_locrun.py` | its scan list |

**Status rules**, decided in one pure function (`lib/shared/run-status.ts`) so
they can be unit tested:

| Status | When |
|---|---|
| `ok` | `filled == expected`, and no model substitution happened |
| `degraded` | everything was filled, but **a fallback model served ≥1 item**, or an item came back `empty` |
| `partial` | `filled / expected ≥ 0.95` (named constant) |
| `fail` | below that, or the run threw |

`partial` and `fail` open or update the existing `pipeline-failure` GitHub
issue, the same way each workflow's `notify` job already does. `degraded` does
not page anyone. It shows up in the daily report instead.

### Design 2: report every model substitution, with the reason

`RunItem.fallback` already records **that** a `FREE_MODEL_CHAIN` model served.
It does not record **why** the primary model lost, or which models failed
before one succeeded. Right now `fetchWithModelFallback` drops that
information in its `catch` block.

- Have `fetchWithModelFallback` / `...Checked` return
  `attempts: { model, status: number | 'timeout' | 'network' | 'empty' }[]`
  next to `{ response, model }`. This is a type-only widening, and existing
  callers can ignore the new field.
- Add `RunItem.primaryModel` and `RunItem.attempts`, and roll them up in
  `rollupModels` as `lostTo: { [reason]: n }` for each primary model.
- Report it as: *"RISK seat: primary `x` 404 ×5 → served by `y`"*. A primary
  model that has **404'd on every call for 2 runs** is a dead model. That is
  the failure the 2026-09-07 refresh found by hand (see the comments in
  `lib/openrouter.ts`). `refresh-free-models.yml` can read this and propose
  replacing the dead model instead of waiting for someone to notice.

### Design 3: the 54-ETF litmus test, across all three pipelines and both stores

One scheduled GHA job (`pipeline-litmus.yml`, weekday mornings next to
`signal-freshness-check.yml`) checks **the same 54 symbols** in every place
they should appear. It is read-only, and it writes its own `pipeline_run_log`
row with `pipeline = 'litmus-54'`.

| Leg | Where it reads | Pass = |
|---|---|---|
| **GCP compute** | gcp3 `GET /signals` | 54 rows, `data_quality = fresh` |
| **Firestore (gcp3)** | the same response, since it is served from `gcp3_cache` | same 54 |
| **Neon** | a new portal `GET /api/pipeline/hydrate-universe?meta=coverage&symbols=…` | 54 × 2 horizons, `bar_date` = the last trading day |
| **GHA / Modal hydration** | `pipeline_run_log` rows for `hydrate-universe` since the last close, filtered by `host` | the run that wrote those cards is named, not just "somebody did" |
| **Firestore (F1 mirror)** | *after F1 ships*: `tickers/{symbol}` for the 54 | 54 docs, `bar_date` matches Neon |

Output is a per-symbol grid (symbol × leg: ✅ / ⏳ stale / ❌ missing), so a
miss names the leg that caused it. Two rules keep the test honest:

- **Presence and freshness are checked. Scores are not required to match.**
  gcp3 scores ETFs by returns and rank, while the hydrate lane uses
  indicators. The test reports the **direction agreement rate** between the
  two engines as information only, and never fails on it.
- **The 54 are defined in one place.** The litmus job fetches them from gcp3's
  `/signals` response. It does not keep its own copy of the list, so if
  `INDUSTRIES` changes, the test changes with it.

### Open decision — resolved 2026-09-22, Option 1

F1 (`tickers/{symbol}`) was **stock only**, because "gcp3 owns ETFs". Neon
showed that boundary was never enforced (only 9/54 overlapped), so it had to
be picked explicitly:

1. **Neon's hydrate lane owns every ETF card.** Register the 54, and F1
   mirrors ETFs too. gcp3's `/signals` stays a separate, independent engine,
   and the litmus test compares the two. *Recommended: this gives one write
   path per store and makes the three-way comparison meaningful.* **← chosen.**
2. ~~gcp3 owns the 54. Schedule `seed-etf-cards.mjs` as a real GHA job.~~ Not
   chosen — `scripts/seed-etf-cards.mjs` stays manual/unscheduled, since
   Option 1 was already the effective default: `card-policy.ts`'s
   `dataQuality` tie-break silently favors the hydrate lane's card over
   gcp3's on any overlap (see `docs/wiki-portal/concept-signal-engine-host-parity.md`),
   so gcp3-owned cards would never have actually landed for the 9 overlapping
   symbols anyway.

**Registration completed 2026-09-22**, per the runbook below, with one live
drift from when this doc was written: gcp3's live `/signals` response
returned `MOO` in place of `PBS` (54 symbols either way — the underlying
`INDUSTRIES` list moved between the doc being written and the registration
running). Both were registered; final state is all 54 of gcp3's *current*
industry ETFs present in `ticker_universe` and carded (`missing: 0` on
re-verification). This is a real, expected kind of litmus finding — the
Phase 9 litmus test fetches the 54 from gcp3's own `/signals` response each
run specifically so it never needs its own copy of this list.

### Close the 45-ETF gap (either option starts here)

**Step 1: preflight.** Read-only. Lists which of gcp3's 54 are missing from
Neon:

```bash
cd ~/code/nuwrrrld-portal
node -e '
const {neon}=require("@neondatabase/serverless");
const url=require("fs").readFileSync(".env.local","utf8").match(/^DATABASE_URL=(.*)$/m)[1].replace(/^"|"$/g,"");
(async()=>{
  const r=await fetch("https://gcp3-backend-cif7ppahzq-uc.a.run.app/signals").then(r=>r.json());
  const rows=Array.isArray(r)?r:(r.signals??r.etfs??Object.values(r).find(Array.isArray)??[]);
  const want=rows.map(x=>x.symbol??x.ticker).filter(Boolean);
  const have=(await neon(url)`SELECT ticker FROM ticker_universe WHERE ticker = ANY(${want})`).map(x=>x.ticker);
  const miss=want.filter(t=>!have.includes(t));
  console.log("gcp3:",want.length,"in Neon:",have.length,"missing:",miss.length);console.log(miss.join(","));
})()'
```

Expected output: `gcp3: 54 in Neon: 9 missing: 45`, followed by the list.

**Step 2: register the 45 as ETFs.** This writes to production. The PUT only
registers membership and does not create cards:

```bash
cd ~/code/nuwrrrld-portal
SYMS="BOAT,CARZ,CLOU,DBA,ESGU,ESPO,FDN,FINX,FTXR,IBB,IBUY,ICLN,IGV,IHF,IHI,INDS,IPAY,ITA,ITB,IYR,JETS,KBE,KIE,LIT,LUXE,MSOS,PAVE,PAWZ,PBJ,PBS,PEJ,PFM,REM,SLX,SOCL,SOXX,UFO,VHT,XHB,XLK,XLP,XLV,XME,XPH,XRT"
BODY=$(node -e 'console.log(JSON.stringify({entries:process.argv[1].split(",").map(t=>({ticker:t,universe:"etf"}))}))' "$SYMS")
awk -F= '$1=="PORTAL_PUSH_SECRET"{sub(/^[^=]*=/,"");gsub(/^"|"$/,"");printf "Authorization: Bearer %s",$0;exit}' .env.local \
  | curl -s -X PUT -H @- -H 'Content-Type: application/json' \
      --data "$BODY" https://financial.nuwrrrld.com/api/pipeline/hydrate-universe
```

Expected output: `{"ok":true,"registered":45,"rejected":[]}`. If the portal's
production URL differs, replace it with the value of `PORTAL_URL`.

**Step 3: card them.** Use the existing local hydrate, and do a dry run first:

```bash
cd ~/code/nuwrrrld-portal && node scripts/hydrate-local.mjs --dry-run --limit=5
```
```bash
cd ~/code/nuwrrrld-portal && node scripts/hydrate-local.mjs
```

**Step 4: verify.** Re-run Step 1 and expect `missing: 0`. Some symbols may
stay missing: thin or recently listed ETFs (for example `LUXE` or `FTXR`)
can fall under hydrate's bar minimum. That is a real litmus finding, not a
bug to hide. `prune-universe.mjs --dry-run` will classify them as `young` or
`never`.

### Order of work

1. ~~Register the 45 (above) and decide the ETF ownership question.~~ **Done
   2026-09-22** — Option 1, see above.
2. `pipeline_run_log` columns + `run-status.ts` + logging from
   `hydrate-universe`. This is the largest gap, because the busiest pipeline
   currently writes no run record.
3. `attempts[]` from the OpenRouter fallback functions, plus `lostTo` in the
   rollup and the model-usage report.
4. `pipeline-litmus.yml` with the Neon and gcp3 legs. Add the Firestore F1 leg
   when F1 ships.
5. The `/api/pipeline/run-ingest` route, so gcp3 and homebase, the two writers
   outside the portal, report their runs as well.

## Core features and AI across the three pipelines (added 2026-09-22)

The free-tier plan above deliberately keeps the 12 new data families
model-free. This section covers the other half: **OpenRouter is badly
under-used where it *is* supposed to run.** Paper portfolios have never made a
model call, the signal analysis in all three pipelines is 100% rule-based, and
none of the three pipelines writes about the stocks and ETFs with the
strongest signals.

### What OpenRouter actually served (Neon, read 2026-09-22)

| Surface | Designed AI budget | Actual in Neon | Gap |
|---|---|---|---|
| **Paper portfolios** (arbitration: VETO / DOWNSIZE / CONFIRM) | up to **36 calls/run, 108/day** (`MAX_MODEL_CALLS_PER_*_ALL_ACCOUNTS` in `lib/shared/paper-policy.ts`) | **0 runs, 0 orders, 0 model calls.** `paper_runs` and `paper_orders` are empty | 100%. See the gate bug below |
| `precompute-ai` (top-of-ranking narratives) | `THESIS_BATCH_SIZE = 10` per run | 12 runs since 2026-09-08, **31 AI items** (~2.6/run) | ~74% of the batch unused |
| `followed-tickers` / `-judge` | picks + judgement | 2 runs each, 0 + 4 AI items | last run 2026-09-11 |
| AI Council (interactive) | ~11 calls/session | 19 sessions total, last 2026-09-14 | user-driven, not a pipeline |
| `precomputed_ai` cache | narratives per ticker | **3 rows, all `portfolio_health_ai`** | no per-ticker narrative is cached |
| gcp3 content (`correlation_article`, `story_picker`, `daily_blog`, `ai_summary`, `blog_reviewer`) | 5 modules, every refresh | not in Neon; see note | its chain was entirely dead until 2026-09-10 (every call fell through to Mistral) |
| Modal (all apps) / homebase signals | none | none | zero-AI by design today |

Even at the no-credit tier of ~50 free requests/day, the pipelines use well
under half of it. With a one-time ≥$10 credit (~1,000/day), they use under 5%.

### Why paper portfolios have never run: the slot gate matches to the minute

`.github/workflows/paper-portfolios.yml`'s gate resolves a slot only when the
New York wall clock **equals** `09:00`, `12:30`, `15:45` or `16:30` exactly.
GitHub starts scheduled runs late, often by 30–90 minutes, so the clock never
matches. **All 38 scheduled runs on record (2026-09-15 → 2026-09-22) ended
`gate=success, run=skipped`.** An example log line from 2026-09-22 17:47 UTC:
`NY local time 13:47 matches no slot — off-season cron entry, skipping.`
The workflow is green every time, so nothing alerted.

The fix belongs in `/fixy`, not here. The likely shape: match a **window**
(slot start ≤ now < next slot start) instead of an exact minute, and let the
existing per-slot idempotency in the run route absorb the EST/EDT twin cron.
It also needs a guard so a green run that did nothing becomes visible. That is
the `status` column from Design 1: `expected = 8 accounts, filled = 0` →
`fail`.

Verify it, read-only (expect `run=skipped` on every row until it's fixed):

```bash
cd ~/code/nuwrrrld-portal
for id in $(gh run list --workflow paper-portfolios.yml -L 10 --json databaseId -q '.[].databaseId'); do
  gh run view "$id" --json createdAt,jobs -q '"\(.createdAt) " + ([.jobs[] | "\(.name|split(" ")[0])=\(.conclusion)"] | join(" "))'
done
```

### Core features across the pipelines, and where AI fits

| Core feature | gcp3 (GCP) | GHA / Modal (hydrate lane) | homebase (Modal) | AI today | AI in the future design |
|---|---|---|---|---|---|
| **Signal scoring** | 54 ETFs, return/rank engine | ~933 tickers, indicator confluence | scan list → Firestore `scans` | none (rule-based) | **stays rule-based.** AI never produces the number (see holdemfoldem below) |
| **Cross-pipeline signal analysis** | — | — | — | none. Nothing compares the three engines | **new: disagreement explainer.** When gcp3 and hydrate disagree on direction for the same symbol (the litmus-54 overlap), one model call explains *why* the engines split, grounded on both payloads |
| **Paper portfolios** | — | GHA scheduler → portal run route | — | arbitration designed, **never executed** | fix the gate first. Then arbitration uses its 108/day, and the settle slot gets one **CHAIR "trade journal" call per account** (8/day) explaining the day's fills |
| **Narratives** (`precompute-ai`) | its own `ai_summary` / `daily_blog` | GHA → portal route | — | ~2.6/run | fill the batch of 10. Ground each narrative on N3 calibration and N4 risk stats once they exist |
| **Strongest-signal articles** | `correlation_article` / `story_picker` write about *pairs of data sources*, not tickers | — | — | none per-ticker | **new.** See below |
| **Hold/Fold verdicts** | — | portal `holdfold_cache` | — | none | borrow holdemfoldem's opt-in AI commentary pattern |
| **Model health** | legacy chain (stale until 09-10) | `FREE_MODEL_CHAIN`, refreshed weekly | — | invisible when degraded | Design 2 `attempts[]` in **both** repos, so gcp3's chain can't rot silently again |

### What makes holdemfoldem more robust, and what to borrow

holdemfoldemapp does more per ticker, and it degrades more honestly:

1. **Depth per ticker.** 150+ signals, plus a risk-sized trade plan
   (entry/stop/target, R/R), Fibonacci confluence zones and options Greeks
   and payoff, all run in parallel into one `HoldFoldVerdict`. The portal's
   card has about 8 indicator families and a confluence score.
2. **Rule-based floor, AI on top.** `RuleBasedRanking` always produces the
   verdict. AI ranking is opt-in behind a circuit breaker, and any failure
   falls through to the rule result (holdfold wiki,
   `decision-rule-based-ranking-fallback`). The portal should adopt this as an
   explicit rule for every new AI feature here: **AI explains or arbitrates a
   rule-based number, and never replaces it.** Paper arbitration already
   follows this (malformed output = CONFIRM).
3. **Degradation is carried in the payload.** Its LLM renderer always
   propagates `degraded`, `warnings` and `suppressions`, so a model reading a
   verdict knows when the data underneath was thin. Portal prompts should
   carry the card's `data_quality` and the run's `status` the same way.
4. **Commentary after the verdict, on demand.** The AI Council comments only
   after the verdict resolves, with the strongest supporting evidence and the
   biggest counter-argument, triggered by a button rather than every render.
   That prompt shape (evidence + counter-argument, ~150 words) is the right
   template for the articles below.

**Borrow first:** the trade plan (stop/target from ATR) and the
evidence/counter-argument prompt. Both are cheap. The trade plan is pure math
on bars the hydrate lane already fetches. **Borrow later:** options and
Fibonacci, which need new vendor data.

### New feature: daily articles on the strongest-signal stocks and ETFs

**Goal:** one short article a day for each of the top N tickers by signal
strength, readable on web and mobile. Each article says what the signals
show, why the setup is strong, and what would break it.

**Selection is rule-based, no model involved.** Rank the day's cards by
`|confluence score|` in both directions, then keep a ticker only if:
- `data_quality` passes the same gate paper portfolios use (`0.8`),
- both horizons agree on direction, and
- for the 9 symbols in both engines (54 after the ETF registration), gcp3's
  engine agrees too. Two independent engines agreeing is the strongest
  signal this system can produce.

Take the **top 5 bullish + top 5 bearish stocks and the top 3 + 3 ETFs**: 16
articles/day. Once N3 calibration exists, rank by *calibrated* hit rate for
the card's `state_key` rather than raw score, so "strongest" means "has
worked most often historically", not just "most extreme".

**Generation:** one OpenRouter call per article through
`fetchWithModelFallbackChecked`, on the CHAIR model (largest free model), with
a grounded prompt built only from the card, N4 risk stats, the trade plan and
calibration. It uses the holdemfoldem evidence + counter-argument shape and
has a hard rule to cite only numbers present in the payload. A
post-generation check rejects any article that quotes a number not in the
payload, the same way the council grounding check works. That makes 16 calls a
day, well inside even the no-credit tier.

**Where it runs and lands** (following the invariants above):

| Step | Where |
|---|---|
| Trigger | GHA, a new step at the end of `hydrate-universe.yml` (or its own workflow ~30 min after), calling a new portal route `POST /api/pipeline/signal-articles` |
| Model call | inside the portal route only, never in GHA/Modal directly |
| System of record | Neon `precomputed_ai` with `kind = 'signal_article'`, `subject = <ticker>`. It reuses the existing table and TTL, so no new table is needed |
| Mobile read | Firestore `articles/{date}` (one doc holding all 16 summaries, for the list screen) + `articles/{date}/items/{symbol}` (full text), mirrored non-fatally after the Neon commit. About 17 writes/day |
| Run record | `pipeline_run_log`, `pipeline = 'signal-articles'`, expected = 16, with `attempts[]` from Design 2 |
| Compliance | every article carries the existing disclaimer. It reads as analysis ("the signals show"), never as advice ("buy") |

gcp3's `correlation_article.py` / `story_picker.py` already solve article
generation from signal data on the ETF side. Reuse their prompt structure,
but keep **one writer per store**: gcp3 keeps its pair-stories in
`gcp3_cache`, and the portal owns per-ticker articles.

### AI budget per day, once all of the above ships

| Consumer | Calls/day | Notes |
|---|---|---|
| Paper arbitration | ≤ 108 | ceiling. Actual depends on how many trades are close calls |
| Paper trade journal (settle) | 8 | one per account |
| `precompute-ai` narratives | 10 | fill the existing batch |
| Strongest-signal articles | 16 | |
| Engine disagreement explainer | ≤ 10 | only symbols where gcp3 and hydrate disagree |
| gcp3 content modules | ~5–10 | unchanged |
| **Total** | **~160** | above the ~50/day no-credit tier, **~16% of the ~1,000/day tier** |

**This is the one place the $0 plan needs a decision.** Either buy the
one-time ≥$10 OpenRouter credit (it raises the daily free-model limit; the
models stay `:free`), or stay at ~50/day and prioritise articles (16) +
narratives (10) + trade journal (8), capping arbitration at the remaining ~15.

🖱 **Dashboard:** current credit balance and whether the 1,000/day tier is active:
https://openrouter.ai/settings/credits

### Order of work

1. **Fix the paper-portfolios slot gate** (via `/fixy`). Nothing else in this
   section matters for paper portfolios until a run actually executes.
2. **Make the OpenRouter credit decision** (budget table above).
3. **Strongest-signal articles**: selection function (pure, unit-tested in
   `lib/shared/`), route, Neon `precomputed_ai` row, Firestore mirror, GHA
   step.
4. **Port the trade plan** (ATR stop/target) into the hydrate lane's card
   numerics, then feed it to articles and narratives.
5. **Engine disagreement explainer**, after the 45 ETFs are registered and
   `pipeline-litmus.yml` exists (it produces the disagreement list).
6. **Design 2 `attempts[]` in gcp3's `llm/legacy_client.py`**, so its chain
   reports the same way the portal's does.

## See also

- `docs/pipeline-atlas.html` — interactive Today/Future diagram of all three
  pipelines, the 54-ETF grid, run states and the model-fallback simulator
  (also published as a private Artifact)

- `docs/modal-deployment-and-local-triggering.md` — full deploy/local-trigger
  mechanics, secret variables per app, `modal run` invocation shapes,
  environment setup (this machine uses the `modal1` mamba env)
- `docs/deploy-runner-decision.md` — the three Finding write-ups (double-fire
  conflicts and the deliberate `free-model-refresh` redundancy)
- `docs/manual-setup-todo.md` §5e — the still-open action items
- `docs/wiki-portal/incident-2026-08-18-modal-under-recommended.md` — origin
  of the "never actually deployed" finding this file re-verifies
- `docs/wiki-portal/concept-signal-engine-host-parity.md` — how the Modal
  stock lane relates to gcp3's ETF lane
