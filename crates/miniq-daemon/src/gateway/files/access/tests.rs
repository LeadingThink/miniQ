use super::*;
use crate::gateway::files::{tests::attachment_state, transfer_source};
use tokio::io::AsyncReadExt;

fn input(session: &str, path: &Path) -> FileInput {
    FileInput {
        session_id: session.into(),
        path: path.to_string_lossy().into_owned(),
    }
}

#[tokio::test]
async fn approved_file_uses_the_same_transfer_gate_and_expired_requests_fail() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("report.txt");
    std::fs::write(&file, "synthetic transfer").unwrap();
    let (state, session, other) = attachment_state(project.path());
    let rev = revision(&file.metadata().unwrap()).unwrap();
    let path = file.to_str().unwrap();
    assert!(transfer_source(&state, &session, path, &rev).await.is_err());
    let pending = request(&state, input(&session, &file), "remote:test").unwrap();
    let id = pending["requestId"].as_str().unwrap();
    state
        .file_access
        .lock()
        .unwrap()
        .pending
        .get_mut(id)
        .unwrap()
        .expires = Instant::now();
    assert!(resolve(
        &state,
        Decision {
            session_id: session.clone(),
            request_id: id.into(),
            allow: true
        },
        "remote:test"
    )
    .is_err());
    assert!(transfer_source(&state, &session, path, &rev).await.is_err());
    let pending = request(&state, input(&session, &file), "remote:test").unwrap();
    resolve(
        &state,
        Decision {
            session_id: session.clone(),
            request_id: pending["requestId"].as_str().unwrap().into(),
            allow: true,
        },
        "remote:test",
    )
    .unwrap();
    let (mut opened, _) = transfer_source(&state, &session, path, &rev).await.unwrap();
    let mut bytes = Vec::new();
    opened.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"synthetic transfer");
    assert!(transfer_source(&state, &other, path, &rev).await.is_err());
    // Revoking the existing session allowlist also revokes this file capability.
    state.session_allowlist.lock().unwrap().remove(&session);
    assert!(transfer_source(&state, &session, path, &rev).await.is_err());
}

#[test]
fn confirmation_handles_are_bounded_and_expiry_releases_capacity() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("report.txt");
    std::fs::write(&file, "synthetic").unwrap();
    let (state, session, _) = attachment_state(project.path());
    for _ in 0..MAX_PENDING {
        request(&state, input(&session, &file), "remote:test").unwrap();
    }
    assert!(request(&state, input(&session, &file), "remote:test").is_err());
    {
        let mut access = state.file_access.lock().unwrap();
        assert_eq!(access.pending.len(), MAX_PENDING);
        for pending in access.pending.values_mut() {
            pending.expires = Instant::now();
        }
        access.expire_pending();
        assert!(access.pending.is_empty());
    }
    assert!(request(&state, input(&session, &file), "remote:test").is_ok());
}

#[test]
fn pinned_grants_are_bounded_renewable_and_released_with_session_permissions() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (state, session, _) = attachment_state(project.path());
    let approve = |file: &Path| {
        let pending = request(&state, input(&session, file), "remote:test")?;
        resolve(
            &state,
            Decision {
                session_id: session.clone(),
                request_id: pending["requestId"].as_str().unwrap().into(),
                allow: true,
            },
            "remote:test",
        )
    };
    for number in 0..=MAX_GRANTED {
        let file = outside.path().join(format!("report-{number}.txt"));
        std::fs::write(&file, "synthetic").unwrap();
        if number == MAX_GRANTED {
            assert!(approve(&file).is_err());
        } else {
            approve(&file).unwrap();
        }
    }
    approve(&outside.path().join("report-0.txt")).unwrap();
    assert_eq!(state.file_access.lock().unwrap().granted.len(), MAX_GRANTED);
    assert_eq!(
        state.session_allowlist.lock().unwrap()[&session].len(),
        MAX_GRANTED
    );
    state.session_allowlist.lock().unwrap().remove(&session);
    approve(&outside.path().join(format!("report-{MAX_GRANTED}.txt"))).unwrap();
    assert_eq!(state.file_access.lock().unwrap().granted.len(), 1);
    request(
        &state,
        input(&session, &outside.path().join("report-0.txt")),
        "remote:test",
    )
    .unwrap();
    state.emit(miniq_protocol::Event::SessionApprovalChanged {
        session_id: session.clone(),
        mode: None,
        actor: None,
        previous: None,
        raised: false,
    });
    {
        let access = state.file_access.lock().unwrap();
        assert!(access.pending.is_empty());
        assert!(access.granted.is_empty());
    }
    approve(&outside.path().join("report-0.txt")).unwrap();
    state.emit(miniq_protocol::Event::SessionDeleted {
        session_id: session.clone(),
    });
    assert!(state.file_access.lock().unwrap().granted.is_empty());
}

#[test]
fn changed_content_and_hard_links_cannot_reuse_pending_consent() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let file = outside.path().join("report.txt");
    std::fs::write(&file, "original").unwrap();
    let (state, session, _) = attachment_state(project.path());
    let pending = request(&state, input(&session, &file), "remote:test").unwrap();
    std::fs::write(&file, "changed synthetic report").unwrap();
    assert!(resolve(
        &state,
        Decision {
            session_id: session.clone(),
            request_id: pending["requestId"].as_str().unwrap().into(),
            allow: true
        },
        "remote:test"
    )
    .is_err());
    #[cfg(unix)]
    {
        let alias = outside.path().join("alias.txt");
        std::fs::hard_link(&file, &alias).unwrap();
        assert!(request(&state, input(&session, &alias), "remote:test").is_err());
    }
}
