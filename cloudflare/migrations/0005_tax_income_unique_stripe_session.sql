CREATE UNIQUE INDEX IF NOT EXISTS ux_tax_income_stripe_session_id
ON tax_income(stripe_session_id)
WHERE stripe_session_id IS NOT NULL;
