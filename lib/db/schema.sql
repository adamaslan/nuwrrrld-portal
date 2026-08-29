-- NuWrrrld Portal — Neon/Postgres schema.
-- Idempotent (IF NOT EXISTS): safe to re-run. Apply with `npm run db:migrate`.
--
-- Implements Workstream 1 of portal-10x-council-db-local.md: durable storage for
-- the caches that were module-level in-memory Maps (lost on every serverless cold
-- start — the #1 launch blocker), plus the council/verdict tables Workstream 2
-- builds on, and the backtest_hit_rates table the signals-app integration (WS0.4)
-- writes nightly.

-- ── Signal digest caches (replace in-memory Maps in lib/digest-cache.ts) ──────

-- Global digest pushed by the local refresh script / warmed from the live backend.
-- Already referenced by lib/digest-cache-db.ts; declared here for completeness.
CREATE TABLE IF NOT EXISTS signal_digest_cache (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_label text,
  payload      jsonb       NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_digest_cache_generated_at_idx
  ON signal_digest_cache (generated_at DESC);

-- Per-user digest cache (was the `userCache` Map).
CREATE TABLE IF NOT EXISTS user_digest_cache (
  user_id    text PRIMARY KEY,          -- Clerk userId
  payload    jsonb       NOT NULL,
  expires_at timestamptz NOT NULL
);

-- ── AI Council (Workstream 2) ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS council_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text        NOT NULL,      -- Clerk userId
  topic      text        NOT NULL,      -- ticker or free-form question
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_sessions_user_idx
  ON council_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS council_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid        NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  seat       text        NOT NULL,      -- T1 | T2 | RISK | MACRO | QUANT | CHAIR
  round      int         NOT NULL DEFAULT 1,
  role       text        NOT NULL,      -- 'answer' | 'critique' | 'synthesis'
  model      text        NOT NULL,      -- which model actually served it
  content    text        NOT NULL,
  latency_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_messages_session_idx
  ON council_messages (session_id, round);

CREATE TABLE IF NOT EXISTS council_verdicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   uuid        NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  ticker       text,
  direction    text,                    -- bullish | bearish | neutral
  confidence   text,                    -- low | medium | high
  horizon      text,                    -- e.g. '1-5d', '6-12m'
  invalidation text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS council_verdicts_session_idx
  ON council_verdicts (session_id);
CREATE INDEX IF NOT EXISTS council_verdicts_ticker_idx
  ON council_verdicts (ticker, created_at DESC);

-- ── signals-app backtest hit-rates (WS0.4 nightly push target) ───────────────

CREATE TABLE IF NOT EXISTS backtest_hit_rates (
  ticker      text        NOT NULL,
  bucket_kind text        NOT NULL,     -- 'category' | 'strength'
  bucket_key  text        NOT NULL,     -- e.g. 'MA_CROSS' | 'STRONG BULLISH'
  hits        int         NOT NULL,
  total       int         NOT NULL,
  hit_rate    real        NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, bucket_kind, bucket_key)
);

-- ── Daily council-deliberation quota (WS2.6 cost control) ────────────────────

CREATE TABLE IF NOT EXISTS council_usage (
  user_id      text NOT NULL,
  usage_date   date NOT NULL,
  deliberations int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- ── Watchlist persistence (audit 2026-07-15: replaces the in-memory Map in
--    lib/watchlist-store.ts — every deploy previously wiped every user's list) ──

CREATE TABLE IF NOT EXISTS watchlist_items (
  user_id  text        NOT NULL,      -- Clerk userId
  ticker   text        NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ticker)
);
CREATE INDEX IF NOT EXISTS watchlist_items_user_idx ON watchlist_items (user_id);

-- ── Pending-signal queue (closes the "add stock → cache → run signals" loop:
--    a watchlist add enqueues here; an external scheduled job — Modal/Zo cron,
--    outside this repo — drains it via POST /api/signals/drain) ─────────────

CREATE TABLE IF NOT EXISTS pending_signals (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticker         text        NOT NULL,
  requested_by   text        NOT NULL,   -- Clerk userId that triggered this
  status         text        NOT NULL DEFAULT 'pending',  -- pending | processing | done | error
  attempts       int         NOT NULL DEFAULT 0,          -- failed drain attempts (retry cap)
  next_attempt_at timestamptz NOT NULL DEFAULT now(),     -- earliest a drain may (re)claim this row (backoff)
  claimed_at     timestamptz,                             -- when the current drain leased it (stale-lease recovery)
  error          text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);
-- Idempotent adds for deployments created before these columns existed.
ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;
ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE pending_signals ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
-- Claim scan filters on (status, next_attempt_at); keep the index aligned.
CREATE INDEX IF NOT EXISTS pending_signals_status_idx
  ON pending_signals (status, next_attempt_at);
-- At most one live 'pending' row per ticker (enqueue dedup is also enforced in
-- lib/signal-queue.ts via WHERE NOT EXISTS; this is the DB-level backstop).
CREATE UNIQUE INDEX IF NOT EXISTS pending_signals_one_pending_per_ticker
  ON pending_signals (ticker) WHERE status = 'pending';

-- Per-ticker signal cache (L2 for lib/shared/signal-lookup.ts — lets a single
-- ticker be upserted without rewriting the whole holdfold/digest payload).
CREATE TABLE IF NOT EXISTS signal_cache (
  ticker       text        PRIMARY KEY,
  payload      jsonb       NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

-- Real-time last price, pushed by the Finnhub WebSocket tier (an external Modal
-- worker in homebase/modal_finnhub_ws.py) via POST /api/signals/live. This is
-- the low-latency "quote" lane that sits in front of the slower signal cache.
CREATE TABLE IF NOT EXISTS live_prices (
  ticker     text        PRIMARY KEY,
  price      numeric     NOT NULL,
  volume     bigint,
  traded_at  timestamptz NOT NULL,          -- exchange trade timestamp (from Finnhub)
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Nu AI daily token budget (audit 2026-07-15: replaces the in-memory Map in
--    app/api/nuai/route.ts — budget previously reset on every cold start) ────

CREATE TABLE IF NOT EXISTS nuai_usage (
  user_id    text NOT NULL,
  usage_date date NOT NULL,
  tokens     int  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- ── Hold/Fold verdict cache (audit 2026-07-15: replaces the in-memory `cached`
--    module variable in app/api/holdfold/route.ts) ───────────────────────────

CREATE TABLE IF NOT EXISTS holdfold_cache (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload      jsonb       NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS holdfold_cache_generated_at_idx
  ON holdfold_cache (generated_at DESC);

-- ── Compile-time grounding (docs/ai-council-timeline.html, PR 1 — "Contract").
--    Ships dark: nothing reads these tables until PR 2 (compiler) fills the
--    pack and PR 3 (runtime resolver) joins on it. Replaces the corpus's
--    embedding/ChromaDB retrieval with a pre-extracted, cited lookup table
--    keyed on lib/grounding/taxonomy.ts's finite state-key space. ──────────

-- Both to_tsvector(regconfig, text) AND array_to_string(anyarray, text) are
-- STABLE, not IMMUTABLE, in Postgres — so Postgres refuses either one
-- directly inside a GENERATED column, even with the config cast to
-- regconfig. The fix is to wrap the *entire* expression (concat included)
-- in one SQL function that Postgres will take our word is IMMUTABLE,
-- since this repo never calls ALTER TEXT SEARCH CONFIGURATION on
-- "english". Verified against the real Neon DB (see PR review notes).
CREATE OR REPLACE FUNCTION immutable_corpus_tsvector(text, text[]) RETURNS tsvector AS $$
  SELECT to_tsvector('english', $1 || ' ' || array_to_string($2, ' '))
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE;

-- The curated trading-doc corpus, chunked the same way ai-text-opt-1024's
-- ingest.py did (file-aware: prose vs. Q&A), now living in this repo's
-- corpus/ directory instead of a separate ChromaDB-backed service.
CREATE TABLE IF NOT EXISTS corpus_chunks (
  chunk_id      text        PRIMARY KEY,
  source_file   text        NOT NULL,
  trader_filter text,                       -- 'T1' | 'T2' | null (applies to both)
  tags          text[]      NOT NULL DEFAULT '{}',
  body          text        NOT NULL,
  search_terms  text[]      NOT NULL DEFAULT '{}', -- doc2query: questions this chunk answers + synonyms
  tsv           tsvector GENERATED ALWAYS AS (
                  immutable_corpus_tsvector(body, search_terms)
                ) STORED,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_chunks_tsv_idx
  ON corpus_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS corpus_chunks_trader_filter_idx
  ON corpus_chunks (trader_filter);

-- Compiled, per-signal-state rules extracted from corpus_chunks once (the
-- weekly compile job), looked up many times at zero model cost. Every row
-- carries the evidence needed to render a [C·] citation.
CREATE TABLE IF NOT EXISTS grounding_pack (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  state_key        text        NOT NULL,     -- lib/grounding/taxonomy.ts toStateKey()
  horizon          text        NOT NULL,     -- 't1' | 't2'
  direction        text        NOT NULL,     -- bullish | bearish | neutral
  rule_text        text        NOT NULL,
  quote            text        NOT NULL,     -- verbatim substring of the source chunk
  chunk_id         text        NOT NULL REFERENCES corpus_chunks (chunk_id) ON DELETE CASCADE,
  source_file      text        NOT NULL,
  tags             text[]      NOT NULL DEFAULT '{}',
  confidence       real        NOT NULL DEFAULT 1.0,
  corpus_version   text        NOT NULL,
  taxonomy_version text        NOT NULL,
  compiled_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (state_key, chunk_id)
);
CREATE INDEX IF NOT EXISTS grounding_pack_state_idx
  ON grounding_pack (state_key);
CREATE INDEX IF NOT EXISTS grounding_pack_chunk_id_idx
  ON grounding_pack (chunk_id);

-- Questions no pack tier (0/1/2) could answer — the curation queue that
-- tells the corpus what to write next.
CREATE TABLE IF NOT EXISTS grounding_misses (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question   text        NOT NULL,
  ticker     text,
  state_keys text[]      NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS grounding_misses_created_at_idx
  ON grounding_misses (created_at DESC);

-- ── Public council demo (unauthenticated landing-page "ask the council") ────
-- ip_hash is a sha256 of the caller's IP (lib/public-demo.ts hashIp) — raw IPs
-- are never stored. One fresh model call per hash per day; a cache hit on a
-- ticker someone else already asked about today is unlimited and free.

CREATE TABLE IF NOT EXISTS public_demo_usage (
  ip_hash    text NOT NULL,
  usage_date date NOT NULL,
  count      int  NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, usage_date)
);

CREATE TABLE IF NOT EXISTS public_demo_cache (
  ticker       text        NOT NULL,
  usage_date   date        NOT NULL,
  seat         text        NOT NULL,
  answer       text        NOT NULL,
  model        text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, usage_date, seat)
);

-- ── Disclaimer acknowledgements (signed-in users) ────────────────────────────
-- Append-only: never UPDATE a row. disclaimer_hash is djb2(text + version) from
-- lib/disclaimer.ts, so editing the disclaimer text automatically invalidates
-- every prior ack without a version-bump migration. Signed-out users use
-- localStorage only (lib/disclaimer.ts hasAcknowledgedLocally); this table is
-- the durable, audit-relevant record for accounts that can take paid actions.

CREATE TABLE IF NOT EXISTS disclaimer_acks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text        NOT NULL,
  disclaimer_hash text        NOT NULL,
  version         text        NOT NULL,
  surface         text,
  user_agent      text,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS disclaimer_acks_user_hash_idx
  ON disclaimer_acks (user_id, disclaimer_hash);

-- ── Per-ticker analyze cache ──────────────────────────────────────────────────
-- Keyed on djb2(symbol|period|asset_type|risk_profile) — NOT on position lots,
-- since P&L is computed from the cached market analysis rather than re-fetched
-- per position. Distinct from holdfold_cache, which holds one whole-market
-- batch payload; this holds one payload per (ticker, request-shape).

CREATE TABLE IF NOT EXISTS analyze_cache (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  cache_key    text        NOT NULL,
  symbol       text        NOT NULL,
  payload      jsonb       NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);
-- Migration for deployments that ran with the old plain (non-unique) index and
-- may already hold duplicate cache_key rows from repeated saveAnalysis() inserts:
-- keep only the most recent row per key before the unique index can be created.
DROP INDEX IF EXISTS analyze_cache_key_idx;
DELETE FROM analyze_cache a USING analyze_cache b
  WHERE a.cache_key = b.cache_key AND a.generated_at < b.generated_at;
CREATE UNIQUE INDEX IF NOT EXISTS analyze_cache_key_idx
  ON analyze_cache (cache_key);

-- ---------------------------------------------------------------------------
-- Precomputed AI artifacts (Option D, docs/gha-modal-core-feature-coverage.md).
--
-- Batch AI work is generated off-request by a scheduled Modal job that runs
-- just after OpenRouter's UTC-midnight free-tier reset, when the daily quota is
-- fresh. The app then serves these rows as ordinary cached reads, costing zero
-- model quota at request time — which leaves the whole daily allowance for
-- genuinely interactive calls (Nu AI chat) that cannot be precomputed.
--
-- Keyed by (kind, subject): `kind` is the artifact type ('portfolio_health_ai',
-- 'digest_commentary', …) and `subject` is whatever that kind is scoped to — a
-- ticker set hash, a user id, or the literal 'global'. One row per pair; the
-- job upserts, so the table never grows without bound.
CREATE TABLE IF NOT EXISTS precomputed_ai (
  kind         text        NOT NULL,
  subject      text        NOT NULL,
  payload      jsonb       NOT NULL,
  model        text,                    -- which model served it, for observability
  generated_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,             -- NULL = serve until replaced
  PRIMARY KEY (kind, subject)
);
CREATE INDEX IF NOT EXISTS precomputed_ai_kind_generated_idx
  ON precomputed_ai (kind, generated_at DESC);

-- ---------------------------------------------------------------------------
-- ticker_universe / ticker_cards — the full-universe signal layer.
--
-- The design in docs/max-coverage-simplest-path.md: coverage is expensive only
-- because the unit of coverage is an AI narrative. A *token card* — the
-- discretized tuple lib/grounding/taxonomy.ts already produces — costs no model
-- quota, so every ticker can carry a dated, source-traced, machine-rankable
-- card while the model is spent only on the top of the ranking.
--
-- Deliberately ONE card table, not the three tables an earlier draft proposed.
-- Ranking is a SQL ORDER BY over this table; no ranking endpoint is needed.

CREATE TABLE IF NOT EXISTS ticker_universe (
  ticker     text PRIMARY KEY,
  universe   text NOT NULL CHECK (universe IN ('etf', 'stock')),
  name       text,
  active     boolean NOT NULL DEFAULT true,
  added_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticker_universe_active_idx
  ON ticker_universe (universe, ticker) WHERE active;

-- One card per (ticker, horizon): the taxonomy produces a distinct state for
-- each horizon, and both are cheap, so both are stored rather than picking one.
CREATE TABLE IF NOT EXISTS ticker_cards (
  ticker           text NOT NULL REFERENCES ticker_universe (ticker) ON DELETE CASCADE,
  horizon          text NOT NULL CHECK (horizon IN ('t1', 't2')),
  universe         text NOT NULL CHECK (universe IN ('etf', 'stock')),
  state_key        text NOT NULL,          -- toStateKey() — joins to grounding_pack
  taxonomy_version text NOT NULL,          -- TAXONOMY_VERSION at card time
  score            real NOT NULL,          -- deterministic, computed in code
  score_version    text NOT NULL,          -- CARD_SCORE_VERSION
  action           text NOT NULL CHECK (action IN ('BUY', 'HOLD', 'SELL')),
  tokens           jsonb NOT NULL,         -- toStateKeyParts() — the card itself
  numerics         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- raw inputs, for audit
  data_quality     real NOT NULL DEFAULT 1.0,           -- gates the explain batch
  missing_fields   text[] NOT NULL DEFAULT '{}',        -- prevents silent neutralization
  source           text NOT NULL,          -- 'gcp3' | 'modal-eod' | …
  source_run_id    text,
  bar_date         date NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, horizon)
);

-- The ranking index. Partial on quality because the top-N query never wants
-- low-quality rows, so they should not occupy the index at all.
CREATE INDEX IF NOT EXISTS ticker_cards_rank_idx
  ON ticker_cards (horizon, score DESC, computed_at DESC)
  WHERE data_quality >= 0.8;

-- The quiet payoff: joins straight to grounding_pack.state_key, giving every
-- ticker cited, corpus-grounded rules at Tier 0 for zero model calls.
CREATE INDEX IF NOT EXISTS ticker_cards_state_idx
  ON ticker_cards (taxonomy_version, state_key);

CREATE INDEX IF NOT EXISTS ticker_cards_freshness_idx
  ON ticker_cards (bar_date DESC, computed_at DESC);

-- ── Cookie / tracking consent (signed-in users) ─────────────────────────────
-- Append-only, one row per consent CHANGE (grant, withdraw, version bump, an
-- automatic GPC/DNT opt-out). Never UPDATE a row. Regulators ask for the
-- history, not just the current value — getLatestConsentRecord() reads the
-- newest row; the privacy export ships the whole trail.
--
-- The `nu_consent` first-party cookie is the fast path and the only store for
-- signed-out visitors (lib/shared/consent.ts). This table makes a signed-in
-- user's choice survive a cookie clear and follow the account to gcp3-mobile.
-- `record` is the full serialized ConsentRecord (v, choices, source, ts) so a
-- CONSENT_VERSION bump can be reconstructed exactly as it was stored.

CREATE TABLE IF NOT EXISTS consent_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         text        NOT NULL,      -- Clerk userId
  consent_version text        NOT NULL,      -- CONSENT_VERSION at write time
  source          text        NOT NULL,      -- banner_accept_all | banner_reject_all | preferences | gpc | dnt | default
  preferences     boolean     NOT NULL,
  analytics       boolean     NOT NULL,
  marketing       boolean     NOT NULL,
  record          jsonb       NOT NULL,      -- full serialized ConsentRecord
  user_agent      text,
  ip              inet,                       -- coarse; for the audit trail only
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS consent_records_user_idx
  ON consent_records (user_id, created_at DESC);

-- ── Express legal consent at sign-up (ToS + Privacy Policy) ─────────────────
-- Phase 1.4 of docs/todo-auth-cookies-tracking.md. A bare boolean is not
-- evidence of consent; a versioned, timestamped, per-document record is.
-- One row per (user, document, version) accepted. `doc_version` lets a
-- material policy change trigger a re-prompt without losing the prior record.

CREATE TABLE IF NOT EXISTS legal_consent_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      text        NOT NULL,         -- Clerk userId
  doc          text        NOT NULL CHECK (doc IN ('tos', 'privacy')),
  doc_version  text        NOT NULL,
  accepted_at  timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text,
  surface      text                           -- 'web' | 'mobile'
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_consent_events_uniq_idx
  ON legal_consent_events (user_id, doc, doc_version);

-- ── Data-subject request ledger (statutory clock) ──────────────────────────
-- Phase 6 of docs/todo-auth-cookies-tracking.md. Every DSAR the privacy
-- endpoints handle (access/export, erasure, rectification) writes one row here
-- at receipt. Purpose: prove the statutory response clock — GDPR Art. 12(3)
-- is 30 days, CCPA is 45 days — was met, by having `received_at` and `due_at`
-- on record. Append-mostly: `status` and `resolved_at` are the only columns
-- ever updated, when a request that needs follow-up (rectification) completes.
-- Kept intentionally outside the erasure cascade in app/api/privacy/delete —
-- the ledger of "this user asked to be deleted on DATE" must survive the
-- deletion it records (it holds no personal data beyond the Clerk userId).

CREATE TABLE IF NOT EXISTS privacy_requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      text        NOT NULL,          -- Clerk userId
  kind         text        NOT NULL CHECK (kind IN ('export', 'delete', 'rectify')),
  status       text        NOT NULL DEFAULT 'received'
                 CHECK (status IN ('received', 'fulfilled', 'in_progress', 'rejected')),
  details      jsonb,                          -- e.g. rectify: which field, requested value
  received_at  timestamptz NOT NULL DEFAULT now(),
  due_at       timestamptz NOT NULL,           -- received_at + statutory window
  resolved_at  timestamptz,
  ip           inet,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS privacy_requests_user_idx
  ON privacy_requests (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS privacy_requests_open_idx
  ON privacy_requests (due_at)
  WHERE status IN ('received', 'in_progress');

-- ── First-party acquisition attribution ───────────────────────────────────
-- Phase 4.1 of docs/todo-auth-cookies-tracking.md. One row per user, written
-- once at first authenticated load. First-touch is recovered from the
-- `nu_attrib` cookie set on the anonymous landing visit; last-touch is the
-- visit during which they signed in. Entirely first-party (UTM params, gclid/
-- fbclid, referrer) — no third-party pixel — so it sits under `analytics`
-- consent, never `marketing`. Lets CAC be computed per channel with nothing
-- shared with an ad platform.

CREATE TABLE IF NOT EXISTS user_attribution (
  user_id      text        PRIMARY KEY,       -- Clerk userId; one row per user
  first_touch  jsonb,                          -- serialized AttributionTouch
  last_touch   jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
