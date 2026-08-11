-- Owner-only retirement contributions are tracked as equity movements rather
-- than operating expenses so Schedule C profit and the P&L remain unchanged.
INSERT OR IGNORE INTO accounts (code, name, account_type, normal_side, is_system, active)
VALUES ('3210', 'Owner Retirement Contributions', 'equity', 'debit', 1, 1);
