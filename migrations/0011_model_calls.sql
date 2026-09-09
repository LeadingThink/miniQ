CREATE TABLE model_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent_id TEXT,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
    record_json TEXT NOT NULL CHECK (json_valid(record_json))
);
CREATE INDEX idx_model_calls_session_page ON model_calls(session_id, started_at DESC, id DESC);
CREATE INDEX idx_model_calls_agent_page ON model_calls(session_id, agent_id, started_at DESC, id DESC);
