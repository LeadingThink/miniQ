//! Admission and idle shutdown share one lock, including work between turns.

use std::sync::{Arc, Mutex};

use miniq_protocol::{ErrorCode, RpcError};

#[derive(Default)]
struct State {
    active: usize,
    closing: bool,
}

#[derive(Clone, Default)]
pub(crate) struct ActivityGate(Arc<Mutex<State>>);

pub(crate) struct ActivityGuard(ActivityGate);

impl ActivityGate {
    pub(crate) fn enter(&self) -> Result<ActivityGuard, RpcError> {
        let mut state = self.0.lock().unwrap();
        if state.closing {
            return Err(RpcError::new(
                ErrorCode::SessionBusy,
                "daemon is closing for an update; no new work was accepted",
            ));
        }
        state.active += 1;
        Ok(ActivityGuard(self.clone()))
    }

    pub(crate) fn close_if_idle(
        &self,
        validate: impl FnOnce() -> Result<(), RpcError>,
    ) -> Result<(), RpcError> {
        let mut state = self.0.lock().unwrap();
        if state.active != 0 {
            return Err(RpcError::new(
                ErrorCode::SessionBusy,
                "miniQ still has active tasks or requests; retry the update when idle",
            ));
        }
        validate()?;
        state.closing = true;
        Ok(())
    }

    pub(crate) fn close(&self) {
        self.0.lock().unwrap().closing = true;
    }
}

impl Drop for ActivityGuard {
    fn drop(&mut self) {
        self.0 .0.lock().unwrap().active -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_idle_check_keeps_admission_open() {
        let gate = ActivityGate::default();
        let work = gate.enter().unwrap();
        assert!(gate.close_if_idle(|| Ok(())).is_err());
        drop(work);
        assert!(gate
            .close_if_idle(|| Err(RpcError::new(ErrorCode::InternalError, "storage failed")))
            .is_err());
        assert!(gate.enter().is_ok());
        gate.close_if_idle(|| Ok(())).unwrap();
        assert!(gate.enter().is_err());
    }

    #[test]
    fn admission_cannot_race_successful_idle_shutdown() {
        for _ in 0..100 {
            let gate = ActivityGate::default();
            let other = gate.clone();
            let start = Arc::new(std::sync::Barrier::new(2));
            let barrier = start.clone();
            let worker = std::thread::spawn(move || {
                barrier.wait();
                other.enter()
            });
            start.wait();
            let closed = gate.close_if_idle(|| Ok(()));
            let admitted = worker.join().unwrap();
            assert!(!(closed.is_ok() && admitted.is_ok()));
        }
    }
}
