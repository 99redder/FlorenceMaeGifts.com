CREATE TABLE IF NOT EXISTS admin_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('general','year')),
  note_year INTEGER,
  note_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_notes_scope ON admin_notes(scope_type, note_year, created_at DESC);

INSERT INTO admin_notes (scope_type, note_year, note_text)
SELECT 'general', NULL, 'For bookkeeping purposes, Florence Mae Gifts LLC operational cutover date is March 17, 2026. Activity dated March 16, 2026 and earlier remains in sole proprietorship books.'
WHERE NOT EXISTS (
  SELECT 1 FROM admin_notes WHERE scope_type = 'general' AND note_text = 'For bookkeeping purposes, Florence Mae Gifts LLC operational cutover date is March 17, 2026. Activity dated March 16, 2026 and earlier remains in sole proprietorship books.'
);
