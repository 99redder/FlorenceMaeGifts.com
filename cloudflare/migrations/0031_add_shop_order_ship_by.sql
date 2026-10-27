-- The ship date Megan sets when an order goes into production (Orders tab). When set, it
-- replaces the handling-time estimate in the customer's emails and Ask K's status emails.
-- The worker also adds this column if it is missing.
ALTER TABLE shop_orders ADD COLUMN ship_by TEXT;
