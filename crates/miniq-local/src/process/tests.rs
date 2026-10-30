use super::*;

pub(crate) fn different(identity: &ProcessIdentity) -> ProcessIdentity {
    let mut identity = identity.clone();
    match &mut identity {
        ProcessIdentity::Windows { created_at } => *created_at += 1,
        ProcessIdentity::Linux { start_ticks, .. } => *start_ticks += 1,
        ProcessIdentity::MacOs { unique_id, .. } => *unique_id += 1,
    }
    identity
}

#[test]
fn invalid_pid_is_an_error_and_mismatched_identity_is_stale() {
    let identity = DaemonProcess::current_identity().unwrap();
    for pid in [0, u32::MAX] {
        assert!(DaemonProcess::open(pid, &identity).is_err());
    }
    assert!(
        DaemonProcess::open(std::process::id(), &different(&identity))
            .unwrap()
            .is_none()
    );
    let process = DaemonProcess::open(std::process::id(), &identity)
        .unwrap()
        .unwrap();
    assert!(process.is_running().unwrap());
    assert_eq!(
        process.wait(Duration::ZERO).unwrap_err().kind(),
        io::ErrorKind::TimedOut
    );
}

#[test]
fn connection_records_require_identity_and_redact_tokens() {
    let directory = tempfile::tempdir().unwrap();
    assert!(crate::read_connection_info(directory.path())
        .unwrap()
        .is_none());
    std::fs::write(
        directory.path().join("daemon.json"),
        r#"{"port":1,"token":"private","pid":1}"#,
    )
    .unwrap();
    assert_eq!(
        crate::read_connection_info(directory.path())
            .unwrap_err()
            .kind(),
        io::ErrorKind::InvalidData
    );
    let info = crate::ConnectionInfo::current(1, "private-secret".into()).unwrap();
    assert!(!format!("{info:?}").contains("private-secret"));
    assert_eq!(
        serde_json::from_value::<crate::ConnectionInfo>(serde_json::to_value(&info).unwrap())
            .unwrap(),
        info
    );
}
