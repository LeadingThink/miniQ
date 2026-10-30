use super::*;
mod fixture;
#[cfg(windows)]
mod windows;
use fixture::{command, Fixture};

#[tokio::test]
async fn authenticated_startup_reuses_process_and_stops_gracefully() {
    let fixture = Fixture::new();
    let info = fixture.start("ready").await;
    let process = DaemonProcess::open(info.pid, &info.process_identity)
        .unwrap()
        .unwrap();
    let reused = ensure(
        fixture.path(),
        || panic!("must reuse daemon"),
        Duration::from_secs(2),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(info, reused);
    stop(fixture.path(), Duration::from_secs(2)).await.unwrap();
    assert!(!process.is_running().unwrap());
    assert!(fixture.path().join("graceful").exists());
    process.wait(Duration::ZERO).unwrap();
}

#[tokio::test]
async fn early_exit_reports_status_and_preserves_stderr_without_waiting_for_timeout() {
    let fixture = Fixture::new();
    let started = Instant::now();
    let error = ensure(
        fixture.path(),
        || command("exit"),
        Duration::from_secs(20),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(error.to_string().contains("42"), "{error}");
    let logs: Vec<_> = std::fs::read_dir(fixture.path().join("logs"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(logs.len(), 1);
    assert!(error.to_string().contains(logs[0].to_str().unwrap()));
    assert!(std::fs::read_to_string(&logs[0])
        .unwrap()
        .contains("database unavailable"));
}

#[tokio::test]
async fn shutdown_rpc_failure_still_stops_verified_process() {
    let fixture = Fixture::new();
    let info = fixture.start("shutdown-fails").await;
    let process = DaemonProcess::open(info.pid, &info.process_identity)
        .unwrap()
        .unwrap();
    stop(fixture.path(), Duration::from_millis(50))
        .await
        .unwrap();
    assert!(!process.is_running().unwrap());
    assert!(!fixture.path().join("graceful").exists());
}

#[tokio::test]
async fn stale_pid_record_does_not_stop_unrelated_process_and_can_be_replaced() {
    let fixture = Fixture::new();
    let mut info = ConnectionInfo::current(1, "private".into()).unwrap();
    info.process_identity = crate::process::tests::different(&info.process_identity);
    crate::write_connection_info(fixture.path(), &info).unwrap();
    stop(fixture.path(), Duration::ZERO).await.unwrap();
    let started = fixture.start("ready").await;
    assert_ne!(started.pid, std::process::id());
}

#[tokio::test]
async fn concurrent_startup_spawns_only_one_daemon() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let starts = std::sync::atomic::AtomicUsize::new(0);
    let make = || {
        starts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        command("ready")
    };
    let (a, b) = tokio::join!(
        ensure(fixture.path(), make, Duration::from_secs(10), &cancel),
        ensure(fixture.path(), make, Duration::from_secs(10), &cancel)
    );
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(starts.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[tokio::test]
async fn operation_lock_excludes_another_process() {
    let fixture = Fixture::new();
    let mut launch = launch::Launch::start(fixture.path(), command("lock").unwrap()).unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        while !fixture.path().join("locked").exists() {
            launch.check_exit().unwrap();
            sleep(POLL).await;
        }
    })
    .await
    .unwrap();
    let error = OperationLock::acquire(fixture.path(), Duration::from_millis(50))
        .await
        .err()
        .unwrap();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    launch.cancel().await.unwrap();
    OperationLock::acquire(fixture.path(), Duration::from_secs(1))
        .await
        .unwrap();
}

#[tokio::test]
async fn cancellation_reaps_owned_startup_but_timeout_preserves_existing_daemon() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    let start = ensure(
        fixture.path(),
        || command("unresponsive"),
        Duration::from_secs(20),
        &cancel,
    );
    let observe = async {
        let info = fixture.record().await;
        cancel.cancel();
        info
    };
    let (result, info) = tokio::join!(start, observe);
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::Interrupted);
    assert!(DaemonProcess::open(info.pid, &info.process_identity)
        .unwrap()
        .is_none());

    let _launch = launch::Launch::start(fixture.path(), command("unresponsive").unwrap()).unwrap();
    let next = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let current = fixture.record().await;
            if current.pid != info.pid {
                break current;
            }
            sleep(POLL).await;
        }
    })
    .await
    .unwrap();
    let error = ensure(
        fixture.path(),
        || panic!("existing daemon must be preserved"),
        Duration::from_millis(150),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    assert!(DaemonProcess::open(next.pid, &next.process_identity)
        .unwrap()
        .unwrap()
        .is_running()
        .unwrap());
}

#[tokio::test]
async fn invalid_record_is_replaced_only_when_instance_lock_is_free() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path().join("daemon.json"), b"{}").unwrap();
    let owner = DaemonLock::acquire(fixture.path()).unwrap();
    let error = ensure(
        fixture.path(),
        || panic!("must not launch over unknown owner"),
        Duration::from_secs(1),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    drop(owner);
    fixture.start("ready").await;
}

#[tokio::test]
async fn protocol_mismatch_is_reported_immediately() {
    let fixture = Fixture::new();
    let error = ensure(
        fixture.path(),
        || command("protocol"),
        Duration::from_secs(10),
        &CancellationToken::new(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
}

#[tokio::test]
async fn authentication_failure_is_immediate_and_does_not_expose_token() {
    let fixture = Fixture::new();
    let mut info = fixture.start("ready").await;
    info.token = "private-wrong-token".into();
    let error = probe(&info, Duration::from_secs(2)).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    assert!(!error.to_string().contains(&info.token));
}

#[tokio::test]
async fn http_200_is_not_protocol_readiness() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let info =
        ConnectionInfo::current(listener.local_addr().unwrap().port(), "secret".into()).unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
            .await
            .unwrap();
    });
    assert!(probe(&info, Duration::from_secs(1)).await.is_err());
    server.await.unwrap();
}
