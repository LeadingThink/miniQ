-- Startup recovery looks for work left running by the previous process.
-- Without these partial indexes SQLite scans every tool_calls and model_calls
-- row, which delays daemon start by many seconds on large histories. The
-- indexes only hold in-flight rows, so they stay tiny.
CREATE INDEX IF NOT EXISTS idx_tool_calls_active
    ON tool_calls(status)
    WHERE status IN ('pending', 'waiting_approval', 'running');

CREATE INDEX IF NOT EXISTS idx_model_calls_running
    ON model_calls(status)
    WHERE status = 'running';
