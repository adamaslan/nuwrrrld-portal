Created: 2026-07-09
Updated: 2026-07-09 (added Workstream 0 signals-app↔portal wiring, Workstream 4 neon dark mode)
Scope: nuwrrrld-portal (10x AI council + real DB + neon dark UI) and gcp3/backend (local runnability)
Related: signal-multiplication-analysis.md, roadmap-1month.md (launch blockers), legal-todo.md

# NuWrrrld Portal: 10x AI Council + Database, Neon Dark UI, and a Locally-Runnable Backend

Five workstreams, ordered by dependency: **the signals-app connection does not exist
yet** and gates the council's real grounding (WS0); the DB unblocks the council's
persistence/memory/track record (WS1); the local backend unblocks cheap iteration
(WS3); the frontend restyle (WS4) is independent and can land any time.

## ⚠️ Reality check: signals-app and the portal are not connected

An earlier draft of this doc assumed the council could ground itself on
`signals-app`'s `/backtest` hit-rates. **That wire does not exist.** Verified in code
2026-07-09:

- **The portal has zero client for signals-app.** Every data path in the portal
  (`lib/digest-cache.ts`, `app/**/page.tsx`, `app/api/**`) points at
  `MCP_BACKEND_URL` → the **gcp3** Cloud Run backend
  (`gcp3-backend-...run.app`). Nothing references signals-app, port 8000, or a
  `SIGNALS_APP_URL`.
- **signals-app's API is not deployed anywhere.** No Dockerfile, no fly/railway/
  render config — its only GitHub workflow (`deploy-pages.yml`) ships the `web/**`
  *frontend* to GitHub Pages. The FastAPI service (`/signals/{symbol}`, `/backtest/
  {symbol}`, `/history/{symbol}`) runs **only on `localhost:8000`**.
- **Its API has no auth and `allow_origins=["*"]`.** `/backtest` does a live yfinance
  fetch + full historical scan per call — exposing it publicly unauthenticated is a
  DoS + upstream-rate-limit vector.

So connecting them **is** a substantial change — it's Workstream 0 below, and every
council-grounding feature (2.3, 2.5) depends on it. Until WS0 lands, the council can
still ground on **gcp3's** data (which the portal already reaches), just not on
signals-app's backtest hit-rates.

---

## Where things stand today (verified in code, 2026-07-09)

### Council — 2 seats, single-shot, amnesiac
- `app/api/council/route.ts` + `lib/openrouter.ts`: two seats — **T1** (short-term
  trader, `cohere/command-r7b`) and **T2** (long-term investor, `qwen3-next-80b:free`),
  with a 3-model free-tier fallback chain (`FREE_MODEL_CHAIN`) on 429/5xx.
- Each call is one prompt → one seat → one answer. **No cross-seat debate, no
  synthesis, no memory of prior answers, no persistence** — the "Go Deeper" answer in
  `SignalsClient.tsx` evaporates on page refresh.
- Called from 3 surfaces: landing page sample, signals dashboard ("Go Deeper"),
  HoldFold client.
- Grounding is whatever the caller stuffs into the prompt string (`buildSignalPrompt`).
  The council cannot fetch its own data.

### Database — Neon exists, barely used
- `lib/db.ts`: Neon serverless client, `DATABASE_URL` already set in `.env.local`. ✓
- **One table**: `signal_digest_cache` (via `lib/digest-cache-db.ts`), and even that is
  a secondary path — the live code (`lib/digest-cache.ts`, council, per-user caches)
  runs on **module-level in-memory Maps**, which reset on every serverless cold start
  and don't share state across instances. This is the #1 item on the launch-blockers
  list (in-memory persistence = data loss).

### Backend local — pipeline yes, API no
- `gcp3/backend/README_LOCAL_PIPELINE.md` covers running the *batch pipeline scripts*
  locally (with Firebase sync).
- The **FastAPI service itself** cannot run locally without GCP: `firestore.py` does
  `firestore.Client(project=os.environ["GCP_PROJECT_ID"])` unconditionally — every
  cached endpoint (`/signals`, `/market-overview`, …) dies without Firestore access.
- `main.py` has no `if __name__ == "__main__"` / uvicorn entry; only the Dockerfile
  knows how to start it.

---

## Workstream 0 — Connect signals-app to the portal (the missing wire)

This is the "massive change." It's really three smaller ones: **deploy** signals-app's
API, **secure** it, and **build a portal client** for it. None is huge alone; the size
is that there's currently *nothing* between the two repos.

### 0.1 Deploy the signals-app API (it has no backend deploy today)
signals-app already runs cleanly under `uvicorn` locally (`scripts/run_local.sh`,
port 8000) with 51 passing tests. What's missing is a container + host.

- **Dockerfile** (`signals-app/Dockerfile`): python:3.12-slim, `pip install .`,
  `uvicorn signals_app.api.main:app --host 0.0.0.0 --port $PORT`. Model it on
  gcp3/backend's existing Dockerfile.
- **Host**: same pattern as gcp3 (Cloud Run) is the path of least resistance — one
  more service in the same project, scale-to-zero so idle cost is ~$0. Fly.io/Railway
  are fine alternatives. Persist the calibration file (`calibration/
  strength_hit_rates.json`) and, if used, the SQLite run-history DB on a mounted
  volume or object store, or accept they reset on redeploy (both are regenerable).
- **CI**: add a `deploy-api.yml` alongside the existing Pages workflow.

### 0.2 Secure it before it's public
`/backtest` is expensive (live fetch + full historical scan). Do not expose it
unauthenticated.

- Add a shared-secret gate (`SIGNALS_APP_API_KEY`) checked in a FastAPI dependency —
  same trust model the portal already uses for `PORTAL_PUSH_SECRET`. Server-to-server
  only; never shipped to the browser.
- Tighten `allow_origins` from `["*"]` to the portal origin(s).
- Rate-limit `/backtest` per key (it's the DoS-shaped one). A precomputed nightly
  calibration/backtest cache (WS0.4) means live `/backtest` calls should be rare.

### 0.3 Portal client (`lib/signals-app.ts`)
Mirror the existing `MCP_URL` pattern exactly, new env var so the two backends stay
distinct:

```ts
const SIGNALS_APP_URL = process.env.SIGNALS_APP_URL; // e.g. https://signals-app-...run.app
const SIGNALS_APP_KEY = process.env.SIGNALS_APP_API_KEY;

export async function getBacktest(ticker: string): Promise<BacktestResult | null> {
  if (!SIGNALS_APP_URL) return null;              // feature-flag off ⇒ graceful no-op
  // fetch `${SIGNALS_APP_URL}/backtest/${ticker}` with Bearer key, 8s timeout,
  // try/catch → null on any failure (same degradation contract as getOrFetchDigest).
}
```

Typed to the `/backtest` response shape (`bars_scanned`, `by_category[]`,
`by_strength[]` — each `{key, hits, total, hit_rate}`). Because it returns `null` on
absence/failure, the council-grounding code (2.3) treats "no signals-app" identically
to "signals-app down" — the feature is additive and can ship dark.

### 0.4 Nightly precompute (avoids the DoS shape entirely)
signals-app already has `scripts/calibrate.py`. Schedule it (cron/Cloud Scheduler) to
write hit-rate tables per tracked ticker into **the portal's Neon DB** (WS1) — a
`backtest_hit_rates` table. Then the council reads hit-rates from Postgres (fast,
already-connected) and live `/backtest` calls become the rare drill-down, not the hot
path. This is the recommended integration: **signals-app writes to Neon nightly; the
portal reads Neon.** It sidesteps deploying/securing a hot public API for the common
case, and folds cleanly into WS1's schema.

> Decision to make: **push (0.4, signals-app → Neon nightly)** vs. **pull (0.3, portal
> → signals-app live)**. Recommendation: do 0.4 as the default data path and keep 0.3
> as the on-demand drill-down. 0.4 alone may let you defer the full public deploy
> (0.1/0.2) if a scheduled job with Neon write access is enough.

---

## Workstream 1 — Database first (everything else leans on it)

Neon is already provisioned and wired; this is schema + migration work, not infra work.

### 1.1 Schema (one migration file, `lib/db/schema.sql`)

```sql
-- Council: every exchange persisted (track record + user history + eval data)
CREATE TABLE council_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,              -- Clerk userId
  topic       text NOT NULL,              -- e.g. ticker or free-form question
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE council_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES council_sessions(id),
  seat        text NOT NULL,              -- T1 | T2 | RISK | MACRO | QUANT | CHAIR
  round       int  NOT NULL DEFAULT 1,    -- debate round number
  role        text NOT NULL,              -- 'answer' | 'critique' | 'synthesis'
  model       text NOT NULL,              -- which model actually served it
  content     text NOT NULL,
  latency_ms  int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Council verdicts: the structured output worth backtesting later
CREATE TABLE council_verdicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES council_sessions(id),
  ticker      text,
  direction   text,                       -- bullish | bearish | neutral
  confidence  text,                       -- low | medium | high
  horizon     text,                       -- e.g. '1-5d', '6-12m'
  invalidation text,                      -- the level/condition that voids the call
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Replace in-memory caches (launch blocker)
CREATE TABLE user_digest_cache (
  user_id     text PRIMARY KEY,
  payload     jsonb NOT NULL,
  expires_at  timestamptz NOT NULL
);
-- signal_digest_cache already exists; keep as the global-cache table.

-- Signals-app backtest hit-rates, written nightly by scripts/calibrate.py (WS0.4).
-- The council reads THIS instead of calling signals-app /backtest live.
CREATE TABLE backtest_hit_rates (
  ticker       text NOT NULL,
  bucket_kind  text NOT NULL,            -- 'category' | 'strength'
  bucket_key   text NOT NULL,            -- e.g. 'MA_CROSS' | 'STRONG BULLISH'
  hits         int  NOT NULL,
  total        int  NOT NULL,
  hit_rate     real NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, bucket_kind, bucket_key)
);

CREATE INDEX ON council_sessions (user_id, created_at DESC);
CREATE INDEX ON council_messages (session_id, round);
CREATE INDEX ON council_verdicts (ticker, created_at DESC);
```

### 1.2 Migrate the in-memory Maps to Neon
- `lib/digest-cache.ts` `userCache` Map → `user_digest_cache` table (read-through,
  keep the Map as an L1 within a single warm instance — cheap and correct).
- `globalDigestCache` object → back it with `signal_digest_cache` (the
  `digest-cache-db.ts` functions already exist; make them the primary path, memory
  the L1).
- Council "Go Deeper" results → written to `council_sessions`/`council_messages` so
  they survive refresh and build the track record.

### 1.3 Why this ordering matters
The council's 10x features (memory, track record, verdict backtesting against the
signals engine's realized outcomes) are all *reads over these tables*. Ship the
schema first and every council improvement lands with persistence for free.

---

## Workstream 2 — 10x the AI Council

"10x" = from *one model answering a prompt* to *a persistent, grounded, multi-seat
deliberation with a measurable track record*. Six upgrades, roughly in build order:

### 2.1 More seats, real roles (cheap — prompt + config only)
Extend `CouncilSeat` and `SEAT_MODELS`/`SEAT_SYSTEM` in `lib/openrouter.ts`:

| Seat | Role | Horizon | Model (free-chain fallback for all) |
|---|---|---|---|
| T1 | Short-term trader (exists) | 1–60d | cohere/command-r7b |
| T2 | Long-term investor (exists) | 2m–5y | qwen3-next-80b:free |
| RISK | Devil's advocate — argues *against* the trade, sizes the downside | any | llama-3.3-70b:free |
| MACRO | Rates/dollar/sector-rotation context | any | qwen3-next-80b:free |
| QUANT | Interprets the signals-engine data only (score, hit-rates, confluence) — no narrative | any | mistral-7b:free |
| CHAIR | Reads all seats, issues the synthesis + structured verdict | — | strongest free model available |

### 2.2 Debate protocol (the actual 10x)
New route `POST /api/council/deliberate` orchestrating:

1. **Round 1 — independent answers.** T1, T2, RISK, MACRO, QUANT answer the same
   grounded brief *in parallel* (`Promise.all` — latency stays ~1 round-trip).
2. **Round 2 — critique.** Each seat gets the other seats' round-1 answers and must
   state where it disagrees and what evidence would change its mind. (Cap at 1
   critique round; more rounds cost tokens for diminishing returns on free models.)
3. **Synthesis.** CHAIR receives all rounds and emits: consensus/split, a structured
   verdict (direction, confidence, horizon, invalidation) → `council_verdicts`, and
   a ~200-word rationale.

Every message persisted to `council_messages` as it streams. Client shows seats
filling in live (SSE or polling the session).

Degradation: if a seat's model chain is exhausted, CHAIR notes the empty seat and
proceeds — mirror of the signals engine's per-detector isolation.

### 2.3 Grounding — feed the council real data, not prompt strings
Before round 1, the route assembles a **data brief** server-side:
- gcp3 `/signals?symbol=X` → confluence score, per-indicator reasons, engine_version.
  *Already reachable today* via `MCP_BACKEND_URL`.
- **backtest hit-rates by category/strength** → the council can say "MA_CROSS signals
  on this setup hit 58% historically." **Requires WS0.** Read from the
  `backtest_hit_rates` Neon table (WS0.4 push path), falling back to a live
  `lib/signals-app.ts::getBacktest()` call (WS0.3) if the table is empty for that
  ticker. If WS0 hasn't shipped, this brief line is simply omitted — the council
  degrades to gcp3-only grounding, no error.
- `council_verdicts` history for the ticker → "the council was bullish here on
  2026-06-12 and was wrong; invalidation was hit"

The QUANT seat consumes *only* this brief; the others get brief + question. This is
what makes answers auditable instead of vibes.

### 2.4 Memory
- Per-user: last N session summaries injected for continuity ("you asked about NVDA
  last week; the thesis was X").
- Per-ticker: the verdict history from 2.3 — the council confronting its own record
  is the single biggest trust feature.

### 2.5 Track record surface (product payoff)
`/dashboard/council` page: past verdicts joined against realized outcomes (reuse the
backtest engine's forward-return logic — a verdict is bullish/bearish + horizon, same
hit/miss scoring as `backtests/engine.py`). "Council HIGH-confidence calls: 64% hit
rate over 90 days, n=41." This is the same pillar-3 move that 10x'd the signals side.

### 2.6 Cost control (stay on free tier)
- Deliberation = ~11 model calls (5 + 5 + 1). Free-chain models only; keep per-seat
  `max_tokens` ≤ 500.
- Per-user daily deliberation quota in Neon (e.g. 5/day free tier, 25/day pro) —
  entitlement check already exists (`nu_ai`).
- Cache deliberations by (ticker, day) — a second user asking about AAPL the same
  day gets the persisted session, not 11 new calls.

---

## Workstream 3 — gcp3 backend runs locally

Goal: `uvicorn main:app` on a laptop with **no GCP project, no Firestore, no service
account** — real market data, local persistence.

### 3.1 Cache backend abstraction (the main dependency — but not the only one)
Most Firestore traffic goes through `get_cache`/`set_cache` (plus variants
`get_cache_stale`, `get_cache_stale_prev`, `delete_cache`) in `firestore.py` — those
get a backend switch. **However, a grep shows ~4 modules also import the raw `db`
client directly, and there are `read_checkpoint`/`write_checkpoint` and
`read_agent_document`/`write_agent_document` helpers** (feature_store, etf_store,
firebase_sync lineage). Local scope decision: abstract the cache functions +
checkpoint/agent-document helpers (they're still just key→JSON blobs, same sqlite
table works); endpoints that need the raw `db` client return a clear
`feature_unavailable` in sqlite mode rather than crashing. `/signals` and
`/market-overview` — the two the portal/mobile actually consume — are cache-function
paths and work fully local.

Introduce the backend switch:

```python
# cache_backend.py
CACHE_BACKEND = os.getenv("CACHE_BACKEND", "firestore")  # firestore | sqlite | memory

# sqlite backend: single file ./local_cache.db, table cache(key TEXT PRIMARY KEY,
# payload TEXT, expires_at REAL). ~40 lines, stdlib sqlite3, no new deps.
```

- `firestore` (default, prod): unchanged behavior.
- `sqlite` (local dev): persistent across restarts, zero setup.
- `memory`: dict — for tests.

Import sites keep calling `get_cache`/`set_cache` etc.; only the module resolving
them changes. The raw-`db` importers (~4 modules) are the tail — handled by the
`feature_unavailable` degradation above, converted properly only if local dev
actually needs them.

### 3.2 Entry point + env
- Add to `main.py`:
  ```python
  if __name__ == "__main__":
      import uvicorn
      uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", 8080)), reload=True)
  ```
- `.env.local.example` documenting the minimal local set: `CACHE_BACKEND=sqlite`,
  the market-data keys (finnhub etc. — already in homebase/.env), and explicitly
  *not* `GCP_PROJECT_ID`.
- Guard any remaining `os.environ["GCP_PROJECT_ID"]` with the backend check so the
  KeyError can't fire in sqlite mode.

### 3.3 Local runner + portal wiring
- `backend/run_local.sh`: mamba env check → `CACHE_BACKEND=sqlite python main.py`.
- Portal already reads `MCP_BACKEND_URL` (with a hardcoded Cloud Run fallback):
  `MCP_BACKEND_URL=http://localhost:8080` in `.env.local` and the whole portal
  develops against the local backend. Same for mobile via `EXPO_PUBLIC_GCP3_URL`.
- Extend `README_LOCAL_PIPELINE.md` with a "Run the API locally" section.

### 3.4 Payoff loop
Local backend + Neon dev branch (Neon branching is free) = the council's grounding
calls (2.3) can be developed end-to-end offline-ish, without burning Cloud Run
invocations or risking prod Firestore writes.

---

## Workstream 4 — 10x the frontend: permanent neon dark mode (accessible)

Goal: the app is **always dark** — deep near-black canvas with **neon-blue and
neon-red flares** — and stays **WCAG AA accessible**. Independent of WS0–3; can land
any time.

### 4.0 Current state (verified)
- Plain CSS custom properties in `app/globals.css` (`--background`, `--foreground`),
  **no Tailwind**. Dark is currently *opt-in via `prefers-color-scheme: dark`* only —
  a light-mode user sees white.
- Several per-page stylesheets hardcode light colors (`app/landing.css`,
  `legal.css`, `dashboard/signals/signals.css` uses `#fff`/`#111`/`#222`, etc.).
  These are the audit surface — a token swap in `globals.css` won't reach hardcoded
  hexes.

### 4.1 Token system (single source of truth in `globals.css`)
Delete the light `:root` + `prefers-color-scheme` branches. Hard-set one dark theme:

```css
:root {
  color-scheme: dark;                 /* native form controls/scrollbars go dark */
  --bg:        #06070d;               /* near-black, slight blue cast */
  --surface:   #0d1018;               /* cards */
  --surface-2: #141926;               /* raised */
  --text:      #e8ecf4;               /* AA on --bg (contrast ≈ 15:1) */
  --text-dim:  #9aa4bd;               /* AA for secondary (contrast ≈ 6:1) */
  --border:    #212a3d;

  /* Neon accents — flares, not body text */
  --neon-blue: #2fd8ff;
  --neon-red:  #ff3b5c;
  --bull: var(--neon-blue);           /* reuse for direction (see 4.3 on color-blind) */
  --bear: var(--neon-red);

  --glow-blue: 0 0 12px rgba(47,216,255,.55), 0 0 32px rgba(47,216,255,.25);
  --glow-red:  0 0 12px rgba(255,59,92,.55),  0 0 32px rgba(255,59,92,.25);
}
```

Then convert the hardcoded per-page hexes (`signals.css`, `landing.css`, `legal.css`,
`page.module.css`) to these tokens — mechanical but required, or the neon look stops
at page boundaries.

### 4.2 The "flares" (the signature look, done cheaply)
- **Ambient background flares**: 1–2 fixed, blurred radial gradients (one blue, one
  red) behind content — `body::before`/`::after`, `filter: blur(120px)`,
  low opacity, `pointer-events:none`. Costs nothing, reads as "neon haze."
- **Accent glow on emphasis only**: `box-shadow: var(--glow-blue)` on primary CTAs,
  active nav, bullish/bearish signal chips, live council seats. **Restraint is the
  design** — glow everything and it reads as noise, not neon.
- Bull/bear already map to blue/red conceptually; wire signal direction to
  `--bull`/`--bear` so the data viz *is* the palette.

### 4.3 Accessibility is a hard requirement, not a nice-to-have
Neon-on-black is a classic a11y trap. Guardrails baked into the tokens above:

1. **Contrast**: body text uses `--text`/`--text-dim` (both ≥ AA on `--bg`), **not**
   neon. Neon is for glow/borders/large non-text accents. Never neon-red body copy on
   black (fails AA badly). Verify every text/bg pair ≥ 4.5:1 (≥ 3:1 for large text).
2. **Don't encode meaning in hue alone** (blue=up/red=down excludes red-green *and*
   the ~point where blue/red desaturate similarly): pair every directional color with
   an **arrow/icon + text label** (↑ bullish / ↓ bearish). The signal cards already do
   this — keep it.
3. **`prefers-reduced-motion`**: any flicker/pulse/animated glow must reduce to a
   static shadow. Wrap glow *animations* (not the static shadow) in
   `@media (prefers-reduced-motion: no-preference)`.
4. **Focus visibility**: focus rings must clear the glow — use a solid
   `outline: 2px solid var(--neon-blue)` with `outline-offset`, never rely on the
   blurred shadow for focus.
5. **Bloom control**: pure-saturated neon on pure black causes chromatic
   aberration/halation for some users and astigmatism. The near-black `#06070d`
   (not `#000`) and slightly-desaturated neons above soften this; keep large neon
   fills rare.

### 4.4 Scope & sizing
- `globals.css` token rewrite + ambient flares: **S**.
- Per-page hardcoded-hex audit/convert (signals, landing, legal, dashboard, module
  CSS): **M** — the bulk of the work, unglamorous but necessary.
- a11y pass (contrast checker on all pairs, reduced-motion, focus): **S**, do it as
  you convert, not after.
- No new deps. No Tailwind migration (out of scope — would be a separate, larger
  change).

---

## Build order & rough sizing

| Phase | Work | Size | Unblocks |
|---|---|---|---|
| 1 | DB schema + migrate in-memory caches (1.1–1.2) | S–M | launch blocker, council persistence, backtest table |
| 2 | Backend local: cache abstraction + entry point (3.1–3.3) | S | cheap iteration on everything |
| 3 | **Connect signals-app → portal** (WS0): nightly calibrate → Neon (0.4) first; deploy+secure API (0.1–0.2) + live client (0.3) if needed | M | council's backtest grounding |
| 4 | Council seats + debate protocol + grounding (2.1–2.3) | M–L | the actual 10x |
| 5 | Memory + track record page (2.4–2.5) | M | trust/product payoff |
| 6 | Quotas + deliberation cache (2.6) | S | cost safety before wider rollout |
| ∥ | **Neon dark-mode frontend (WS4)** — parallel, any time | S–M | the signature look |

Phases 1–2 are independent and parallel. WS0 (phase 3) needs WS1's `backtest_hit_rates`
table for the push path. Council debate (phase 4) can start on gcp3-only grounding
before WS0 lands, then gains backtest hit-rates once WS0 ships. WS4 is fully
independent — hand it to a parallel track.

## Explicitly out of scope (decisions, not code)
- **Push vs. pull for signals-app integration** (WS0.4 vs 0.3) — recommendation is
  push-to-Neon as default; decide whether the live public API deploy (0.1/0.2) is even
  needed or a scheduled Neon-writing job suffices.
- Paid models for CHAIR (quality jump vs. free-tier constraint — product call).
- Moving the portal off the hardcoded Cloud Run fallback URL to a versioned contract
  (flagged in signal-multiplication-analysis.md; still open) — note WS0 adds a *second*
  such URL (`SIGNALS_APP_URL`), so a shared backend-config module is worth considering.
- Streaming UI polish (SSE vs. polling) — pick during council implementation.
- Tailwind migration for WS4 — staying on plain CSS vars; a framework swap is separate.
