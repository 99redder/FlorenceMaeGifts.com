-- Add Marketplace Fees account (5700) to chart of accounts
INSERT OR IGNORE INTO accounts (code, name, account_type, normal_side, is_system, active)
VALUES ('5700', 'Marketplace Fees', 'expense', 'debit', 1, 1);
