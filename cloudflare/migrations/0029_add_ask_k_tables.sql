-- Ask K (src/ask-k.js): estimated Claude spend and question counts per Eastern day,
-- cached model lists and alert flags, and the per-IP / per-conversation question limits.
-- The worker also creates these if they are missing.
CREATE TABLE IF NOT EXISTS askk_daily (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  questions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS askk_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS askk_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
