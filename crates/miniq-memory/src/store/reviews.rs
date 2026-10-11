use super::{new_id, now_iso, MemoryError, Result, Store};
use miniq_protocol::{ReviewRun, ReviewStatus};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewSnapshot {
    pub session_id: String,
    pub primary_message_id: String,
    pub user_message_id: String,
    pub user_prompt: String,
    pub answer: String,
    pub tools: Vec<Value>,
    pub diff: Value,
    pub tests: Value,
    pub limitations: Vec<String>,
}

impl Store {
    pub fn create_review(
        &self,
        snapshot: &ReviewSnapshot,
        model: &str,
        key: &str,
    ) -> Result<ReviewRun> {
        let now = now_iso();
        let id = new_id("review");
        let run = ReviewRun {
            id: id.clone(),
            session_id: snapshot.session_id.clone(),
            primary_message_id: snapshot.primary_message_id.clone(),
            model: model.into(),
            status: ReviewStatus::Queued,
            verdict: None,
            findings: vec![],
            limitations: snapshot.limitations.clone(),
            evidence: vec![],
            error: None,
            input_tokens: None,
            output_tokens: None,
            created_at: now.clone(),
            completed_at: None,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT INTO review_runs (id,session_id,primary_message_id,turn_id,model,snapshot_key,snapshot_json,result_json,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,snapshot.session_id,snapshot.primary_message_id,snapshot.user_message_id,model,key,serde_json::to_string(snapshot)?,serde_json::to_string(&run)?,"queued",now])?;
        Ok(run)
    }
    pub fn review_by_key(
        &self,
        session_id: &str,
        message_id: &str,
        model: &str,
        key: &str,
    ) -> Result<Option<ReviewRun>> {
        self.conn.lock().unwrap().query_row("SELECT result_json FROM review_runs WHERE session_id=?1 AND primary_message_id=?2 AND model=?3 AND snapshot_key=?4",params![session_id,message_id,model,key],|r| {let s:String=r.get(0)?; serde_json::from_str(&s).map_err(|e|rusqlite::Error::FromSqlConversionFailure(0,rusqlite::types::Type::Text,Box::new(e)))}).optional().map_err(Into::into)
    }
    pub fn get_review(&self, session_id: &str, id: &str) -> Result<ReviewRun> {
        self.conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT result_json FROM review_runs WHERE session_id=?1 AND id=?2",
                params![session_id, id],
                |r| {
                    let s: String = r.get(0)?;
                    serde_json::from_str(&s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })
                },
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("review {id}")))
    }
    pub fn update_review(&self, run: &ReviewRun) -> Result<()> {
        let status = serde_json::to_value(run.status)?;
        let n = self.conn.lock().unwrap().execute(
            "UPDATE review_runs SET result_json=?3,status=?4 WHERE session_id=?1 AND id=?2",
            params![
                run.session_id,
                run.id,
                serde_json::to_string(run)?,
                status.as_str()
            ],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!("review {}", run.id)));
        }
        Ok(())
    }
    pub fn list_reviews(
        &self,
        session_id: &str,
        message: Option<&str>,
        limit: u32,
        cursor: Option<&str>,
    ) -> Result<(Vec<ReviewRun>, Option<String>)> {
        if !(1..=100).contains(&limit) {
            return Err(MemoryError::InvalidData("limit must be 1..100".into()));
        }
        let conn = self.conn.lock().unwrap();
        let mut st=conn.prepare("SELECT result_json FROM review_runs WHERE session_id=?1 AND (?2 IS NULL OR primary_message_id=?2) AND (?3 IS NULL OR id<?3) ORDER BY id DESC LIMIT ?4")?;
        let rows = st.query_map(params![session_id, message, cursor, limit + 1], |r| {
            r.get::<_, String>(0)
        })?;
        let mut out: Vec<ReviewRun> = rows
            .map(|r| Ok(serde_json::from_str(&r?)?))
            .collect::<Result<_>>()?;
        let next = if out.len() > limit as usize {
            out.pop();
            out.last().map(|r| r.id.clone())
        } else {
            None
        };
        Ok((out, next))
    }
    pub fn mark_reviews_interrupted(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_iso();
        let mut st = conn
            .prepare("SELECT result_json FROM review_runs WHERE status IN ('queued','running')")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let runs: Vec<String> = rows.collect::<std::result::Result<_, _>>()?;
        drop(st);
        for s in runs {
            let mut r: ReviewRun = serde_json::from_str(&s)?;
            r.status = ReviewStatus::Failed;
            r.error = Some("interrupted: daemon restarted".into());
            r.completed_at = Some(now.clone());
            conn.execute(
                "UPDATE review_runs SET result_json=?2,status='failed' WHERE id=?1",
                params![r.id, serde_json::to_string(&r)?],
            )?;
        }
        Ok(())
    }
}

impl Store {
    /// Read only this durable turn under the connection lock, never clone history.
    pub fn review_turn_snapshot(
        &self,
        session_id: &str,
        message_id: &str,
    ) -> Result<ReviewSnapshot> {
        let conn = self.conn.lock().unwrap();
        let primary: (i64, String, String, String) = conn.query_row(
            "SELECT rowid,content,created_at,attachments_json FROM messages WHERE session_id=?1 AND id=?2 AND role='assistant'",
            params![session_id,message_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||MemoryError::InvalidData("primaryMessageId must be a durable assistant message in this session".into()))?;
        let user: (i64,String,String,String,String) = conn.query_row(
            "SELECT rowid,id,content,created_at,attachments_json FROM messages WHERE session_id=?1 AND role='user' AND rowid<?2 ORDER BY rowid DESC LIMIT 1",
            params![session_id,primary.0], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).optional()?.ok_or_else(||MemoryError::InvalidData("primary answer has no preceding user".into()))?;
        let outcome: Option<String> = conn.query_row(
            "SELECT json_extract(payload_json,'$.status') FROM audit_events WHERE session_id=?1 AND event_type='turn_outcome' AND json_extract(payload_json,'$.anchorMessageId')=?2 ORDER BY rowid DESC LIMIT 1",
            params![session_id,user.1],|r|r.get(0)).optional()?;
        if outcome.as_deref() != Some("completed") {
            return Err(MemoryError::InvalidData(
                "primary turn has not completed successfully".into(),
            ));
        }
        let later:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=?1 AND rowid>?2 AND role='assistant' AND rowid<COALESCE((SELECT MIN(rowid) FROM messages WHERE session_id=?1 AND role='user' AND rowid>?2),9223372036854775807))",params![session_id,primary.0],|r|r.get(0))?;
        if later {
            return Err(MemoryError::InvalidData(
                "primaryMessageId must be the final assistant answer of the turn".into(),
            ));
        }
        let mut st=conn.prepare("SELECT id,tool_name,status,output_json FROM tool_calls WHERE session_id=?1 AND agent_id IS NULL AND created_at>=?2 AND created_at<=?3 ORDER BY created_at,id")?;
        let mut rows = st.query(params![session_id, user.3, primary.2])?;
        let mut tools = vec![];
        let mut tests = vec![];
        while let Some(r) = rows.next()? {
            let id: String = r.get(0)?;
            let name: String = r.get(1)?;
            let status: String = r.get(2)?;
            let raw: Option<String> = r.get(3)?;
            let value: Value = raw
                .map(|s| serde_json::from_str(&s))
                .transpose()?
                .unwrap_or(Value::Null);
            // Only execution status and exit codes are safe by construction. Arbitrary stdout,
            // arguments and external tool output may contain credentials or instructions.
            let exit = exit_codes(&value);
            let tool = serde_json::json!({"id":id,"name":name,"status":status,"safeOutput":{"exitCodes":exit}});
            if name == "shell_run" || name == "shell_batch" {
                tests.push(tool.clone());
            }
            tools.push(tool);
        }
        let mut limitations=vec!["Only this user turn is reviewed; earlier conversation constraints are not available.".into(),"Tool inputs and arbitrary output text are excluded for credential safety; shell evidence includes recorded exit codes, without independently rerunning tests.".into(),"No tools or visual attachments are available to the reviewer.".into()];
        if user.4 != "[]" || primary.3 != "[]" {
            limitations.push("This turn includes attachments; their pixels/files were not inspected by the reviewer.".into());
        }
        Ok(ReviewSnapshot {
            session_id: session_id.into(),
            primary_message_id: message_id.into(),
            user_message_id: user.1,
            user_prompt: user.2,
            answer: primary.1,
            tools,
            diff: Value::Null,
            tests: Value::Array(tests),
            limitations,
        })
    }
    pub fn review_snapshot(&self, session_id: &str, id: &str) -> Result<ReviewSnapshot> {
        let raw: String = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT snapshot_json FROM review_runs WHERE session_id=?1 AND id=?2",
                params![session_id, id],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| MemoryError::NotFound(format!("review {id}")))?;
        Ok(serde_json::from_str(&raw)?)
    }
}
fn exit_codes(value: &Value) -> Vec<Value> {
    let mut codes = vec![];
    if let Some(v) = value.get("exitCode").or_else(|| value.get("exit_code")) {
        codes.push(v.clone());
    }
    if let Some(v) = value.get("outcome") {
        codes.extend(exit_codes(v));
    }
    if let Some(v) = value.get("output").and_then(Value::as_array) {
        for item in v {
            codes.extend(exit_codes(item));
        }
    }
    codes
}
impl Store {
    pub fn last_user_message(&self, session_id: &str) -> Result<Option<miniq_protocol::Message>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT id,session_id,role,content,attachments_json,created_at,steered FROM messages WHERE session_id=?1 AND role='user' ORDER BY rowid DESC LIMIT 1",params![session_id],super::row_mappers::row_to_message).optional().map_err(Into::into)
    }
    pub fn validate_review_message_filter(&self, session_id: &str, id: &str) -> Result<()> {
        let exists:bool=self.conn.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM messages WHERE id=?1 AND session_id=?2) OR EXISTS(SELECT 1 FROM review_runs WHERE primary_message_id=?1 AND session_id=?2)",params![id,session_id],|r|r.get(0))?;
        if !exists {
            return Err(MemoryError::NotFound(format!("message {id}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(session: &str) -> ReviewSnapshot {
        ReviewSnapshot {
            session_id: session.into(),
            primary_message_id: "assistant".into(),
            user_message_id: "user".into(),
            user_prompt: "constraint".into(),
            answer: "answer".into(),
            tools: vec![],
            diff: Value::Null,
            tests: Value::Null,
            limitations: vec![],
        }
    }
    #[test]
    fn review_runs_are_session_scoped_idempotent_and_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("reviews.sqlite");
        let store = Store::open(&path).unwrap();
        let ws = store.create_workspace("/tmp/review", "review").unwrap();
        let session = store.create_session(&ws.id, "review").unwrap();
        let s = snapshot(&session.id);
        let one = store.create_review(&s, "reviewer", "stable").unwrap();
        assert_eq!(
            store
                .review_by_key(&session.id, "assistant", "reviewer", "stable")
                .unwrap()
                .unwrap()
                .id,
            one.id
        );
        drop(store);
        let reopened = Store::open(&path).unwrap();
        assert_eq!(
            reopened.get_review(&session.id, &one.id).unwrap().model,
            "reviewer"
        );
        let other_ws = reopened
            .create_workspace("/tmp/review-other", "other")
            .unwrap();
        let other = reopened.create_session(&other_ws.id, "other").unwrap();
        assert!(reopened.get_review(&other.id, &one.id).is_err());
    }
}
