# Signal + AI Pipeline — TODO and Blockers

Written 2026-08-18, after running the coverage pipeline end-to-end against
live `gcp3` data and a disposable Neon branch. This is a status/blockers doc,
not a design doc — see `docs/max-coverage-simplest-path.md` and
`docs/modal-vs-gcp-signal-coverage.md` for the design and its reasoning.

## What the run actually proved

Ran `gcp3 /signals` → `buildCard()` → `upsertCards()` → `topCards()` against a
disposable Neon branch (`br-sweet-fire-…`, since deleted). Real output, not a
projection:

| Step | Result |
|---|---|
| Fetch live ETF signals | 54 symbols, bar date `2026-08-18` |
| Build token cards | 108 cards (54 tickers × 2 horizons) |
| Model calls to build them | **0** |
| Write to `ticker_cards` | 108 written, 0 skipped, 0 failed |
| Coverage | **54/54 = 100%** of the (currently ETF-only) active universe |
| Top-ranked (t1) | 8-way tie at score 50, `BUY` — `JETS, VHT, KIE, IGV, PAVE, BOAT, XRT, SOXX` |
| Bottom-ranked (t1) | `PBJ` at −50, `SELL`; `XLU`/`SOCL` at −30, `HOLD` |
| `topCards()` (explain-eligible ranking) | **empty** — see Blocker 1 |

The coverage and cost claims in the design docs are real, not aspirational —
this run is the evidence.

---

## Blockers, in priority order

### 1. Every ETF card fails the explain-quality gate — 0/54, not a bug, but unresolved

`isExplainable()` requires `dataQuality >= 0.8` and zero `missingFields`. gcp3's
ETF payload (`ai_action`, `confluence_score`) only fills **1 of the 5** taxonomy
inputs (`confluenceScore`) — `rsi`, `macdCross`, `adx`, `volatilityPercentile`
are never in scope for gcp3's ETF scoring model at all. Every card lands at
`dataQuality: 0.20`.

**Consequence:** `topCards()` — the query the top-N AI explain batch would read
from — returns **empty** for the entire ETF universe, today, permanently, until
one of the two paths below ships. This is not a hypothetical gap; it's what the
live run just showed.

**Two ways to close it, not yet decided:**
- **(a)** Extend gcp3 to compute RSI/MACD/ADX/volatility for its 54 ETFs too
  (it already has `features_rsi.py` etc., just not wired into the ETF path).
- **(b)** Ship the Modal stock lane and accept that ETF cards stay
  low-quality/coverage-only forever — real coverage, but never explainable.

**Owner:** unassigned. **Blocks:** any real top-N AI narrative from running
before this is picked.

---

### 2. `ticker_universe` has no stock tickers yet — `seed-universe.mjs` has never been run for real

`scripts/seed-universe.mjs` is built and dry-run verified (518 tickers parsed
live from Wikipedia: 503 S&P 500 + 102 Nasdaq-100, deduplicated). It has
**never been run against the real production database** — only against a
disposable branch for schema verification, and in `--dry-run` mode.

**Blocks:** `deploy/universe-hydration/modal_app.py`'s `_load_universe()` will
return an empty list on its very first real run and fail immediately with "no
active tickers to hydrate."

**Fix:** `PORTAL_PUSH_SECRET=<real> node scripts/seed-universe.mjs` once,
against production. Five minutes, no code change. **Do this before deploying
Modal**, or the first scheduled run fails loudly on an empty universe (which is
the correct failure mode, just wasted a cron cycle to discover).

---

### 3. `PORTAL_PUSH_SECRET` is not set in local `.env.local`

Checked directly: `.env.local` has `DATABASE_URL`, `MCP_BACKEND_URL`,
`OPENROUTER_API_KEY` — no `PORTAL_PUSH_SECRET`. Every pipeline route
(`hydrate-universe` GET/POST/PUT, `precompute-ai`) hard-fails with `503
CONFIG_ERROR` until it's set.

**Blocks:** running any pipeline script (`seed-etf-cards.mjs`,
`seed-universe.mjs`) against local dev, or the local dev server acting as a
target for a local Modal smoke test.

**Fix:** generate a secret, add to `.env.local` for dev and to the real secret
store (Vercel env vars + `modal secret create nuwrrrld-hydration` +
`modal secret create nuwrrrld-precompute`) for production/Modal. This is a
credential-provisioning task — see `secrets-sync` skill rather than hand-rolling
it.

---

### 4. Alpaca credentials never provisioned — the Modal stock lane cannot run at all

`deploy/universe-hydration/modal_app.py` requires `ALPACA_API_KEY` and
`ALPACA_API_SECRET` in the `nuwrrrld-hydration` Modal secret. Neither exists
anywhere in this repo's env files or, as far as this session can tell, in any
Modal secret store. No Alpaca account has been confirmed to exist for this
project.

**Blocks:** the entire stock-universe lane (the ~4,300-ticker part of "4,300
tickers today"). Without this, **only the 54 ETFs from gcp3 are actually
carded** — everything else in `max-coverage-simplest-path.md` about full-
universe coverage is still design, not running code, until this exists.

**Fix:** create/confirm an Alpaca account (free tier covers this — no daily
cap on the bars endpoint used here), generate API keys,
`modal secret create nuwrrrld-hydration ALPACA_API_KEY=... ALPACA_API_SECRET=... PORTAL_PUSH_SECRET=... PORTAL_URL=...`,
then `modal deploy deploy/universe-hydration/modal_app.py`.

---

### 5. Modal app never deployed — `modal deploy` has not been run

Neither `deploy/universe-hydration/modal_app.py` nor the existing
`deploy/precompute-ai/modal_app.py` has confirmed live-deployment status
checked this session. `modal token new` / account setup status: unknown.

**Blocks:** the 00:05 UTC nightly hydration cron does not exist until this
runs. Everything upstream (code, tests, schema) is ready; this is the actual
"turn it on" step.

**Depends on:** Blocker 4 (needs the secret to exist first).

---

### 6. Two schedulers already race on the *existing* precompute job — unresolved from the design doc

Both `.github/workflows/precompute-ai.yml` and `deploy/precompute-ai/modal_app.py`
fire `10 0 * * *` at the same `/api/pipeline/precompute-ai` endpoint. Neither
has been disabled. This predates today's work but compounds it: once the
hydration lane feeds real cards, whichever of the two precompute jobs runs
survives; the other silently double-spends the day's OpenRouter quota for
identical output.

**Fix:** pick one (GHA is simpler per the workflow's own comment — no extra
account, secrets already present) and disable/delete the other's schedule.

**Owner:** unassigned. Not new, but now higher-priority — Blocker 4/5 landing
without this fixed makes the double-spend real instead of theoretical.

---

### 7. The "50/day" OpenRouter quota figure is still wrong in two files

Retracted in `max-coverage-simplest-path.md` on 2026-08-18, but the retraction
never reached the two files that assert it as fact:
`deploy/precompute-ai/modal_app.py`'s docstring and
`.github/workflows/precompute-ai.yml`'s header comment both still say "caps the
whole API key at 50 requests/day."

**Fix:** `curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/auth/key`
— five seconds — then correct both comments to the real number.

**Blocks:** nothing functionally (the code doesn't branch on the literal "50"),
but it misleads whoever tunes `MAX_SUBJECTS` / batch sizing next.

---

### 8. `signal-lookup.ts`'s 200-with-error blindness — not yet fixed

From `docs/modal-vs-gcp-signal-coverage.md` Part 2: `fetchTickerEntryLive()`
still collapses "gcp3 down", "timed out", and "ticker out of scope (200 +
`{"error":"not found"}`)" into the same `null`. Confirmed still present —
untouched by this session's work, since it was scoped to the coverage
pipeline, not the existing lookup path.

**Fix:** the `LiveFetchResult` discriminated union described in that doc,
Part 5 Lane A. Still the single highest-clarity-per-effort item outstanding.

**Blocks:** accurate `/api/health` reporting and UI messaging; does not block
the coverage pipeline itself, which is a separate code path.

---

## What's NOT blocked — ready to run today

- **`scripts/seed-etf-cards.mjs`** — needs only `PORTAL_PUSH_SECRET` (Blocker 3)
  pointed at a real deployment. Confirmed working against live gcp3 data this
  session; 100% of the 54-ETF universe cards successfully.
- **Card scoring, upsert, ranking, coverage reporting** — all exercised against
  real Postgres this session (`buildCard`, `upsertCards`, `topCards`,
  `coverageForDate`). No known defects.
- **The Tier-0 grounding join** — schema and query verified; empty today only
  because `grounding_pack`/`corpus_chunks` have no compiled rows yet on the
  branch tested (separate from this pipeline — see
  `compile-grounding-pack.yml`).

---

## Suggested unblock order

1. Blocker 3 (`PORTAL_PUSH_SECRET`) — nothing else runs without it.
2. Blocker 2 (`seed-universe.mjs` for real) — cheap, no dependencies once #3 is done.
3. Blocker 7 (fix the "50/day" comments) — five seconds, do it opportunistically.
4. Blocker 6 (pick one precompute scheduler) — cheap, prevents a real double-spend.
5. Blocker 4 (Alpaca credentials) — the real provisioning step.
6. Blocker 5 (`modal deploy`) — mechanical once #4 is done.
7. Blocker 1 (ETF explain-quality gap) — needs a decision (gcp3 extension vs.
   accept ETF-as-coverage-only), not just credentials. Discuss before building.
8. Blocker 8 (`signal-lookup.ts` blindness) — independent of the rest; do
   whenever convenient.

## See also

- `docs/max-coverage-simplest-path.md` — the original design
- `docs/modal-vs-gcp-signal-coverage.md` — the GCP-vs-Modal analysis and Lane A/B/C plan
- `lib/shared/card-policy.ts`, `lib/ticker-cards-db.ts` — the code this run exercised
- `deploy/universe-hydration/modal_app.py` — blocked on 4 and 5
- `scripts/seed-universe.mjs`, `scripts/seed-etf-cards.mjs` — blocked on 3 (universe seed also needs a real run, Blocker 2)
