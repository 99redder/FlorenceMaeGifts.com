-- Emergency admin access for Megan (admin-emergency.html). One account, the
-- EMERGENCY_ADMIN_EMAIL address; codes are emailed only to that address and
-- stored hashed. The worker also creates these if missing.
CREATE TABLE IF NOT EXISTS admin_emergency_account (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin_emergency_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
