ALTER TABLE session_goals RENAME TO session_goals_old;

CREATE TABLE session_goals (
  session_id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused', 'cancelled')),
  token_budget INTEGER,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  used_time_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

INSERT INTO session_goals (
  session_id,
  goal,
  status,
  token_budget,
  used_tokens,
  used_time_ms,
  created_at,
  updated_at
)
SELECT
  session_id,
  goal,
  status,
  token_budget,
  used_tokens,
  used_time_ms,
  created_at,
  updated_at
FROM session_goals_old;

DROP TABLE session_goals_old;