ALTER TABLE scheduled_tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE scheduled_task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  memory_before TEXT NOT NULL,
  memory_after TEXT,
  task_revision INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
);
CREATE INDEX idx_scheduled_task_runs_task_started
  ON scheduled_task_runs(task_id, started_at DESC, id DESC);
