-- Keep the stable id tie-breaker in the index used by paged history reads.
-- This avoids a temporary SQLite sort for the common session.open query.
CREATE INDEX IF NOT EXISTS idx_messages_session_created_id
    ON messages(session_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session_created_id
    ON tool_calls(session_id, created_at, id);
