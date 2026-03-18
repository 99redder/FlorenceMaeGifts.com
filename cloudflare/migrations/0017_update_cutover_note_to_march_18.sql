UPDATE admin_notes
SET note_text = 'For bookkeeping purposes, Florence Mae Gifts LLC operational cutover date is March 18, 2026. Activity dated March 17, 2026 and earlier remains in sole proprietorship books.',
    updated_at = datetime('now')
WHERE scope_type = 'general'
  AND note_text = 'For bookkeeping purposes, Florence Mae Gifts LLC operational cutover date is March 17, 2026. Activity dated March 16, 2026 and earlier remains in sole proprietorship books.';

INSERT INTO admin_notes (scope_type, note_year, note_text)
SELECT 'general', NULL, 'For bookkeeping purposes, Florence Mae Gifts LLC operational cutover date is March 18, 2026. Activity dated March 17, 2026 and earlier remains in sole proprietorship books.'
WHERE NOT EXISTS (
  SELECT 1 FROM admin_notes
  WHERE scope_type = 'general'
    AND note_text = 'For bookkeeping purposes, Florence Mae Gifts LLC operational cutover date is March 18, 2026. Activity dated March 17, 2026 and earlier remains in sole proprietorship books.'
);
