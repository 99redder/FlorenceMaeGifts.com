-- Failed admin / emergency sign-ins per IP, so the 5-in-15-minutes lockout holds
-- across Worker instances (it used to live in each instance's memory).
-- The worker also creates this table if it is missing.
CREATE TABLE IF NOT EXISTS admin_auth_failures (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
