CREATE TABLE model_context_snapshots (
  session_id TEXT PRIMARY KEY,
  last_message_id TEXT NOT NULL,
  history_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (last_message_id) REFERENCES messages(id)
);
