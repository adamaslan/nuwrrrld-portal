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
