CREATE TABLE IF NOT EXISTS blocked_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_date TEXT NOT NULL UNIQUE,
  reason TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blocked_days_setup_date_active ON blocked_days(setup_date, active);
