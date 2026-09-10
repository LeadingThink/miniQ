CREATE TABLE workspace_model_settings (
    workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL
);