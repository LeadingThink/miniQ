CREATE TABLE turn_plans (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    anchor_message_id TEXT NOT NULL,
    tasks_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, anchor_message_id)
);

-- Backfill: anchor each existing session plan to the user turn that published
-- its latest plan tool call, so old sessions keep the plan on the right turn.
INSERT OR IGNORE INTO turn_plans (session_id, anchor_message_id, tasks_json, updated_at)
SELECT session_id, anchor_message_id, tasks_json, published_at
FROM (
    SELECT p.session_id,
           p.tasks_json,
           t.published_at,
           (SELECT m.id FROM messages m
             WHERE m.session_id = p.session_id
               AND m.role = 'user'
               AND m.created_at <= t.published_at
             ORDER BY m.created_at DESC, m.rowid DESC
             LIMIT 1) AS anchor_message_id
    FROM session_plans p
    JOIN (
        SELECT session_id, MAX(created_at) AS published_at
        FROM tool_calls
        WHERE tool_name IN ('task_update', 'task_create', 'task_get', 'task_list', 'task_item_update')
          AND status = 'succeeded'
        GROUP BY session_id
    ) t ON t.session_id = p.session_id
)
WHERE anchor_message_id IS NOT NULL;
