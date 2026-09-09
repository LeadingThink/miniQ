CREATE TABLE session_approval_settings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('alwaysAsk', 'auto', 'fullAccess'))
);
CREATE INDEX idx_audit_execution_page ON audit_events(session_id, created_at, id);
CREATE INDEX idx_approvals_inbox ON approvals(status, created_at, id);
