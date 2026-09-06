CREATE TABLE session_model_settings (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL
);
ALTER TABLE model_context_snapshots ADD COLUMN model_identity TEXT;
CREATE TABLE session_plans (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    tasks_json TEXT NOT NULL
);
