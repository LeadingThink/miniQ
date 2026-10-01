use std::sync::Mutex;

use miniq_protocol::{
    ErrorCode, ExternalSessionScan, ExternalSessionScanJob, ExternalSessionScanState, RpcError,
};

#[derive(Default)]
pub(crate) struct ExternalScanJobs {
    current: Mutex<Option<JobRecord>>,
}

struct JobRecord {
    id: String,
    state: ExternalSessionScanState,
    result: Option<ExternalSessionScan>,
    failure: Option<String>,
}

impl ExternalScanJobs {
    pub(crate) fn start(&self) -> Result<ExternalSessionScanJob, RpcError> {
        let mut current = self.current.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|job| job.state == ExternalSessionScanState::Running)
        {
            return Err(RpcError::new(
                ErrorCode::SessionBusy,
                "an external session scan is already running",
            ));
        }
        let record = JobRecord {
            id: miniq_memory::new_id("scan"),
            state: ExternalSessionScanState::Running,
            result: None,
            failure: None,
        };
        let status = record.status();
        *current = Some(record);
        Ok(status)
    }

    pub(crate) fn status(&self, job_id: &str) -> Result<ExternalSessionScanJob, RpcError> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .filter(|job| job.id == job_id)
            .map(JobRecord::status)
            .ok_or_else(|| {
                RpcError::new(ErrorCode::InvalidParams, "external scan job was not found")
            })
    }

    pub(crate) fn complete(&self, job_id: &str, result: ExternalSessionScan) {
        if let Some(job) = self
            .current
            .lock()
            .unwrap()
            .as_mut()
            .filter(|job| job.id == job_id)
        {
            job.state = ExternalSessionScanState::Completed;
            job.result = Some(result);
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
            job.state = ExternalSessionScanState::Failed;
            job.failure = Some(message);
        }
    }
}

impl JobRecord {
    fn status(&self) -> ExternalSessionScanJob {
        ExternalSessionScanJob {
            id: self.id.clone(),
            state: self.state,
            result: self.result.clone(),
            failure: self.failure.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_only_completed_scan_results() {
        let jobs = ExternalScanJobs::default();
        let started = jobs.start().unwrap();
        assert!(jobs.status(&started.id).unwrap().result.is_none());
        jobs.complete(
            &started.id,
            ExternalSessionScan {
                providers: Vec::new(),
                sessions: Vec::new(),
                errors: Vec::new(),
            },
        );
        assert!(jobs.status(&started.id).unwrap().result.is_some());
    }

    #[test]
    fn permits_a_new_scan_after_failure() {
        let jobs = ExternalScanJobs::default();
        let started = jobs.start().unwrap();
        assert!(jobs.start().is_err());
        jobs.fail(&started.id, "failed".to_owned());
        assert!(jobs.start().is_ok());
    }
}
