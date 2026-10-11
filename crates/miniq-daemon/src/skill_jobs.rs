//! Durable background jobs used by skill learning.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use miniq_protocol::{ErrorCode, RpcError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const DEFAULT_DEADLINE_MS: u64 = 120_000;
const MAX_DEADLINE_MS: u64 = 600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SkillJobKind {
    Distill,
    Refine,
    Create,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SkillJobState {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillJob {
    pub id: String,
    pub kind: SkillJobKind,
    pub session_id: String,
    pub state: SkillJobState,
    pub created_at: String,
    pub updated_at: String,
    pub deadline_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedJobs {
    #[serde(default)]
    jobs: Vec<SkillJob>,
}

struct Inner {
    jobs: HashMap<String, SkillJob>,
    cancel: HashMap<String, CancellationToken>,
}

pub(crate) struct SkillJobs {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl SkillJobs {
    pub(crate) fn load(data_dir: &Path) -> Self {
        let path = data_dir.join("skill-jobs.json");
        let mut jobs: HashMap<String, SkillJob> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<PersistedJobs>(&raw).ok())
            .map(|saved| {
                saved
                    .jobs
                    .into_iter()
                    .map(|job| (job.id.clone(), job))
                    .collect()
            })
            .unwrap_or_default();
        // An in-flight model request cannot survive a process restart. Keep
        // the record queryable and terminal rather than reporting a phantom
        // running job forever.
        for job in jobs.values_mut() {
            if job.state == SkillJobState::Running {
                job.state = SkillJobState::Failed;
                job.error = Some("daemon restarted while the skill job was running".into());
                job.updated_at = now();
            }
        }
        let manager = Self {
            path,
            inner: Mutex::new(Inner {
                jobs,
                cancel: HashMap::new(),
            }),
        };
        manager.persist();
        manager
    }

    pub(crate) fn start(
        &self,
        kind: SkillJobKind,
        session_id: String,
        deadline_ms: Option<u64>,
    ) -> Result<(SkillJob, CancellationToken), RpcError> {
        let deadline_ms = deadline_ms.unwrap_or(DEFAULT_DEADLINE_MS);
        if !(1_000..=MAX_DEADLINE_MS).contains(&deadline_ms) {
            return Err(RpcError::new(
                ErrorCode::InvalidParams,
                format!("deadlineMs must be between 1000 and {MAX_DEADLINE_MS}"),
            ));
        }
        let id = miniq_memory::new_id("skill-job");
        let token = CancellationToken::new();
        let job = SkillJob {
            id: id.clone(),
            kind,
            session_id,
            state: SkillJobState::Running,
            created_at: now(),
            updated_at: now(),
            deadline_ms,
            result: None,
            error: None,
        };
        let mut inner = self.inner.lock().unwrap();
        inner.jobs.insert(id.clone(), job.clone());
        inner.cancel.insert(id, token.clone());
        drop(inner);
        self.persist();
        Ok((job, token))
    }

    pub(crate) fn get(&self, id: &str, session_id: Option<&str>) -> Result<SkillJob, RpcError> {
        let inner = self.inner.lock().unwrap();
        let job = inner
            .jobs
            .get(id)
            .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, "skill job was not found"))?;
        check_session(job, session_id)?;
        Ok(job.clone())
    }

    pub(crate) fn list(&self, session_id: Option<&str>) -> Vec<SkillJob> {
        let mut jobs: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .jobs
            .values()
            .filter(|job| session_id.is_none_or(|id| id == job.session_id))
            .cloned()
            .collect();
        jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        jobs
    }

    pub(crate) fn cancel(&self, id: &str, session_id: Option<&str>) -> Result<SkillJob, RpcError> {
        let mut inner = self.inner.lock().unwrap();
        let token = inner.cancel.get(id).cloned();
        let job = inner
            .jobs
            .get_mut(id)
            .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, "skill job was not found"))?;
        check_session(job, session_id)?;
        if job.state == SkillJobState::Running {
            if let Some(token) = token {
                token.cancel();
            }
            job.state = SkillJobState::Cancelled;
            job.error = Some("cancelled by user".into());
            job.updated_at = now();
            let result = job.clone();
            drop(inner);
            self.persist();
            return Ok(result);
        }
        Ok(job.clone())
    }

    pub(crate) fn complete(&self, id: &str, result: Result<Value, String>) {
        let mut inner = self.inner.lock().unwrap();
        let Some(job) = inner.jobs.get_mut(id) else {
            return;
        };
        if job.state != SkillJobState::Running {
            inner.cancel.remove(id);
            return;
        }
        match result {
            Ok(value) => {
                job.state = SkillJobState::Completed;
                job.result = Some(value);
            }
            Err(error) => {
                job.state = SkillJobState::Failed;
                job.error = Some(error);
            }
        }
        job.updated_at = now();
        inner.cancel.remove(id);
        drop(inner);
        self.persist();
    }

    fn persist(&self) {
        let jobs: Vec<_> = self.inner.lock().unwrap().jobs.values().cloned().collect();
        let Some(parent) = self.path.parent() else {
            return;
        };
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Ok(raw) = serde_json::to_vec_pretty(&PersistedJobs { jobs }) {
            if std::fs::write(&tmp, raw).is_ok() {
                let _ = std::fs::rename(tmp, &self.path);
            }
        }
    }
}

fn check_session(job: &SkillJob, session_id: Option<&str>) -> Result<(), RpcError> {
    if session_id.is_some_and(|id| id != job.session_id) {
        return Err(RpcError::new(
            ErrorCode::Unauthorized,
            "skill job belongs to a different session",
        ));
    }
    Ok(())
}

fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    seconds.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_is_session_scoped_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = SkillJobs::load(dir.path());
        let (job, _) = jobs
            .start(SkillJobKind::Distill, "session-a".into(), None)
            .unwrap();
        assert!(jobs.get(&job.id, Some("session-b")).is_err());
        assert_eq!(
            jobs.cancel(&job.id, Some("session-a")).unwrap().state,
            SkillJobState::Cancelled
        );
        assert_eq!(
            jobs.cancel(&job.id, Some("session-a")).unwrap().state,
            SkillJobState::Cancelled
        );
    }

    #[test]
    fn restart_recovers_running_jobs_as_terminal() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = SkillJobs::load(dir.path());
        let (job, _) = jobs
            .start(SkillJobKind::Refine, "session".into(), None)
            .unwrap();
        drop(jobs);
        let restored = SkillJobs::load(dir.path()).get(&job.id, None).unwrap();
        assert_eq!(restored.state, SkillJobState::Failed);
    }
}
