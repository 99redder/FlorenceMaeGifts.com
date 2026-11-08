-- Year-end count of finished items Megan has made ahead and set aside to sell later (e.g. the
-- Halloween stock). Their materials (yarn etc.) are booked as expenses when bought; the count
-- moves the cost of the items still unsold into the next year (journal entries with source_type
-- 'inventory_count', source_id = year). One row per year: `year` is the year the count closes.
-- A row is required before that year's Year-End Close, even when nothing is on hand (total 0).
CREATE TABLE IF NOT EXISTS inventory_counts (
  year INTEGER PRIMARY KEY,
  count_date TEXT NOT NULL,      -- day the count was taken, YYYY-MM-DD
  lines_json TEXT NOT NULL,      -- [{ item, qty, unitCents, valueCents, basis }]
  total_cents INTEGER NOT NULL,
  notes TEXT,                    -- e.g. how the materials share was worked out
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
