-- Side conversations inherit a parent conversation as model-only context.
-- `inherited = 1` marks rows that exist for the model but never for a client
-- history view. Branch forks keep the default 0 and stay fully visible.
ALTER TABLE messages ADD COLUMN inherited INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_inherited ON messages(session_id, inherited, created_at);

-- Lineage for both durable branches and ephemeral side conversations.
-- No foreign key to the parent: a branch stays independent if the parent is
-- deleted. The row is removed when its own session is deleted.
CREATE TABLE session_forks (
  session_id              TEXT PRIMARY KEY,
  parent_session_id       TEXT NOT NULL,
  anchor_message_id       TEXT NOT NULL,
  mode                    TEXT NOT NULL CHECK (mode IN ('branch', 'side')),
  inherited_message_count INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL
);
CREATE INDEX idx_session_forks_parent ON session_forks(parent_session_id);
CREATE INDEX idx_session_forks_mode ON session_forks(mode);
