-- Reclassify existing Advertising/Marketing expenses from Etsy as Etsy Offsite Ads.
-- All current Advertising/Marketing entries came from Etsy Offsite Ads imports,
-- not voluntary marketing spend. Future voluntary marketing should use a new entry.
UPDATE tax_expenses SET category = 'Etsy Offsite Ads' WHERE category = 'Advertising/Marketing' AND (vendor = 'Etsy' OR paid_via = 'etsy');
