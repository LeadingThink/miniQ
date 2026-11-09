-- Fingerprints of the model-visible context sections per session.
-- Bodies are not stored: section content lives in the files it is read from.
CREATE TABLE turn_context_snapshots (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  sections_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
