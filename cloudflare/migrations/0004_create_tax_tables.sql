CREATE TABLE IF NOT EXISTS tax_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_date TEXT NOT NULL, -- YYYY-MM-DD
  vendor TEXT,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_via TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tax_expenses_date ON tax_expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_tax_expenses_category ON tax_expenses(category);

CREATE TABLE IF NOT EXISTS tax_income (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  income_date TEXT NOT NULL, -- YYYY-MM-DD
  source TEXT,
  category TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tax_income_date ON tax_income(income_date);
CREATE INDEX IF NOT EXISTS idx_tax_income_category ON tax_income(category);
CREATE INDEX IF NOT EXISTS idx_tax_income_stripe_session_id ON tax_income(stripe_session_id);
