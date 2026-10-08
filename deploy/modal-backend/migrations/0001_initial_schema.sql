-- =====================================================================
-- 0. Extensions & helpers
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;
-- CREATE EXTENSION IF NOT EXISTS vector;  -- optional: Nu AI glossary RAG

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

-- =====================================================================
-- 1. Users, billing, entitlements, referrals
-- =====================================================================
CREATE TABLE users (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id          text NOT NULL UNIQUE,                -- "user_..."
  email                  citext,
  email_verified         boolean NOT NULL DEFAULT false,
  display_name           text,
  timezone               text NOT NULL DEFAULT 'America/New_York',
  referral_code          text NOT NULL UNIQUE,                -- short URL-safe code
  referred_by_user_id    uuid REFERENCES users(id),
  role                   text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  disclaimer_accepted_at timestamptz,                         -- required before AI features
  disclaimer_version     text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz                          -- soft delete on Clerk user.deleted
);
CREATE INDEX users_email_idx ON users (email);
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE billing_customers (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  stripe_price_id        text NOT NULL,
  status                 text NOT NULL CHECK (status IN
                           ('incomplete','incomplete_expired','trialing','active',
                            'past_due','canceled','unpaid','paused')),
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  stripe_trial_end       timestamptz,    -- Stripe-side trial (referral friend month at checkout)
  last_event_created     timestamptz NOT NULL,  -- Stripe event.created; ignore older events
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every non-Stripe source of access is a grant (trial, referral months, comps).
CREATE TABLE entitlement_grants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN
                    ('trial','referral_friend','referral_referrer','promo','admin_comp')),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  applied_via     text NOT NULL DEFAULT 'app'
                    CHECK (applied_via IN ('app','stripe_credit','stripe_trial')),
  stripe_ref      text,                  -- balance transaction id / checkout session id
  referral_id     uuid,                  -- FK added after referrals
  idempotency_key text NOT NULL UNIQUE,  -- 'trial:{user}', 'ref:{referral}:referrer', ...
  revoked_at      timestamptz,
  revoke_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE UNIQUE INDEX one_trial_per_user ON entitlement_grants (user_id) WHERE kind = 'trial';
CREATE INDEX grants_user_active_idx ON entitlement_grants (user_id, ends_at) WHERE revoked_at IS NULL;

-- Optional abuse control: one trial per verified email (hashed) across Clerk accounts.
CREATE TABLE trial_fingerprints (
  email_hash text PRIMARY KEY,           -- sha256(normalized lowercase email)
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE referrals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id uuid NOT NULL REFERENCES users(id),
  referred_user_id uuid NOT NULL UNIQUE REFERENCES users(id),  -- a user is referred at most once
  code_used        text NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN
                     ('pending','qualified','rewarded','rejected','reversed')),
  qualified_at     timestamptz,
  rewarded_at      timestamptz,
  reason           text,           -- self_referral, duplicate_email, cap_reached, refund, ...
  signup_ip_hash   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (referrer_user_id <> referred_user_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_user_id, status);
ALTER TABLE entitlement_grants
  ADD CONSTRAINT grants_referral_fk FOREIGN KEY (referral_id) REFERENCES referrals(id);

CREATE TABLE referral_clicks (
  id         bigserial PRIMARY KEY,
  code       text NOT NULL,
  landed_at  timestamptz NOT NULL DEFAULT now(),
  ip_hash    text,
  user_agent text
);
CREATE INDEX referral_clicks_code_idx ON referral_clicks (code, landed_at);

-- Inbound webhook ledger (Clerk via Svix, Stripe). PK = idempotency.
CREATE TABLE webhook_events (
  provider      text NOT NULL CHECK (provider IN ('clerk','stripe')),
  event_id      text NOT NULL,          -- svix-id header / Stripe event.id
  event_type    text NOT NULL,
  event_created timestamptz,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  last_error    text,
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX webhook_unprocessed_idx ON webhook_events (received_at) WHERE processed_at IS NULL;

-- =====================================================================
-- 2. Reference & market data
-- =====================================================================
CREATE TABLE instruments (
  ticker         text PRIMARY KEY,
  name           text NOT NULL,
  asset_type     text NOT NULL CHECK (asset_type IN ('etf','stock','index_proxy')),
  sector         text,
  industry       text,
  is_tracked_etf boolean NOT NULL DEFAULT false,      -- the 54-ETF Signal Digest universe
  benchmark      text REFERENCES instruments(ticker), -- e.g. 'SPY' for relative strength
  active         boolean NOT NULL DEFAULT true,
  listed_at      date,
  delisted_at    date,
  metadata       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX instruments_tracked_idx ON instruments (ticker) WHERE is_tracked_etf AND active;

CREATE TABLE trading_calendar (                      -- seeded from exchange_calendars 'XNYS'
  session_date   date PRIMARY KEY,
  is_open        boolean NOT NULL,
  open_at        timestamptz,                        -- 09:30 ET expressed in UTC
  close_at       timestamptz,                        -- 16:00 ET, or 13:00 ET on early closes
  is_early_close boolean NOT NULL DEFAULT false,
  note           text,                               -- holiday name / manual override reason
  source         text NOT NULL DEFAULT 'exchange_calendars'
);

CREATE TABLE price_bars (
  ticker      text NOT NULL REFERENCES instruments(ticker),
  timeframe   text NOT NULL DEFAULT '1d' CHECK (timeframe IN ('1d')),
  bar_date    date NOT NULL,                         -- ET session date
  open        numeric(18,6) NOT NULL,
  high        numeric(18,6) NOT NULL,
  low         numeric(18,6) NOT NULL,
  close       numeric(18,6) NOT NULL,
  volume      bigint NOT NULL CHECK (volume >= 0),
  vwap        numeric(18,6),
  adj_close   numeric(18,6),                         -- split/dividend adjusted
  adj_factor  numeric(20,10) NOT NULL DEFAULT 1,
  provider    text NOT NULL,
  is_final    boolean NOT NULL DEFAULT true,         -- false for provisional rows
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, timeframe, bar_date),
  CHECK (low <= LEAST(open, close) AND high >= GREATEST(open, close) AND low > 0)
);
CREATE INDEX price_bars_date_idx ON price_bars (bar_date);
-- At larger scale: range-partition by bar_date (yearly).

CREATE TABLE corporate_actions (
  ticker   text NOT NULL REFERENCES instruments(ticker),
  ex_date  date NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('split','dividend')),
  ratio    numeric(20,10),                           -- split: new shares per old share
  amount   numeric(18,6),                            -- cash dividend per share
  provider text NOT NULL,
  applied_to_paper_at timestamptz,                   -- idempotent paper adjustments
  PRIMARY KEY (ticker, ex_date, kind)
);

-- Short-lived provider response cache (quotes, snapshots, reference lookups).
CREATE TABLE market_data_cache (
  cache_key  text PRIMARY KEY,                       -- provider:endpoint:sha256(params)
  provider   text NOT NULL,
  payload    jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX market_data_cache_exp_idx ON market_data_cache (expires_at);

CREATE TABLE factor_exposures (                      -- Portfolio Intel inputs
  ticker     text NOT NULL REFERENCES instruments(ticker),
  as_of_date date NOT NULL,
  factor     text NOT NULL,     -- beta_spy_252, mom_12_1, vol_63, drawdown_252, ...
  value      numeric(18,8) NOT NULL,
  source     text NOT NULL,     -- 'computed' or a provider name
  PRIMARY KEY (ticker, as_of_date, factor)
);

-- =====================================================================
-- 3. Indicators, signals, digest, hold/fold, rotation
-- =====================================================================
CREATE TABLE indicator_values (
  ticker         text NOT NULL REFERENCES instruments(ticker),
  bar_date       date NOT NULL,
  indicator      text NOT NULL,  -- 'rsi_14','macd_12_26_9','adx_14','atr_14','sma_200','bb_20_2','rs_spy_63',...
  value          numeric(18,8),  -- primary scalar
  components     jsonb NOT NULL DEFAULT '{}',   -- e.g. {"macd":..,"signal":..,"hist":..}
  engine_version text NOT NULL,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticker, bar_date, indicator, engine_version)
);
CREATE INDEX indicator_values_date_idx ON indicator_values (bar_date, indicator);

CREATE TABLE signal_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of_date     date NOT NULL,
  engine_version text NOT NULL,
  is_backfill    boolean NOT NULL DEFAULT false,
  status         text NOT NULL CHECK (status IN ('running','computed','explained','published','failed')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  published_at   timestamptz,
  stats          jsonb NOT NULL DEFAULT '{}',
  UNIQUE (as_of_date, engine_version)
);

CREATE TABLE signals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES signal_runs(id),
  ticker                text NOT NULL REFERENCES instruments(ticker),
  as_of_date            date NOT NULL,
  direction             text NOT NULL CHECK (direction IN ('bullish','bearish','neutral')),
  strength              numeric(6,3) NOT NULL CHECK (strength BETWEEN -1 AND 1),  -- signed
  timeframe             text NOT NULL CHECK (timeframe IN ('short_term','swing','position')),
  horizon_days          int NOT NULL CHECK (horizon_days > 0),  -- trading sessions
  fired_indicators      jsonb NOT NULL,   -- [{indicator, reading, threshold, rule, weight, lookback, timeframe}]
  explanation_md        text,             -- LLM text built ONLY from fired_indicators
  explanation_source    text CHECK (explanation_source IN ('llm','template')),
  explanation_model     text,
  prompt_version        text,
  explanation_validated boolean NOT NULL DEFAULT false,         -- numeric cross-check (13.4)
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, ticker)
);
CREATE INDEX signals_ticker_date_idx ON signals (ticker, as_of_date DESC);

CREATE TABLE hold_fold_verdicts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker             text NOT NULL REFERENCES instruments(ticker),
  as_of_date         date NOT NULL,
  scope              text NOT NULL DEFAULT 'global' CHECK (scope IN ('global','user')),
  user_id            uuid REFERENCES users(id) ON DELETE CASCADE,  -- personal verdicts
  position_side      text CHECK (position_side IN ('long','short')),
  verdict            text NOT NULL CHECK (verdict IN ('hold','fold')),
  bias               text NOT NULL CHECK (bias IN ('bullish','bearish','neutral')),
  risk_level         text NOT NULL CHECK (risk_level IN ('low','moderate','elevated','high')),
  vol_regime         text NOT NULL CHECK (vol_regime IN ('calm','normal','elevated','extreme')),
  readings           jsonb NOT NULL,     -- exact indicator readings used
  invalidation_price numeric(18,6),
  rationale_md       text,
  engine_version     text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'global' AND user_id IS NULL) OR (scope = 'user' AND user_id IS NOT NULL))
);
CREATE UNIQUE INDEX hold_fold_global_uq ON hold_fold_verdicts (ticker, as_of_date, engine_version)
  WHERE scope = 'global';
CREATE UNIQUE INDEX hold_fold_user_uq ON hold_fold_verdicts (user_id, ticker, as_of_date, engine_version)
  WHERE scope = 'user';

CREATE TABLE sector_rotation_snapshots (
  as_of_date  date NOT NULL,
  ticker      text NOT NULL REFERENCES instruments(ticker),
  rs_ratio    numeric(12,6) NOT NULL,
  rs_momentum numeric(12,6) NOT NULL,
  quadrant    text NOT NULL CHECK (quadrant IN ('leading','weakening','lagging','improving')),
  rank        int NOT NULL,
  PRIMARY KEY (as_of_date, ticker)
);

-- =====================================================================
-- 4. User portfolio: holdings, watchlists, health checks
-- =====================================================================
CREATE TABLE holdings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker        text NOT NULL REFERENCES instruments(ticker),
  quantity      numeric(20,6) NOT NULL CHECK (quantity <> 0),   -- negative = short
  cost_basis    numeric(18,6) CHECK (cost_basis IS NULL OR cost_basis > 0),  -- per share
  opened_at     date,
  account_label text NOT NULL DEFAULT 'default',
  source        text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','csv_import','broker_sync')),
  notes         text,           -- user text: always treated as untrusted data in prompts
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, account_label, ticker)
);
CREATE TRIGGER holdings_updated BEFORE UPDATE ON holdings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE watchlists (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE UNIQUE INDEX one_default_watchlist ON watchlists (user_id) WHERE is_default;

CREATE TABLE watchlist_items (
  watchlist_id uuid NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  ticker       text NOT NULL REFERENCES instruments(ticker),
  position     int NOT NULL DEFAULT 0,
  alert_rules  jsonb NOT NULL DEFAULT '{}',   -- {"signal_flip":true,"hold_fold_change":true,"quadrant_change":false}
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (watchlist_id, ticker)
);

CREATE TABLE user_alerts (                    -- generated after signals_pipeline
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker     text NOT NULL REFERENCES instruments(ticker),
  as_of_date date NOT NULL,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ticker, as_of_date, kind)
);

CREATE TABLE portfolio_health_checks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  as_of_date     date NOT NULL,
  trigger        text NOT NULL CHECK (trigger IN ('scheduled','on_demand')),
  status         text NOT NULL CHECK (status IN ('queued','running','done','failed')),
  holdings_hash  text NOT NULL,       -- skip recompute when unchanged on the same data date
  metrics        jsonb,               -- weights, HHI, sector/factor tilts, beta, vol
  findings       jsonb,               -- [{severity, code, message, evidence_refs}]
  summary_md     text,                -- LLM narrative grounded in metrics/findings
  model          text,
  prompt_version text,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  UNIQUE (user_id, as_of_date, holdings_hash)
);

-- =====================================================================
-- 5. AI Council
-- =====================================================================
CREATE TABLE council_members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,           -- 'seat_1' .. 'seat_6'
  display_name    text NOT NULL,
  role            text NOT NULL CHECK (role IN ('analyst','devils_advocate')),
  strategy_key    text NOT NULL,                  -- registry key (placeholder until implemented)
  strategy_config jsonb NOT NULL DEFAULT '{}',    -- opaque to the framework
  model           text NOT NULL,
  vote_weight     numeric(6,3) NOT NULL DEFAULT 1.0 CHECK (vote_weight > 0),
  active          boolean NOT NULL DEFAULT true,
  config_version  text NOT NULL,                  -- hash of the YAML seat entry
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- Exactly one active devil's advocate at most (seed enforces "at least one").
CREATE UNIQUE INDEX one_active_devils_advocate ON council_members (role)
  WHERE role = 'devils_advocate' AND active;

CREATE TABLE council_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cadence          text NOT NULL CHECK (cadence IN ('daily','weekly','on_demand')),
  as_of_date       date NOT NULL,                 -- market data cutoff (no look-ahead)
  subject_ticker   text NOT NULL REFERENCES instruments(ticker),
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL for scheduled
  trades_portfolios boolean NOT NULL,             -- true only for scheduled sessions
  status           text NOT NULL CHECK (status IN
                     ('queued','running','consensus','no_consensus','failed','canceled')),
  max_rounds       int NOT NULL,
  rounds_run       int NOT NULL DEFAULT 0,
  config_snapshot  jsonb NOT NULL,                -- council settings + seat config_versions
  context_snapshot jsonb,                         -- exact data shown to seats
  modal_call_id    text,
  idempotency_key  text NOT NULL UNIQUE,          -- 'sched:{cadence}:{as_of}:{ticker}' or 'user:{id}:{key}'
  token_budget     int NOT NULL,
  tokens_used      int NOT NULL DEFAULT 0,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  heartbeat_at     timestamptz,
  finished_at      timestamptz
);
CREATE INDEX council_sessions_date_idx ON council_sessions (as_of_date, cadence);
CREATE INDEX council_sessions_user_idx ON council_sessions (requested_by, created_at DESC);

CREATE TABLE council_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  seq           int NOT NULL,                     -- monotonic per session (SSE de-dupe)
  round         int NOT NULL,
  member_id     uuid REFERENCES council_members(id),  -- NULL for moderator/system
  kind          text NOT NULL CHECK (kind IN
                  ('proposal','critique','challenge','response','revision','moderator','system')),
  content_md    text NOT NULL,
  structured    jsonb NOT NULL DEFAULT '{}',      -- parsed Proposal fields etc.
  input_tokens  int,
  output_tokens int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE TABLE council_votes (
  session_id         uuid NOT NULL REFERENCES council_sessions(id) ON DELETE CASCADE,
  round              int NOT NULL,
  member_id          uuid NOT NULL REFERENCES council_members(id),
  direction          text NOT NULL CHECK (direction IN ('long','short','flat')),
  conviction         numeric(4,3) NOT NULL CHECK (conviction BETWEEN 0 AND 1),
  invalidation_price numeric(18,6),
  counted            boolean NOT NULL,            -- false for roles excluded from the tally
  coerced            boolean NOT NULL DEFAULT false,  -- invalid proposal coerced to flat
  PRIMARY KEY (session_id, round, member_id)
);

CREATE TABLE council_consensus (
  session_id         uuid PRIMARY KEY REFERENCES council_sessions(id) ON DELETE CASCADE,
  outcome            text NOT NULL CHECK (outcome IN ('consensus','no_consensus')),
  direction          text CHECK (direction IN ('long','short','flat')),
  conviction         numeric(4,3),
  invalidation_price numeric(18,6),
  reference_price    numeric(18,6) NOT NULL,      -- close at as_of_date
  agreement_ratio    numeric(4,3) NOT NULL,
  final_round        int NOT NULL,
  summary_md         text,
  dissent_summary_md text,                        -- devil's advocate + minority case
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (
    outcome = 'no_consensus'
    OR direction = 'flat'
    OR (direction IN ('long','short') AND invalidation_price IS NOT NULL)
  )
);

-- =====================================================================
-- 6. Paper trading
-- =====================================================================
CREATE TABLE paper_portfolios (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type     text NOT NULL CHECK (owner_type IN ('council','member')),
  member_id      uuid REFERENCES council_members(id),
  cadence        text NOT NULL CHECK (cadence IN ('daily','weekly')),
  name           text NOT NULL UNIQUE,
  base_currency  text NOT NULL DEFAULT 'USD',
  starting_cash  numeric(18,2) NOT NULL CHECK (starting_cash > 0),
  cash           numeric(18,2) NOT NULL,
  rules          jsonb NOT NULL,                  -- sizing/risk/fill rules (Section 11.1)
  inception_date date NOT NULL,
  peak_equity    numeric(18,2) NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','halted','archived')),
  is_backtest    boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'member') = (member_id IS NOT NULL))
);
CREATE UNIQUE INDEX paper_member_cadence_uq ON paper_portfolios (member_id, cadence)
  WHERE owner_type = 'member' AND NOT is_backtest AND status <> 'archived';
CREATE UNIQUE INDEX paper_council_cadence_uq ON paper_portfolios (cadence)
  WHERE owner_type = 'council' AND NOT is_backtest AND status <> 'archived';

CREATE TABLE paper_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id    uuid NOT NULL REFERENCES paper_portfolios(id),
  session_id      uuid REFERENCES council_sessions(id),
  ticker          text NOT NULL REFERENCES instruments(ticker),
  side            text NOT NULL CHECK (side IN ('buy','sell','sell_short','buy_to_cover')),
  quantity        numeric(20,6) NOT NULL CHECK (quantity > 0),
  order_type      text NOT NULL CHECK (order_type IN ('market_on_open','market_on_close')),
  intent          text NOT NULL CHECK (intent IN ('open','increase','reduce','close','stop_exit','rebalance')),
  decision_date   date NOT NULL,                  -- data cutoff when created
  target_session  date NOT NULL,                  -- session whose open/close fills it
  expires_session date NOT NULL,
  invalidation_price numeric(18,6),               -- carried onto the position when opening
  status          text NOT NULL CHECK (status IN ('pending','filled','canceled','rejected','expired')),
  reason          text,                           -- rejection / expiry reason
  idempotency_key text NOT NULL UNIQUE,           -- '{portfolio}:{decision_date}:{ticker}:{intent}'
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (target_session > decision_date)          -- structural no-look-ahead guarantee
);
CREATE INDEX paper_orders_pending_idx ON paper_orders (target_session, order_type) WHERE status = 'pending';

CREATE TABLE paper_fills (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL UNIQUE REFERENCES paper_orders(id),  -- exactly one fill per order
  portfolio_id    uuid NOT NULL REFERENCES paper_portfolios(id),
  ticker          text NOT NULL,
  side            text NOT NULL,
  quantity        numeric(20,6) NOT NULL,
  reference_price numeric(18,6) NOT NULL,         -- official open or close
  fill_price      numeric(18,6) NOT NULL,         -- after slippage + half spread
  slippage_bps    numeric(8,3) NOT NULL,
  commission      numeric(18,2) NOT NULL DEFAULT 0,
  session_date    date NOT NULL,
  price_source    text NOT NULL,                  -- provider + field
  filled_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paper_fills_portfolio_idx ON paper_fills (portfolio_id, session_date);

CREATE TABLE paper_positions (
  portfolio_id       uuid NOT NULL REFERENCES paper_portfolios(id),
  ticker             text NOT NULL REFERENCES instruments(ticker),
  quantity           numeric(20,6) NOT NULL CHECK (quantity <> 0),  -- negative = short
  avg_cost           numeric(18,6) NOT NULL,
  invalidation_price numeric(18,6),               -- stop level
  opened_session     date NOT NULL,
  last_session_id    uuid REFERENCES council_sessions(id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, ticker)
);

CREATE TABLE paper_cash_ledger (                  -- dividends, adjustments, audit of cash
  id           bigserial PRIMARY KEY,
  portfolio_id uuid NOT NULL REFERENCES paper_portfolios(id),
  session_date date NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('fill','dividend','commission','adjustment')),
  amount       numeric(18,2) NOT NULL,
  ref          text NOT NULL,                     -- fill id / corporate action key
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, kind, ref)
);

CREATE TABLE paper_equity_snapshots (
  portfolio_id    uuid NOT NULL REFERENCES paper_portfolios(id),
  session_date    date NOT NULL,
  cash            numeric(18,2) NOT NULL,
  long_value      numeric(18,2) NOT NULL,
  short_value     numeric(18,2) NOT NULL,         -- positive number = liability
  equity          numeric(18,2) NOT NULL,
  gross_exposure  numeric(8,4) NOT NULL,          -- fraction of equity
  net_exposure    numeric(8,4) NOT NULL,
  daily_return    numeric(12,8),
  cum_return      numeric(12,8),
  drawdown        numeric(12,8),
  benchmark_close numeric(18,6),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, session_date)
);

-- =====================================================================
-- 7. Followed Tickers (monthly frozen calls)
-- =====================================================================
CREATE TABLE followed_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_month       date NOT NULL UNIQUE CHECK (extract(day FROM batch_month) = 1),
  freeze_session    date NOT NULL,                -- first trading day of month
  source_signal_run uuid NOT NULL REFERENCES signal_runs(id),
  selection_rules   jsonb NOT NULL,               -- universe, ranking, tie-breaks, entry rule
  frozen_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE followed_calls (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL REFERENCES followed_batches(id),
  side               text NOT NULL CHECK (side IN ('bull','bear')),
  rank               int NOT NULL CHECK (rank BETWEEN 1 AND 10),
  ticker             text NOT NULL REFERENCES instruments(ticker),
  signal_id          uuid NOT NULL REFERENCES signals(id),
  conviction         numeric(6,3) NOT NULL,
  entry_session      date NOT NULL,
  entry_price        numeric(18,6) NOT NULL,      -- adjusted reference price per selection_rules
  invalidation_price numeric(18,6),
  reasoning_md       text NOT NULL,               -- frozen copy, never edited
  fired_indicators   jsonb NOT NULL,              -- frozen copy
  reasoning_sha256   text NOT NULL,               -- tamper evidence
  frozen_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (batch_id, side, rank),
  UNIQUE (batch_id, ticker)                       -- a ticker can't be both bull and bear
);

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is immutable once frozen', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER followed_calls_immutable BEFORE UPDATE OR DELETE ON followed_calls
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER followed_batches_immutable BEFORE UPDATE OR DELETE ON followed_batches
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE followed_horizon_scores (
  call_id                 uuid NOT NULL REFERENCES followed_calls(id),
  horizon                 text NOT NULL CHECK (horizon IN ('1w','2w','1m','2m','3m','6m','12m')),
  horizon_sessions        int NOT NULL,           -- 5,10,21,42,63,126,252
  target_session          date NOT NULL,          -- resolved from trading_calendar at freeze
  status                  text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','scored','void')),
  exit_price              numeric(18,6),
  raw_return              numeric(12,8),
  directional_return      numeric(12,8),          -- sign-flipped for bear calls
  benchmark_return        numeric(12,8),
  excess_return           numeric(12,8),
  hit                     boolean,
  invalidated_before_target boolean,
  max_adverse_excursion   numeric(12,8),
  max_favorable_excursion numeric(12,8),
  scored_at               timestamptz,
  void_reason             text,
  PRIMARY KEY (call_id, horizon)
);
CREATE INDEX followed_scores_due_idx ON followed_horizon_scores (target_session) WHERE status = 'pending';

CREATE TABLE followed_llm_grades (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id        uuid NOT NULL REFERENCES followed_calls(id),
  grade_type     text NOT NULL CHECK (grade_type IN ('ex_ante','ex_post')),
  horizon        text NOT NULL DEFAULT 'none',    -- 'none' for ex_ante
  model          text NOT NULL,
  prompt_version text NOT NULL,
  rubric_scores  jsonb NOT NULL,                  -- {"evidence_use":4,"consistency":3,...}
  overall_score  numeric(5,2) NOT NULL CHECK (overall_score BETWEEN 0 AND 100),
  letter_grade   text NOT NULL CHECK (letter_grade IN ('A','B','C','D','F')),
  rationale_md   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, grade_type, horizon, prompt_version),
  CHECK ((grade_type = 'ex_ante') = (horizon = 'none'))
);

-- =====================================================================
-- 8. Nu AI chat
-- =====================================================================
CREATE TABLE chat_threads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text,
  summary     text,                               -- rolling summary of older turns
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX chat_threads_user_idx ON chat_threads (user_id, updated_at DESC);

CREATE TABLE chat_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     uuid NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content       text NOT NULL,
  tool_calls    jsonb,                            -- [{name, args, result_ref}]
  context_refs  jsonb,                            -- ids of holdings/signals/verdicts used (citations)
  status        text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','error')),
  model         text,
  input_tokens  int,
  output_tokens int,
  cached_tokens int,
  client_msg_id text,                             -- idempotency for user sends
  flagged       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chat_client_msg_uq ON chat_messages (thread_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, created_at);

-- Optional (pgvector): methodology / glossary chunks for concept questions
-- CREATE TABLE knowledge_chunks (
--   id bigserial PRIMARY KEY, doc_slug text NOT NULL, chunk_idx int NOT NULL,
--   content text NOT NULL, embedding vector(1536) NOT NULL, UNIQUE (doc_slug, chunk_idx));
-- Fallback without pgvector: tsvector full-text index on content.

-- =====================================================================
-- 9. Operations: LLM usage, budgets, job runs, audit
-- =====================================================================
CREATE TABLE llm_usage (
  id            bigserial PRIMARY KEY,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  feature       text NOT NULL CHECK (feature IN
                  ('digest','chat','hold_fold','health_check','council','followed_grade','other')),
  ref_id        text,
  provider      text NOT NULL,
  model         text NOT NULL,
  input_tokens  int NOT NULL,
  output_tokens int NOT NULL,
  cached_tokens int NOT NULL DEFAULT 0,
  est_cost_usd  numeric(12,6),                    -- from YOUR configured rate table
  latency_ms    int,
  ok            boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX llm_usage_day_idx ON llm_usage (created_at, feature);
CREATE INDEX llm_usage_user_idx ON llm_usage (user_id, created_at);

CREATE TABLE user_llm_budgets (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_et      date NOT NULL,
  tokens_used int NOT NULL DEFAULT 0,
  requests    int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_et)
);

CREATE TABLE job_runs (
  job_name     text NOT NULL,
  run_key      text NOT NULL,                     -- usually ET session date or ISO week
  status       text NOT NULL CHECK (status IN ('running','succeeded','failed','skipped')),
  attempt      int NOT NULL DEFAULT 1,
  started_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  detail       jsonb NOT NULL DEFAULT '{}',
  error        text,
  PRIMARY KEY (job_name, run_key)
);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,                       -- user id, 'system', 'stripe', 'clerk', 'admin:<id>'
  action     text NOT NULL,
  target     text,
  detail     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- 10. Access view
-- =====================================================================
CREATE VIEW user_access AS
SELECT u.id AS user_id,
       GREATEST(
         (SELECT max(g.ends_at) FROM entitlement_grants g
           WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.starts_at <= now()),
         (SELECT max(s.current_period_end) FROM subscriptions s
           WHERE s.user_id = u.id AND s.status IN ('active','trialing','past_due'))
       ) AS access_until
FROM users u
WHERE u.deleted_at IS NULL;
-- NOTE: stacked future grants (starts_at > now) count once they begin; the API also
-- computes "access_until including queued grants" for display.
