-- Deactivate Travel Expense account (never used)
UPDATE accounts SET active = 0 WHERE code = '5500';

-- Rename Office Expense to Supplies Expense
UPDATE accounts SET name = 'Supplies Expense' WHERE code = '5200';
