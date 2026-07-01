-- Track shipment details for invoices so "Your Item Has Shipped" emails
-- can be sent and the shipped status/tracking is persisted per invoice.
ALTER TABLE invoices ADD COLUMN shipped_at TEXT;
ALTER TABLE invoices ADD COLUMN tracking_carrier TEXT;
ALTER TABLE invoices ADD COLUMN tracking_number TEXT;
ALTER TABLE invoices ADD COLUMN tracking_url TEXT;
