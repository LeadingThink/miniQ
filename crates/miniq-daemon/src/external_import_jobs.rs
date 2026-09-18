use std::sync::Mutex;

use miniq_protocol::{
    ErrorCode, ExternalImportError, ExternalSessionImportJob, ExternalSessionImportResult,
    ExternalSessionImportState, RpcError,
};

#[derive(Default)]
pub(crate) struct ExternalImportJobs {
    current: Mutex<Option<JobRecord>>,
}

struct JobRecord {
    id: String,
    state: ExternalSessionImportState,
    total_sessions: usize,
    processed_sessions: usize,
    imported_session_ids: Vec<String>,
    imported_messages: usize,
    errors: Vec<ExternalImportError>,
    failure: Option<String>,
}

impl ExternalImportJobs {
    pub(crate) fn start(
        &self,
        total_sessions: usize,
    ) -> Result<ExternalSessionImportJob, RpcError> {
        let mut current = self.current.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|job| job.state == ExternalSessionImportState::Running)
        {
            return Err(RpcError::new(
                ErrorCode::SessionBusy,
                "an external session import is already running",
            ));
        }
        let record = JobRecord {
            id: miniq_memory::new_id("import"),
            state: ExternalSessionImportState::Running,
            total_sessions,
            processed_sessions: 0,
            imported_session_ids: Vec::new(),
            imported_messages: 0,
            errors: Vec::new(),
            failure: None,
        };
        let status = record.status();
        *current = Some(record);
        Ok(status)
    }

    pub(crate) fn status(&self, job_id: &str) -> Result<ExternalSessionImportJob, RpcError> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .filter(|job| job.id == job_id)
            .map(JobRecord::status)
            .ok_or_else(|| {
                RpcError::new(
                    ErrorCode::InvalidParams,
                    "external import job was not found",
                )
            })
    }

    pub(crate) fn record_batch(
        &self,
        job_id: &str,
        processed_sessions: usize,
        imported: Vec<(String, usize)>,
        errors: Vec<ExternalImportError>,
    ) {
        let mut current = self.current.lock().unwrap();
        let Some(job) = current.as_mut().filter(|job| job.id == job_id) else {
            return;
        };
        job.processed_sessions =
            (job.processed_sessions + processed_sessions).min(job.total_sessions);
        for (session_id, message_count) in imported {
            job.imported_session_ids.push(session_id);
            job.imported_messages += message_count;
        }
        job.errors.extend(errors);
    }

    pub(crate) fn complete(&self, job_id: &str) {
        if let Some(job) = self
            .current
            .lock()
            .unwrap()
            .as_mut()
            .filter(|job| job.id == job_id)
        {
            job.state = ExternalSessionImportState::Completed;
        }
    }

    pub(crate) fn fail(&self, job_id: &str, message: String) {
        if let Some(job) = self
            .current
            .lock()
            .unwrap()
            .as_mut()
            .filter(|job| job.id == job_id)
        {
            job.state = ExternalSessionImportState::Failed;
            job.failure = Some(message);
        }
    }
}

impl JobRecord {
    fn status(&self) -> ExternalSessionImportJob {
        let result = (self.state == ExternalSessionImportState::Completed).then(|| {
            ExternalSessionImportResult {
                imported_session_ids: self.imported_session_ids.clone(),
                imported_messages: self.imported_messages,
                errors: self.errors.clone(),
            }
        });
        ExternalSessionImportJob {
            id: self.id.clone(),
            state: self.state,
            total_sessions: self.total_sessions,
            processed_sessions: self.processed_sessions,
            imported_messages: self.imported_messages,
            error_count: self.errors.len(),
            result,
            failure: self.failure.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use miniq_protocol::{ExternalProvider, ExternalSessionImportState};

    use super::*;

    #[test]
    fn tracks_progress_without_exposing_partial_result() {
        let jobs = ExternalImportJobs::default();
        let started = jobs.start(3).unwrap();
        jobs.record_batch(
            &started.id,
            2,
            vec![("session-1".to_owned(), 5)],
            vec![ExternalImportError {
                provider: ExternalProvider::Codex,
                external_id: Some("broken".to_owned()),
                workspace_required: false,
                message: "broken source".to_owned(),
            }],
        );
        let running = jobs.status(&started.id).unwrap();
        assert_eq!(running.processed_sessions, 2);
        assert_eq!(running.imported_messages, 5);
        assert_eq!(running.error_count, 1);
        assert!(running.result.is_none());

        jobs.record_batch(&started.id, 1, vec![("session-2".to_owned(), 3)], vec![]);
        jobs.complete(&started.id);
        let completed = jobs.status(&started.id).unwrap();
        assert_eq!(completed.state, ExternalSessionImportState::Completed);
        assert_eq!(completed.processed_sessions, 3);
        assert_eq!(completed.result.unwrap().imported_session_ids.len(), 2);
    }

    #[test]
    fn permits_only_one_running_import() {
        let jobs = ExternalImportJobs::default();
        let first = jobs.start(1).unwrap();
        assert!(jobs.start(1).is_err());
        jobs.fail(&first.id, "stopped".to_owned());
        assert!(jobs.start(1).is_ok());
    }
}
