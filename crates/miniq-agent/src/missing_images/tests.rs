use super::*;
use miniq_models::ImageDetail;

// A lossless 1×1 PNG keeps filesystem/provider tests self-contained.
pub(crate) const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0,
    0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1,
    39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn image(path: &std::path::Path) -> ChatImage {
    ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".into(),
        detail: ImageDetail::High,
    }
}

#[test]
fn projection_preserves_user_text_archive_and_valid_pixels_then_recovers_restored_files() {
    let directory = tempfile::tempdir().unwrap();
    let present = directory.path().join("present.png");
    let deleted = directory.path().join("微信旧截图.png");
    std::fs::write(&present, PNG).unwrap();
    miniq_models::decode_static_image(PNG).unwrap();
    let mut attachment = ChatMessage::user("按照之前的图片设计，但先回答我的文字问题。");
    attachment.images = vec![image(&present), image(&deleted)];
    let history = vec![attachment, ChatMessage::user("先继续解释方案")];
    let original = serde_json::to_value(&history).unwrap();
    let archive = VisualHistory::from_messages(&history);
    let stored = serde_json::to_value(archive.entries()).unwrap();
    let mut outgoing = history.clone();
    mark_missing_images(&mut outgoing, &archive);
    assert_eq!(outgoing[0].images, vec![image(&present)]);
    assert!(outgoing[0].content.starts_with(&history[0].content));
    assert!(outgoing[0].content.contains("missing_visual_evidence"));
    assert!(outgoing[0].content.contains("img_2"));
    assert!(outgoing[0].content.contains(deleted.to_str().unwrap()));
    assert!(outgoing[0].content.contains("have not been inspected"));
    assert_eq!(outgoing[1].content, history[1].content);
    assert_eq!(serde_json::to_value(&history).unwrap(), original);
    assert_eq!(serde_json::to_value(archive.entries()).unwrap(), stored);

    std::fs::write(&deleted, PNG).unwrap();
    let mut recovered = history.clone();
    mark_missing_images(&mut recovered, &archive);
    assert_eq!(serde_json::to_value(recovered).unwrap(), original);
}

#[test]
fn missing_tool_images_keep_their_structured_output_and_reference() {
    let directory = tempfile::tempdir().unwrap();
    let mut message =
        ChatMessage::tool_result("view-1", r#"{"page":3,"finding":"original finding"}"#);
    message
        .images
        .push(image(&directory.path().join("gone.png")));
    let history = vec![message];
    let archive = VisualHistory::from_messages(&history);
    let mut outgoing = archive.project(&history);
    mark_missing_images(&mut outgoing, &archive);
    let output: Value = serde_json::from_str(&outgoing[0].content).unwrap();
    assert_eq!(output["page"], 3);
    assert_eq!(output["finding"], "original finding");
    assert_eq!(
        output["missing_visual_evidence"][0]["image_reference"],
        "img_1"
    );
    assert!(outgoing[0].images.is_empty());
}

#[test]
fn unsupported_or_unreadable_existing_files_are_not_treated_as_missing() {
    let directory = tempfile::tempdir().unwrap();
    let invalid = directory.path().join("invalid.png");
    let huge = directory.path().join("huge.png");
    std::fs::write(&invalid, b"invalid image").unwrap();
    std::fs::File::create(&huge)
        .unwrap()
        .set_len(21 * 1024 * 1024)
        .unwrap();
    for path in [&invalid, &huge, &directory.path().to_path_buf()] {
        assert!(missing_evidence(&image(path), Some("img_1")).is_none());
        assert!(miniq_models::load_static_image(path).is_err());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let symlink_path = directory.path().join("symlink.png");
        symlink(directory.path().join("absent.png"), &symlink_path).unwrap();
        assert!(missing_evidence(&image(&symlink_path), None).is_none());
        assert!(miniq_models::validate_image_path(&image(&symlink_path)).is_err());
        let private = directory.path().join("private");
        std::fs::create_dir(&private).unwrap();
        let file = private.join("denied.png");
        std::fs::write(&file, PNG).unwrap();
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o000)).unwrap();
        let evidence = missing_evidence(&image(&file), None);
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            evidence.is_none(),
            "permission denial must not become missing evidence"
        );
    }
}
