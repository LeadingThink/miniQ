CREATE TABLE session_redo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    previous_json TEXT NOT NULL,
    expected_json TEXT NOT NULL,
    files_json TEXT,
    ready INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_session_redo_session ON session_redo(session_id, id);
