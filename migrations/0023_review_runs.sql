CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  primary_message_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  snapshot_key TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, primary_message_id, snapshot_key, model)
);
CREATE INDEX idx_review_runs_message ON review_runs(session_id, primary_message_id, created_at, id);
CREATE UNIQUE INDEX idx_review_runs_active ON review_runs(session_id, turn_id)
  WHERE status IN ('queued', 'running');
