CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  state_json TEXT NOT NULL,
  history_json TEXT,
  history_revision INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  UNIQUE(session_id, name)
);
CREATE INDEX idx_agent_tasks_session ON agent_tasks(session_id, created_at, id);

ALTER TABLE tool_calls ADD COLUMN agent_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL;
CREATE INDEX idx_tool_calls_agent ON tool_calls(session_id, agent_id, created_at, id);
