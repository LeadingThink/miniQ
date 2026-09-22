ALTER TABLE scheduled_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'newSession' CHECK (mode IN ('newSession', 'heartbeat'));
ALTER TABLE scheduled_tasks ADD COLUMN target_session_id TEXT;
ALTER TABLE scheduled_tasks ADD COLUMN memory TEXT NOT NULL DEFAULT '';
-- 1: a manual dispatch, 2: a scheduled dispatch that must remain enabled.
ALTER TABLE scheduled_tasks ADD COLUMN dispatching INTEGER NOT NULL DEFAULT 0 CHECK (dispatching IN (0, 1, 2));

CREATE INDEX idx_scheduled_tasks_target ON scheduled_tasks(target_session_id);
