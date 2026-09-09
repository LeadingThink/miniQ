use super::{Result, Store};
use miniq_protocol::{ApprovalInboxEntry, ApprovalInboxPage, ApprovalInboxParams, HistoryCursor};
use rusqlite::params;

impl Store {
    pub fn approval_inbox(&self, input: &ApprovalInboxParams) -> Result<ApprovalInboxPage> {
        let conn = self.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT a.id, a.session_id, a.tool_call_id, a.risk_level, a.status,
              a.reason, a.created_at, a.resolved_at, s.title, t.tool_name, t.agent_id
             FROM approvals a JOIN sessions s ON s.id = a.session_id
             JOIN tool_calls t ON t.id = a.tool_call_id AND t.session_id = a.session_id
             WHERE a.status = 'pending' AND (?1 IS NULL OR (a.created_at, a.id) < (?1, ?2))
             ORDER BY a.created_at DESC, a.id DESC LIMIT 21",
        )?;
        let mut entries = statement
            .query_map(
                params![
                    input.before.as_ref().map(|cursor| &cursor.at),
                    input.before.as_ref().map(|cursor| &cursor.id)
                ],
                |row| {
                    Ok(ApprovalInboxEntry {
                        approval: super::row_mappers::row_to_approval(row)?,
                        session_title: row.get(8)?,
                        tool_name: row.get(9)?,
                        agent_id: row.get(10)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let next_cursor = if entries.len() > 20 {
            entries.pop();
            entries.last().map(|entry| HistoryCursor {
                at: entry.approval.created_at.clone(),
                id: entry.approval.id.clone(),
            })
        } else {
            None
        };
        Ok(ApprovalInboxPage {
            entries,
            next_cursor,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniq_protocol::{ApprovalStatus, RiskLevel, ToolCallStatus};
    use serde_json::json;

    #[test]
    fn inbox_is_paginated_without_large_tool_bodies_and_removes_resolved_entries() {
        let store = Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace("/tmp/approval-inbox", "test")
            .unwrap();
        let mut ids = Vec::new();
        for index in 0..25 {
            let session = store
                .create_session(&workspace.id, &format!("session {index}"))
                .unwrap();
            let tool = store
                .create_tool_call(
                    &session.id,
                    "shell_run",
                    &json!({"command":"data".repeat(100000)}),
                    None,
                    ToolCallStatus::WaitingApproval,
                )
                .unwrap();
            ids.push(
                store
                    .create_approval(&session.id, &tool.id, RiskLevel::High, "review first")
                    .unwrap()
                    .id,
            );
        }
        store
            .resolve_approval(&ids[24], ApprovalStatus::Rejected)
            .unwrap();
        let first = store
            .approval_inbox(&ApprovalInboxParams::default())
            .unwrap();
        assert_eq!(first.entries.len(), 20);
        assert!(serde_json::to_vec(&first).unwrap().len() < 16000);
        let second = store
            .approval_inbox(&ApprovalInboxParams {
                before: first.next_cursor,
            })
            .unwrap();
        assert_eq!(second.entries.len(), 4);
        assert!(second.next_cursor.is_none());
        let actual = first
            .entries
            .into_iter()
            .chain(second.entries)
            .map(|entry| entry.approval.id)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(actual.len(), 24);
        assert!(!actual.contains(&ids[24]));
        store.recover_interrupted_work().unwrap();
        assert!(store
            .approval_inbox(&ApprovalInboxParams::default())
            .unwrap()
            .entries
            .is_empty());
    }
}
