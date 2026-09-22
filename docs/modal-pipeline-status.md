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

## See also

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
