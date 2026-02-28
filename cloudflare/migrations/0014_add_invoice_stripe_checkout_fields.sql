ALTER TABLE invoices ADD COLUMN stripe_checkout_session_id TEXT;
ALTER TABLE invoices ADD COLUMN stripe_checkout_url TEXT;
ALTER TABLE invoices ADD COLUMN stripe_payment_status TEXT;
ALTER TABLE invoices ADD COLUMN stripe_payment_link_generated_at TEXT;
ALTER TABLE invoices ADD COLUMN stripe_payment_completed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_invoices_stripe_checkout_session_id ON invoices(stripe_checkout_session_id);
CREATE INDEX IF NOT EXISTS idx_invoices_stripe_payment_status ON invoices(stripe_payment_status);
