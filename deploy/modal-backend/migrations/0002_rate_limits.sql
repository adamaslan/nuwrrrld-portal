-- Section 21.1: per-user / per-IP rate limiting via a Postgres counter table (fixed windows).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       text        NOT NULL,        -- '<action>:<user_id or ip_hash>'
  window_start timestamptz NOT NULL,
  hits         int         NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limits_window_idx ON rate_limits (window_start);
