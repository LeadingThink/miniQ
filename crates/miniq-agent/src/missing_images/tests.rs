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
fn missing_notice_preserves_reference_and_path_then_clears_after_restoration() {
    let directory = tempfile::tempdir().unwrap();
    let present = directory.path().join("present.png");
    let deleted = directory.path().join("微信旧截图.png");
    std::fs::write(&present, PNG).unwrap();
    miniq_models::decode_static_image(PNG).unwrap();
    let attachment = image(&deleted);
    let original = serde_json::to_value(&attachment).unwrap();
    assert!(missing_evidence(&image(&present), Some("img_1")).is_none());
    let notice = missing_evidence(&attachment, Some("img_2")).unwrap();
    assert_eq!(notice["status"], "missing_visual_evidence");
    assert_eq!(notice["image_reference"], "img_2");
    assert_eq!(notice["image"]["path"], deleted.to_str().unwrap());
    assert!(notice["note"]
        .as_str()
        .unwrap()
        .contains("have not been inspected"));
    assert_eq!(serde_json::to_value(&attachment).unwrap(), original);

    std::fs::write(&deleted, PNG).unwrap();
    assert!(missing_evidence(&attachment, Some("img_2")).is_none());
    assert_eq!(serde_json::to_value(attachment).unwrap(), original);
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
