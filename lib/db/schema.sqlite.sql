-- NuWrrrld Portal — SQLite mirror of lib/db/schema.sql.
--
-- This is a BACKUP/OFFLINE-READ schema, not a live-write replacement for
-- Neon. It exists so scripts/backup-to-sqlite.mjs has somewhere to put a
-- point-in-time export of every table, and so that export can be opened,
-- queried, and diffed with any plain SQLite client (no Neon credentials,
-- no network) — see docs/local-sqlite-backup-and-offline-dev.md.
--
-- Translation notes (why this isn't a 1:1 copy of schema.sql):
--   jsonb              -> TEXT (JSON.stringify'd; use json_extract() to query)
--   timestamptz / date -> TEXT (ISO 8601 — 'YYYY-MM-DD[THH:MM:SS.sssZ]')
--   uuid               -> TEXT (the exported UUID string, verbatim)
--   text[]             -> TEXT (JSON array string, e.g. '["a","b"]')
--   inet               -> TEXT
--   numeric            -> REAL (Neon's arbitrary-precision numeric loses
--                         exactness here — fine for a read-only mirror,
--                         wrong for anything that re-derives money math)
--   bigint GENERATED
--     ALWAYS AS IDENTITY -> INTEGER PRIMARY KEY AUTOINCREMENT
--   gen_random_uuid()  -> dropped; the export always supplies a value
--   GENERATED ALWAYS AS (tsvector...) STORED, GIN index
--                      -> dropped entirely (corpus_chunks.tsv / its index).
--                         Full-text search over the mirror isn't a goal of a
--                         backup; if it becomes one, add an FTS5 virtual
--                         table over corpus_chunks(body, search_terms)
--                         rather than trying to reproduce Postgres tsvector.
--   CHECK (...), multi-column PRIMARY KEY, partial indexes (WHERE ...),
--   UNIQUE indexes, ON DELETE CASCADE
--                      -> all supported by SQLite as-is; kept unchanged.
--
-- Foreign keys are NOT enforced unless the connection runs
-- `PRAGMA foreign_keys = ON` — scripts/backup-to-sqlite.mjs does this, but
-- any other tool opening this file should too if it writes to it.

PRAGMA foreign_keys = ON;

-- ── Signal digest caches ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS signal_digest_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label TEXT,
  payload      TEXT    NOT NULL,   -- jsonb
  generated_at TEXT    NOT NULL    -- timestamptz
);
CREATE INDEX IF NOT EXISTS signal_digest_cache_generated_at_idx
  ON signal_digest_cache (generated_at DESC);

CREATE TABLE IF NOT EXISTS user_digest_cache (
  user_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,        -- jsonb
  expires_at TEXT NOT NULL         -- timestamptz
);

-- ── AI Council ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS council_sessions (
  id         TEXT PRIMARY KEY,     -- uuid
  user_id    TEXT NOT NULL,
  topic      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS council_sessions_user_idx
  ON council_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS council_messages (
  id         TEXT PRIMARY KEY,     -- uuid
  session_id TEXT NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  seat       TEXT NOT NULL,
  round      INTEGER NOT NULL DEFAULT 1,
  role       TEXT NOT NULL,
  model      TEXT NOT NULL,
  content    TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS council_messages_session_idx
  ON council_messages (session_id, round);

CREATE TABLE IF NOT EXISTS council_verdicts (
  id           TEXT PRIMARY KEY,   -- uuid
  session_id   TEXT NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  ticker       TEXT,
  direction    TEXT,
  confidence   TEXT,
  horizon      TEXT,
  invalidation TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS council_verdicts_session_idx
  ON council_verdicts (session_id);
CREATE INDEX IF NOT EXISTS council_verdicts_ticker_idx
  ON council_verdicts (ticker, created_at DESC);

-- ── signals-app backtest hit-rates ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS backtest_hit_rates (
  ticker      TEXT    NOT NULL,
  bucket_kind TEXT    NOT NULL,
  bucket_key  TEXT    NOT NULL,
  hits        INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  hit_rate    REAL    NOT NULL,
  computed_at TEXT    NOT NULL,
  PRIMARY KEY (ticker, bucket_kind, bucket_key)
);

-- ── Daily council-deliberation quota ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS council_usage (
  user_id       TEXT    NOT NULL,
  usage_date    TEXT    NOT NULL,   -- date
  deliberations INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- ── Watchlist persistence ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS watchlist_items (
  user_id  TEXT NOT NULL,
  ticker   TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (user_id, ticker)
);
CREATE INDEX IF NOT EXISTS watchlist_items_user_idx ON watchlist_items (user_id);

-- ── Pending-signal queue ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pending_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ticker          TEXT    NOT NULL,
  requested_by    TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT    NOT NULL,
  claimed_at      TEXT,
  error           TEXT,
  requested_at    TEXT    NOT NULL,
  processed_at    TEXT
);
CREATE INDEX IF NOT EXISTS pending_signals_status_idx
  ON pending_signals (status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS pending_signals_one_pending_per_ticker
  ON pending_signals (ticker) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS signal_cache (
  ticker       TEXT PRIMARY KEY,
  payload      TEXT NOT NULL,      -- jsonb
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live_prices (
  ticker     TEXT PRIMARY KEY,
  price      REAL NOT NULL,        -- numeric
  volume     INTEGER,
  traded_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Nu AI daily token budget ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nuai_usage (
  user_id    TEXT    NOT NULL,
  usage_date TEXT    NOT NULL,
  tokens     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, usage_date)
);

-- ── Hold/Fold verdict cache ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS holdfold_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payload      TEXT NOT NULL,      -- jsonb
  generated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS holdfold_cache_generated_at_idx
  ON holdfold_cache (generated_at DESC);

-- ── Compile-time grounding ────────────────────────────────────────────────
-- corpus_chunks.tsv and its GIN index are dropped — see the header note.

CREATE TABLE IF NOT EXISTS corpus_chunks (
  chunk_id      TEXT PRIMARY KEY,
  source_file   TEXT NOT NULL,
  trader_filter TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',   -- text[] -> JSON array
  body          TEXT NOT NULL,
  search_terms  TEXT NOT NULL DEFAULT '[]',   -- text[] -> JSON array
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS corpus_chunks_trader_filter_idx
  ON corpus_chunks (trader_filter);

CREATE TABLE IF NOT EXISTS grounding_pack (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  state_key        TEXT    NOT NULL,
  horizon          TEXT    NOT NULL,
  direction        TEXT    NOT NULL,
  rule_text        TEXT    NOT NULL,
  quote            TEXT    NOT NULL,
  chunk_id         TEXT    NOT NULL REFERENCES corpus_chunks (chunk_id) ON DELETE CASCADE,
  source_file      TEXT    NOT NULL,
  tags             TEXT    NOT NULL DEFAULT '[]',   -- text[] -> JSON array
  confidence       REAL    NOT NULL DEFAULT 1.0,
  corpus_version   TEXT    NOT NULL,
  taxonomy_version TEXT    NOT NULL,
  compiled_at      TEXT    NOT NULL,
  UNIQUE (state_key, chunk_id)
);
CREATE INDEX IF NOT EXISTS grounding_pack_state_idx
  ON grounding_pack (state_key);
CREATE INDEX IF NOT EXISTS grounding_pack_chunk_id_idx
  ON grounding_pack (chunk_id);

CREATE TABLE IF NOT EXISTS grounding_misses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  question   TEXT NOT NULL,
  ticker     TEXT,
  state_keys TEXT NOT NULL DEFAULT '[]',   -- text[] -> JSON array
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS grounding_misses_created_at_idx
  ON grounding_misses (created_at DESC);

-- ── Public council demo ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public_demo_usage (
  ip_hash    TEXT    NOT NULL,
  usage_date TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, usage_date)
);

CREATE TABLE IF NOT EXISTS public_demo_cache (
  ticker     TEXT NOT NULL,
  usage_date TEXT NOT NULL,
  seat       TEXT NOT NULL,
  answer     TEXT NOT NULL,
  model      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticker, usage_date, seat)
);

-- ── Disclaimer acknowledgements ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS disclaimer_acks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  disclaimer_hash TEXT NOT NULL,
  version         TEXT NOT NULL,
  surface         TEXT,
  user_agent      TEXT,
  acknowledged_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS disclaimer_acks_user_hash_idx
  ON disclaimer_acks (user_id, disclaimer_hash);

-- ── Per-ticker analyze cache ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS analyze_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  cache_key    TEXT NOT NULL,
  symbol       TEXT NOT NULL,
  payload      TEXT NOT NULL,      -- jsonb
  generated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS analyze_cache_key_idx
  ON analyze_cache (cache_key);

-- ── Precomputed AI artifacts ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS precomputed_ai (
  kind         TEXT NOT NULL,
  subject      TEXT NOT NULL,
  payload      TEXT NOT NULL,      -- jsonb
  model        TEXT,
  generated_at TEXT NOT NULL,
  expires_at   TEXT,
  PRIMARY KEY (kind, subject)
);
CREATE INDEX IF NOT EXISTS precomputed_ai_kind_generated_idx
  ON precomputed_ai (kind, generated_at DESC);

-- ── ticker_universe / ticker_cards ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ticker_universe (
  ticker   TEXT PRIMARY KEY,
  universe TEXT NOT NULL CHECK (universe IN ('etf', 'stock')),
  name     TEXT,
  active   INTEGER NOT NULL DEFAULT 1,   -- boolean -> 0/1
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticker_universe_active_idx
  ON ticker_universe (universe, ticker) WHERE active;

CREATE TABLE IF NOT EXISTS ticker_cards (
  ticker           TEXT NOT NULL REFERENCES ticker_universe (ticker) ON DELETE CASCADE,
  horizon          TEXT NOT NULL CHECK (horizon IN ('t1', 't2')),
  universe         TEXT NOT NULL CHECK (universe IN ('etf', 'stock')),
  state_key        TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  score            REAL NOT NULL,
  score_version    TEXT NOT NULL,
  action           TEXT NOT NULL CHECK (action IN ('BUY', 'HOLD', 'SELL')),
  tokens           TEXT NOT NULL,               -- jsonb
  numerics         TEXT NOT NULL DEFAULT '{}',  -- jsonb
  data_quality     REAL NOT NULL DEFAULT 1.0,
  missing_fields   TEXT NOT NULL DEFAULT '[]',  -- text[] -> JSON array
  source           TEXT NOT NULL,
  source_run_id    TEXT,
  bar_date         TEXT NOT NULL,   -- date
  computed_at      TEXT NOT NULL,
  PRIMARY KEY (ticker, horizon)
);
CREATE INDEX IF NOT EXISTS ticker_cards_rank_idx
  ON ticker_cards (horizon, score DESC, computed_at DESC)
  WHERE data_quality >= 0.8;
CREATE INDEX IF NOT EXISTS ticker_cards_state_idx
  ON ticker_cards (taxonomy_version, state_key);
CREATE INDEX IF NOT EXISTS ticker_cards_freshness_idx
  ON ticker_cards (bar_date DESC, computed_at DESC);

-- ── Cookie / tracking consent ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS consent_records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT    NOT NULL,
  consent_version TEXT    NOT NULL,
  source          TEXT    NOT NULL,
  preferences     INTEGER NOT NULL,   -- boolean -> 0/1
  analytics       INTEGER NOT NULL,
  marketing       INTEGER NOT NULL,
  record          TEXT    NOT NULL,   -- jsonb
  user_agent      TEXT,
  ip              TEXT,               -- inet
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS consent_records_user_idx
  ON consent_records (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS legal_consent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  doc         TEXT NOT NULL CHECK (doc IN ('tos', 'privacy')),
  doc_version TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  ip          TEXT,       -- inet
  user_agent  TEXT,
  surface     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS legal_consent_events_uniq_idx
  ON legal_consent_events (user_id, doc, doc_version);

CREATE TABLE IF NOT EXISTS privacy_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('export', 'delete', 'rectify')),
  status      TEXT NOT NULL DEFAULT 'received'
                CHECK (status IN ('received', 'fulfilled', 'in_progress', 'rejected')),
  details     TEXT,        -- jsonb
  received_at TEXT NOT NULL,
  due_at      TEXT NOT NULL,
  resolved_at TEXT,
  ip          TEXT,        -- inet
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS privacy_requests_user_idx
  ON privacy_requests (user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS privacy_requests_open_idx
  ON privacy_requests (due_at)
  WHERE status IN ('received', 'in_progress');

-- ── First-party acquisition attribution ───────────────────────────────────

CREATE TABLE IF NOT EXISTS user_attribution (
  user_id     TEXT PRIMARY KEY,
  first_touch TEXT,        -- jsonb
  last_touch  TEXT,        -- jsonb
  created_at  TEXT NOT NULL
);

-- ── Followed-tickers benchmark / eval harness ─────────────────────────────

CREATE TABLE IF NOT EXISTS followed_ticker_picks (
  id              TEXT PRIMARY KEY,   -- uuid
  cohort_month    TEXT    NOT NULL,   -- date
  ticker          TEXT    NOT NULL,
  direction       TEXT    NOT NULL CHECK (direction IN ('bull', 'bear')),
  entry_price     REAL    NOT NULL,   -- numeric
  strength        REAL,
  signal_category TEXT,
  invalidation    TEXT,
  confidence      TEXT CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  selected_at     TEXT    NOT NULL,
  dropped_at      TEXT,
  drop_reason     TEXT,
  UNIQUE (cohort_month, ticker)
);
CREATE INDEX IF NOT EXISTS followed_ticker_picks_cohort_idx
  ON followed_ticker_picks (cohort_month DESC);

CREATE TABLE IF NOT EXISTS followed_ticker_observations (
  pick_id       TEXT NOT NULL REFERENCES followed_ticker_picks(id) ON DELETE CASCADE,
  observed_on   TEXT NOT NULL,   -- date
  close_price   REAL NOT NULL,   -- numeric
  signal_dir    TEXT,
  backtest_rate REAL,
  council_json  TEXT,            -- jsonb
  PRIMARY KEY (pick_id, observed_on)
);

CREATE TABLE IF NOT EXISTS followed_ticker_scores (
  pick_id       TEXT    NOT NULL REFERENCES followed_ticker_picks(id) ON DELETE CASCADE,
  horizon       TEXT    NOT NULL,
  resolved_on   TEXT    NOT NULL,   -- date
  exit_price    REAL,               -- numeric
  return_pct    REAL,
  directional   REAL,
  outcome       TEXT    NOT NULL CHECK (outcome IN ('hit', 'miss', 'flat', 'void')),
  judge_score   INTEGER,
  judge_detail  TEXT,               -- jsonb
  judge_version TEXT,
  PRIMARY KEY (pick_id, horizon)
);
CREATE INDEX IF NOT EXISTS followed_ticker_scores_horizon_idx
  ON followed_ticker_scores (horizon, resolved_on DESC);
