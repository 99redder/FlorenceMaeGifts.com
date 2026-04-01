-- Split generic Payment Processing Fees into platform-specific categories
UPDATE tax_expenses SET category = 'Etsy Processing Fees'    WHERE category = 'Payment Processing Fees' AND (vendor = 'Etsy'    OR paid_via = 'etsy');
UPDATE tax_expenses SET category = 'Mercari Processing Fees' WHERE category = 'Payment Processing Fees' AND (vendor = 'Mercari' OR paid_via = 'mercari');
UPDATE tax_expenses SET category = 'Stripe Processing Fees'  WHERE category = 'Payment Processing Fees' AND (vendor = 'Stripe'  OR paid_via LIKE '%stripe%');
-- Catch any remaining unattributed processing fees as Stripe (shop checkout)
UPDATE tax_expenses SET category = 'Stripe Processing Fees'  WHERE category = 'Payment Processing Fees';
