-- Quotes table for quote management system
CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_number TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  customer_email TEXT,
  valid_until TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  accept_token TEXT UNIQUE,
  deny_token TEXT UNIQUE,
  accepted_at TEXT,
  denied_at TEXT,
  sent_at TEXT,
  converted_invoice_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (converted_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
);

-- Quote line items table
CREATE TABLE IF NOT EXISTS quote_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id INTEGER NOT NULL,
  item_description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_amount_cents INTEGER NOT NULL DEFAULT 0,
  line_total_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (quote_id) REFERENCES quotes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_quotes_valid_until ON quotes(valid_until);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_accept_token ON quotes(accept_token);
CREATE INDEX IF NOT EXISTS idx_quotes_deny_token ON quotes(deny_token);
CREATE INDEX IF NOT EXISTS idx_quote_line_items_quote_id ON quote_line_items(quote_id);
