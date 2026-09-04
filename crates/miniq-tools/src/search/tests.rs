use super::*;

fn ctx(dir: &std::path::Path) -> ToolContext {
    ToolContext::new(dir.to_path_buf())
}

fn setup(dir: &std::path::Path) {
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() { println!(\"hi\"); }").unwrap();
    std::fs::write(dir.join("src/lib.rs"), "pub fn add() {}").unwrap();
    std::fs::write(
        dir.join("docs/note.md"),
        "TODO: write the report\nplain line",
    )
    .unwrap();
    std::fs::write(dir.join("binary.bin"), [0u8, 159, 146, 150]).unwrap();
}

#[tokio::test]
async fn glob_matches_and_relative_paths() {
    let dir = tempfile::tempdir().unwrap();
    setup(dir.path());
    let out = FileGlobTool
        .execute(&ctx(dir.path()), json!({"pattern": "**/*.rs"}))
        .await
        .unwrap();
    let files: Vec<&str> = out["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file.as_str().unwrap())
        .collect();
    assert_eq!(files.len(), 2);
    assert!(files.contains(&"src/main.rs"));
    assert_eq!(out["truncated"], false);
}

#[tokio::test]
async fn glob_respects_gitignore_and_paginates() {
    let dir = tempfile::tempdir().unwrap();
    setup(dir.path());
    std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(dir.path())
        .output()
        .unwrap();
    std::fs::write(dir.path().join(".gitignore"), "docs/\n").unwrap();
    let ignored = FileGlobTool
        .execute(&ctx(dir.path()), json!({"pattern": "**/*.md"}))
        .await
        .unwrap();
    assert_eq!(ignored["files"].as_array().unwrap().len(), 0);

    let page = FileGlobTool
        .execute(&ctx(dir.path()), json!({"pattern": "**/*.rs", "limit": 1}))
        .await
        .unwrap();
    assert_eq!(page["files"].as_array().unwrap().len(), 1);
    assert_eq!(page["total"], 2);
    assert_eq!(page["nextOffset"], 1);
}

#[tokio::test]
async fn grep_finds_lines_and_skips_binary() {
    let dir = tempfile::tempdir().unwrap();
    setup(dir.path());
    let out = FileGrepTool
        .execute(&ctx(dir.path()), json!({"pattern": "TODO"}))
        .await
        .unwrap();
    let matches = out["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["path"], "docs/note.md");
    assert_eq!(matches[0]["line"], 1);
    assert!(matches[0]["text"].as_str().unwrap().contains("TODO"));
}

#[tokio::test]
async fn grep_case_insensitive_and_glob_filter() {
    let dir = tempfile::tempdir().unwrap();
    setup(dir.path());
    let matched = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({"pattern": "todo", "caseInsensitive": true, "glob": "*.md"}),
        )
        .await
        .unwrap();
    assert_eq!(matched["matches"].as_array().unwrap().len(), 1);

    let missing = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({"pattern": "todo", "caseInsensitive": true, "glob": "*.rs"}),
        )
        .await
        .unwrap();
    assert_eq!(missing["matches"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn grep_paginates_without_losing_full_lines() {
    let dir = tempfile::tempdir().unwrap();
    let long_line = format!("match {}", "x".repeat(700));
    let many = (0..50)
        .map(|index| format!("match line {index}\n"))
        .collect::<String>();
    std::fs::write(dir.path().join("big.txt"), many).unwrap();
    std::fs::write(
        dir.path().join("long.txt"),
        format!("match zero\n{long_line}\nmatch two\n"),
    )
    .unwrap();

    let out = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({"pattern": "match line", "maxResults": 10}),
        )
        .await
        .unwrap();
    assert_eq!(out["matches"].as_array().unwrap().len(), 10);
    assert_eq!(out["total"], 50);
    assert_eq!(out["nextOffset"], 10);

    let page = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({"pattern": "match", "path": "long.txt", "offset": 1, "maxResults": 1}),
        )
        .await
        .unwrap();
    assert_eq!(page["total"], 3);
    assert_eq!(page["matches"][0]["text"], long_line);
}

#[tokio::test]
async fn grep_supports_files_counts_context_and_multiline_matches() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("one.txt"),
        "before\nalpha\nbeta\nalpha\nafter",
    )
    .unwrap();
    std::fs::write(dir.path().join("two.txt"), "alpha").unwrap();

    let files = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({"pattern":"alpha","outputMode":"files_with_matches"}),
        )
        .await
        .unwrap();
    assert_eq!(files["files"].as_array().unwrap().len(), 2);

    let counts = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({"pattern":"alpha","outputMode":"count"}),
        )
        .await
        .unwrap();
    let one = counts["counts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == "one.txt")
        .unwrap();
    assert_eq!(one["count"], 2);

    let multiline = FileGrepTool
        .execute(
            &ctx(dir.path()),
            json!({
                "pattern":"alpha\\nbeta",
                "path":"one.txt",
                "multiline":true,
                "beforeContext":1,
                "afterContext":1
            }),
        )
        .await
        .unwrap();
    assert_eq!(multiline["matches"][0]["line"], 2);
    assert_eq!(multiline["matches"][0]["endLine"], 3);
    assert_eq!(multiline["matches"][0]["before"][0], "before");
    assert_eq!(multiline["matches"][0]["after"][0], "alpha");
}

#[tokio::test]
async fn escape_denied() {
    let dir = tempfile::tempdir().unwrap();
    let risk =
        FileGlobTool.evaluate_risk(&ctx(dir.path()), &json!({"pattern": "*", "path": "../"}));
    assert_eq!(risk.level, RiskLevel::Blocked);
    let error = FileGrepTool
        .execute(&ctx(dir.path()), json!({"pattern": "x", "path": "../"}))
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::SandboxDenied(_)));
}
