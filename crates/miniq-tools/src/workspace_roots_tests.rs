use super::*;
use serde_json::json;

#[tokio::test]
async fn attached_directory_supports_file_edit_patch_and_paginated_search() {
    let primary = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    let context = ToolContext::new(primary.path().to_path_buf()).with_workspace_roots(vec![
        primary.path().to_path_buf(),
        extra.path().to_path_buf(),
    ]);
    let file = extra.path().join("notes.txt");
    FileWriteTool
        .execute(&context, json!({"path":file,"content":"first\n"}))
        .await
        .unwrap();
    FileWriteTool
        .execute(&context, json!({"path":"local.txt","content":"primary\n"}))
        .await
        .unwrap();
    assert!(primary.path().join("local.txt").exists());
    assert!(!primary.path().join("notes.txt").exists());
    let read = FileReadTool
        .execute(&context, json!({"path":file}))
        .await
        .unwrap();
    assert!(read.to_string().contains("first"));
    FileEditTool
        .execute(
            &context,
            json!({"path":file,"oldString":"first","newString":"second"}),
        )
        .await
        .unwrap();
    let moved = primary.path().join("moved.txt");
    ApplyPatchTool
        .execute(
            &context,
            json!({"operation":{"type":"move_file", "path":file, "new_path":moved, "diff":""}}),
        )
        .await
        .unwrap();
    assert_eq!(std::fs::read_to_string(moved).unwrap(), "second\n");
    assert!(!file.exists());
    FileWriteTool
        .execute(&context, json!({"path":file,"content":"searchable"}))
        .await
        .unwrap();
    let matches = FileGlobTool
        .execute(
            &context,
            json!({"path":extra.path(),"pattern":"*.txt","limit":1}),
        )
        .await
        .unwrap();
    assert_eq!(matches["total"], 1);
    let found = matches["files"][0].as_str().unwrap();
    assert_eq!(std::path::Path::new(found), file.canonicalize().unwrap());
    assert!(FileReadTool
        .execute(&context, json!({"path":found}))
        .await
        .is_ok());
}

#[tokio::test]
async fn unregistered_paths_are_rejected_before_writes() {
    let primary = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let context = ToolContext::new(primary.path().to_path_buf());
    let file = outside.path().join("denied.txt");
    let input = json!({"path":file,"content":"do not write"});
    assert_eq!(
        FileWriteTool.evaluate_risk(&context, &input).level,
        miniq_protocol::RiskLevel::Blocked
    );
    assert!(FileWriteTool.execute(&context, input).await.is_err());
    assert!(!file.exists());
}

#[tokio::test]
async fn attached_repository_can_be_selected_without_changing_default_cwd() {
    let primary = tempfile::tempdir().unwrap();
    let extra = tempfile::tempdir().unwrap();
    let context = ToolContext::new(primary.path().to_path_buf()).with_workspace_roots(vec![
        primary.path().to_path_buf(),
        extra.path().to_path_buf(),
    ]);
    let init = tokio::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(extra.path())
        .output()
        .await
        .unwrap();
    assert!(init.status.success());
    assert!(GitStatusTool
        .execute(&context, json!({"cwd":extra.path()}))
        .await
        .is_ok());
    assert!(GitStatusTool.execute(&context, json!({})).await.is_err());
    #[cfg(unix)]
    {
        let result = ShellRunTool
            .execute(&context, json!({"cwd":extra.path(),"command":"pwd"}))
            .await
            .unwrap();
        assert!(result
            .to_string()
            .contains(extra.path().canonicalize().unwrap().to_str().unwrap()));
    }
}
