-- Existing named/imported sessions remain untouched. Only untitled local
-- sessions and newly created default sessions opt into automatic naming.
ALTER TABLE sessions ADD COLUMN title_auto_pending INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET title_auto_pending = 1
WHERE title = 'New session' AND NOT EXISTS (
  SELECT 1 FROM external_session_links WHERE session_id = sessions.id
);
