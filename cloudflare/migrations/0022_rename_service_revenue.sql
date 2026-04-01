-- Rename account 4000 from Service Revenue to Sales Revenue
UPDATE accounts SET name = 'Sales Revenue' WHERE code = '4000';
