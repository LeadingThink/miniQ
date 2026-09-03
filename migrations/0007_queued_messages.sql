-- Queued messages: sent while the session had an active turn; drained in
-- order when the turn ends (or steered to the front to interrupt).
CREATE TABLE queued_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    images_json TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX idx_queued_messages_session ON queued_messages(session_id, position);

-- Archived sessions are hidden from the default sidebar list.
ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
