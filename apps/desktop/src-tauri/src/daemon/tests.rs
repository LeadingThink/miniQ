use super::*;

#[tokio::test]
async fn update_guard_blocks_startup_until_cancelled() {
    let directory = tempfile::tempdir().unwrap();
    let identity = DaemonProcess::current_identity().unwrap();
    let lifecycle = DaemonLifecycle::default();
    *lifecycle.update.lock().await = Some(UpdateGuard {
        operation: OperationLock::acquire(directory.path(), Duration::from_secs(1))
            .await
            .unwrap(),
        process: Arc::new(
            DaemonProcess::open(std::process::id(), &identity)
                .unwrap()
                .unwrap(),
        ),
    });
    assert!(lifecycle.ensure().await.unwrap_err().contains("paused"));
    assert!(lifecycle
        .prepare_update()
        .await
        .unwrap_err()
        .contains("already in progress"));
    lifecycle.cancel_update().await.unwrap();
    assert!(lifecycle.update.lock().await.is_none());
    assert!(OperationLock::acquire(directory.path(), Duration::ZERO)
        .await
        .is_ok());
    assert!(lifecycle
        .wait_for_exit()
        .await
        .unwrap_err()
        .contains("not been prepared"));
    lifecycle.begin_shutdown();
    assert!(lifecycle.ensure().await.unwrap_err().contains("exiting"));
    assert!(lifecycle
        .prepare_update()
        .await
        .unwrap_err()
        .contains("exiting"));
}
