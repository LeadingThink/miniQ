CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  -- JSON: {"type":"daily","time":"09:00"} | {"type":"weekly","weekday":1,"time":"09:00"}
  --     | {"type":"interval","minutes":30}
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_session_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX idx_scheduled_tasks_due ON scheduled_tasks(enabled, next_run_at);
