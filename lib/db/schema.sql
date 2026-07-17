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
                  to_tsvector('english', body || ' ' || array_to_string(search_terms, ' '))
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
  state_key        text        NOT NULL,     -- lib/grounding/taxonomy.ts toStateKeys()
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
  UNIQUE (state_key, horizon, chunk_id)
);
CREATE INDEX IF NOT EXISTS grounding_pack_state_horizon_idx
  ON grounding_pack (state_key, horizon);

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
