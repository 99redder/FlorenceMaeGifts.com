-- Site checkout (Stripe) orders, one row per paid checkout, with the order number the buyer
-- gets in their confirmation email. Megan moves each order through status received ->
-- in_production -> shipped -> delivered (or cancelled) in admin (Orders tab), optionally
-- emailing the customer at each step (last_email_status / last_email_at).
-- Ask K's "email me my order status" reads these and the invoices table (src/orders.js).
-- The worker also creates this table if it is missing.
CREATE TABLE IF NOT EXISTS shop_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT NOT NULL UNIQUE,
  customer_email TEXT,
  customer_name TEXT,
  item_name TEXT NOT NULL,
  size_label TEXT,
  price_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  is_digital INTEGER NOT NULL DEFAULT 0,
  order_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  in_production_at TEXT,
  shipped_at TEXT,
  tracking_carrier TEXT,
  tracking_number TEXT,
  tracking_url TEXT,
  delivered_at TEXT,
  confirmation_sent_at TEXT,
  last_email_status TEXT,
  last_email_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shop_orders_email ON shop_orders(customer_email);
CREATE INDEX IF NOT EXISTS idx_shop_orders_order_date ON shop_orders(order_date);
