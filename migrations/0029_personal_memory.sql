ALTER TABLE memories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact';
ALTER TABLE memories ADD COLUMN fact_key TEXT;
ALTER TABLE memories ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown';

CREATE TABLE memory_versions (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, content TEXT NOT NULL, kind TEXT NOT NULL,
  fact_key TEXT, origin TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(memory_id, revision)
);
INSERT INTO memory_versions SELECT id, revision, content, kind, fact_key, origin, updated_at FROM memories;
CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL,
  PRIMARY KEY(memory_id, revision, message_id)
);
CREATE INDEX memory_sources_message ON memory_sources(message_id);
CREATE INDEX memory_scope_kind ON memories(scope,workspace_id,kind,updated_at);
CREATE INDEX memory_scope_key ON memories(scope,workspace_id,fact_key);
CREATE TABLE memory_exclusions (
  scope_key TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY(scope_key, kind, value)
);
CREATE TABLE memory_policy (
  id INTEGER PRIMARY KEY CHECK(id = 1), recall_enabled INTEGER NOT NULL DEFAULT 1,
  auto_save INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
  source_boundary INTEGER NOT NULL DEFAULT 0
);
INSERT INTO memory_policy(id) VALUES (1);
CREATE TABLE memory_session_policy (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL
);
CREATE TABLE memory_jobs (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, ready_at INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0, extractor_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE memory_recalls (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, recalled_at TEXT NOT NULL,
  PRIMARY KEY(session_id, memory_id)
);
CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, terms, tokenize='unicode61');
CREATE TRIGGER memory_delete_index AFTER DELETE ON memories BEGIN
  DELETE FROM memory_fts WHERE memory_id = OLD.id;
END;
CREATE TRIGGER memory_invalidate_context BEFORE DELETE ON memories BEGIN
  DELETE FROM model_context_snapshots WHERE session_id IN (SELECT session_id FROM memory_recalls WHERE memory_id=OLD.id);
  UPDATE memory_policy SET generation=generation+1 WHERE id=1;
END;
-- A deleted/edited source is no longer evidence. Older versions cannot support
-- the current fact. Unknown legacy provenance is intentionally preserved.
CREATE TRIGGER memory_source_removed AFTER DELETE ON memory_sources BEGIN
  DELETE FROM memories WHERE id = OLD.memory_id AND origin != 'unknown'
    AND NOT EXISTS (SELECT 1 FROM memory_sources WHERE memory_id = memories.id AND revision = memories.revision);
END;
CREATE TRIGGER memory_message_changed AFTER UPDATE OF content ON messages
WHEN OLD.content != NEW.content BEGIN
  DELETE FROM memory_sources WHERE message_id = OLD.id;
  DELETE FROM memory_jobs WHERE message_id = OLD.id;
END;
