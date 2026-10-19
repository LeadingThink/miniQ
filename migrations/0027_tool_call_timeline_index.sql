-- Visible-view history summarises each turn's folded tool calls by status
-- and tool name. `status` and `tool_name` sit beside multi-megabyte payloads,
-- so reading them from the table walks every payload's overflow chain. This
-- covering index answers those counts, and the ordered cursor scans it
-- replaces, from the index alone.
CREATE INDEX IF NOT EXISTS idx_tool_calls_session_timeline
    ON tool_calls(session_id, created_at, id, status, tool_name);

DROP INDEX IF EXISTS idx_tool_calls_session_created_id;
