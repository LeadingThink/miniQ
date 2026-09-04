use super::*;

#[tokio::test]
async fn applies_structured_and_text_patches() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("old.txt"), "one\ntwo\n").unwrap();
    let context = ToolContext::new(dir.path().to_path_buf());
    let updated = ApplyPatchTool
        .execute(
            &context,
            json!({"operation":{"type":"update_file","path":"old.txt","diff":"@@\n one\n-two\n+second\n"}}),
        )
        .await
        .unwrap();
    assert_eq!(updated["status"], "completed");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("old.txt")).unwrap(),
        "one\nsecond\n"
    );

    ApplyPatchTool
        .execute(
            &context,
            json!({"patch":"*** Begin Patch\n*** Add File: new.txt\n+hello\n+world\n*** End Patch"}),
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(dir.path().join("new.txt")).unwrap(),
        "hello\nworld\n"
    );
}

#[tokio::test]
async fn rejects_escaping_and_rolls_back_multi_file_failure() {
    let dir = tempfile::tempdir().unwrap();
    let context = ToolContext::new(dir.path().to_path_buf());
    let risk = ApplyPatchTool.evaluate_risk(
        &context,
        &json!({"operation":{"type":"delete_file","path":"../secret"}}),
    );
    assert_eq!(risk.level, RiskLevel::Blocked);

    std::fs::write(dir.path().join("keep.txt"), "original\n").unwrap();
    let result = ApplyPatchTool
        .execute(
            &context,
            json!({"patch":"*** Begin Patch\n*** Update File: keep.txt\n@@\n-original\n+changed\n*** Update File: missing.txt\n@@\n-nope\n+bad\n*** End Patch"}),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("keep.txt")).unwrap(),
        "original\n"
    );
}

#[tokio::test]
async fn applies_move_sections_before_their_diff_body() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("before.txt"), "old\n").unwrap();
    let context = ToolContext::new(dir.path().to_path_buf());

    ApplyPatchTool
        .execute(
            &context,
            json!({"patch":"*** Begin Patch\n*** Update File: before.txt\n*** Move to: after.txt\n@@\n-old\n+new\n*** End Patch"}),
        )
        .await
        .unwrap();

    assert!(!dir.path().join("before.txt").exists());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("after.txt")).unwrap(),
        "new\n"
    );
}

#[test]
fn structured_move_schema_matches_runtime_operation() {
    let schema = ApplyPatchTool.parameters_schema();
    let operations = schema["properties"]["operation"]["oneOf"]
        .as_array()
        .unwrap();
    let move_operation = operations
        .iter()
        .find(|operation| operation["properties"]["type"]["const"] == "move_file")
        .expect("move_file schema");
    assert_eq!(
        move_operation["required"],
        json!(["type", "path", "new_path", "diff"])
    );

    let parsed = parse_operations(&json!({
        "operation": {
            "type": "move_file",
            "path": "before.txt",
            "new_path": "after.txt",
            "diff": ""
        }
    }))
    .unwrap();
    assert!(matches!(parsed.as_slice(), [PatchOperation::Move { .. }]));
}
