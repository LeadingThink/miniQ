ALTER TABLE workspaces ADD COLUMN additional_paths_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN working_directory TEXT NOT NULL DEFAULT '';
UPDATE sessions SET working_directory = (SELECT path FROM workspaces WHERE id = workspace_id);
CREATE TRIGGER sessions_default_working_directory AFTER INSERT ON sessions
WHEN NEW.working_directory = ''
BEGIN
    UPDATE sessions SET working_directory = (SELECT path FROM workspaces WHERE id = NEW.workspace_id)
    WHERE id = NEW.id;
END;
