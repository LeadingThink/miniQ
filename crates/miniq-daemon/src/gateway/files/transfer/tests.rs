use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn destination_is_staged_unique_and_abandoned_bytes_are_removed() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, _) = super::super::tests::attachment_state(project.path());
    let mut first = transfer_destination(&state, &session, "report.txt")
        .await
        .unwrap();
    let second = transfer_destination(&state, &session, "report.txt")
        .await
        .unwrap();
    assert_ne!(first.path, second.path);
    let abandoned = second.path.parent().unwrap().to_path_buf();
    drop(second);
    assert!(!abandoned.exists());
    first.file.write_all(b"validated bytes").await.unwrap();
    assert!(!first.path.exists());
    let staging = first.path.parent().unwrap().join(".partial");
    assert!(super::super::describe(
        &state,
        Some(serde_json::json!({"sessionId":session,"path":staging}))
    )
    .await
    .is_err());
    let listing = super::super::list(
        &state,
        Some(serde_json::json!({"sessionId":session,"path":staging.parent().unwrap()})),
    )
    .await
    .unwrap();
    assert!(listing["entries"].as_array().unwrap().is_empty());
    let path = first.finish().await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"validated bytes");
    assert!(!path.parent().unwrap().join(".partial").exists());
}

#[tokio::test]
async fn destination_never_overwrites_and_rejects_unsafe_names() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, _) = super::super::tests::attachment_state(project.path());
    for name in [
        "",
        ".",
        "..",
        "../secret",
        "a/b",
        "a\\b",
        "C:secret",
        "nul.txt",
        "COM1",
        "x.",
        ".partial",
        "x\0y",
    ] {
        assert!(
            transfer_destination(&state, &session, name).await.is_err(),
            "{name:?}"
        );
    }
    assert!(transfer_destination(&state, &session, ".env").await.is_ok());
    assert!(transfer_destination(&state, &session, "..config")
        .await
        .is_ok());
    let destination = transfer_destination(&state, &session, "report.txt")
        .await
        .unwrap();
    let path = destination.path.clone();
    std::fs::write(&path, b"existing").unwrap();
    assert!(destination.finish().await.is_err());
    assert_eq!(std::fs::read(path).unwrap(), b"existing");
    assert!(transfer_destination(&state, "missing", "file.txt")
        .await
        .is_err());
}

#[tokio::test]
async fn source_checks_authority_size_and_revision() {
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (state, session, _) = super::super::tests::attachment_state(project.path());
    let path = project.path().join("source.txt");
    std::fs::write(&path, b"source").unwrap();
    let revision = revision(&path.metadata().unwrap()).unwrap();
    let (mut file, size) = transfer_source(&state, &session, "source.txt", &revision)
        .await
        .unwrap();
    assert_eq!(size, 6);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"source");
    check_transfer_revision(&file, &revision).await.unwrap();
    std::fs::write(&path, b"updated content").unwrap();
    assert!(check_transfer_revision(&file, &revision).await.is_err());
    assert!(transfer_source(&state, &session, "source.txt", &revision)
        .await
        .is_err());
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "secret").unwrap();
    assert!(
        transfer_source(&state, &session, secret.to_str().unwrap(), &revision)
            .await
            .is_err()
    );
    let huge = File::create(&path).unwrap();
    huge.set_len(MAX_TRANSFER_BYTES + 1).unwrap();
    let revision = super::revision(&huge.metadata().unwrap()).unwrap();
    assert!(transfer_source(&state, &session, "source.txt", &revision)
        .await
        .is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinked_inbox_and_replaced_directory_cannot_escape_or_redirect_cleanup() {
    use std::os::unix::fs::symlink;
    let project = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let (state, session, _) = super::super::tests::attachment_state(project.path());
    let inbox = project.path().join("inbox");
    symlink(outside.path(), &inbox).unwrap();
    assert!(transfer_destination(&state, &session, "file.txt")
        .await
        .is_err());
    std::fs::remove_file(&inbox).unwrap();
    let mut destination = transfer_destination(&state, &session, "file.txt")
        .await
        .unwrap();
    let original = destination.path.parent().unwrap().to_path_buf();
    let moved = inbox.join("moved");
    std::fs::rename(&original, &moved).unwrap();
    symlink(outside.path(), &original).unwrap();
    std::fs::write(outside.path().join(".partial"), b"untouched").unwrap();
    destination.file.write_all(b"private").await.unwrap();
    assert!(destination.finish().await.is_err());
    assert_eq!(
        std::fs::read(outside.path().join(".partial")).unwrap(),
        b"untouched"
    );
    assert!(!outside.path().join("file.txt").exists());
    assert!(!moved.join(".partial").exists());
}

#[tokio::test]
async fn oversized_upload_is_not_published() {
    let project = tempfile::tempdir().unwrap();
    let (state, session, _) = super::super::tests::attachment_state(project.path());
    let destination = transfer_destination(&state, &session, "large.bin")
        .await
        .unwrap();
    let path = destination.path.clone();
    destination
        .file
        .set_len(MAX_TRANSFER_BYTES + 1)
        .await
        .unwrap();
    assert!(destination.finish().await.is_err());
    assert!(!path.exists());
    assert!(!path.parent().unwrap().join(".partial").exists());
}

#[cfg(unix)]
#[test]
fn source_open_does_not_follow_replaced_path_components() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), "secret").unwrap();
    symlink(outside.path(), root.path().join("replaced")).unwrap();
    let root = dunce::canonicalize(root.path()).unwrap();
    assert!(anchored::open_file(&root.join("replaced/secret")).is_err());
    symlink(outside.path().join("secret"), root.join("leaf")).unwrap();
    assert!(anchored::open_file(&root.join("leaf")).is_err());
}
