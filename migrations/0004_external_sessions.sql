CREATE TABLE external_session_links (
  session_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude_code', 'opencode')),
  external_id TEXT NOT NULL,
  source_path TEXT NOT NULL,
  continuation_mode TEXT NOT NULL CHECK (
    continuation_mode IN ('native_resumable', 'recreate_only', 'read_only')
  ),
  imported_at TEXT NOT NULL,
  last_synced_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  UNIQUE (provider, external_id)
);

CREATE TABLE external_session_events (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT,
  projected_message_id TEXT,
  PRIMARY KEY (session_id, event_id),
  UNIQUE (session_id, sequence),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (projected_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX idx_external_session_events_sequence
  ON external_session_events(session_id, sequence);

CREATE INDEX idx_external_session_events_projected_message
  ON external_session_events(projected_message_id);
