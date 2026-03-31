-- Add Shipping Expense account (5800) to chart of accounts
INSERT OR IGNORE INTO accounts (code, name, account_type, normal_side, is_system, active)
VALUES ('5800', 'Shipping Expense', 'expense', 'debit', 1, 1);
