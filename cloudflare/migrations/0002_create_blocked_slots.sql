CREATE TABLE IF NOT EXISTS blocked_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setup_date TEXT NOT NULL,
  setup_time TEXT NOT NULL,
  setup_at TEXT NOT NULL UNIQUE,
  reason TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_blocked_slots_setup_at_active ON blocked_slots(setup_at, active);
